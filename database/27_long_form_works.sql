-- ============================================================
-- 27_long_form_works.sql
-- Long-form content, Phase A (docs/long-form-content-design.md §1):
-- works-and-parts content model for BYOC imports (#38) and magazines (#58).
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor. Idempotent: CREATE TABLE/INDEX
-- IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, guarded constraints, CREATE OR
-- REPLACE FUNCTION.
--
-- ⚠️  APPLY THIS *BEFORE* deploying the Phase A frontend/edge function: the
-- client's feed queries start filtering on processed_news.source_type, which
-- errors until the column exists.
--
-- Model: a WORK is one long-form piece (pasted blog post, magazine feature).
-- It is split into PARTS; each part is a regular processed_news row — the
-- Reader, caching, word tracking and SRS all work on parts with zero changes.
-- Grouping lives in new columns on processed_news. Phase A ships single-part
-- works only (≤10,000 source chars, no chunking).

-- ── The works table: source of truth for a long-form piece ───────────────────
create table if not exists public.long_form_works (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  title text not null,
  source_type text not null check (source_type in ('import', 'magazine')),
  origin_url text,                -- null for pasted text
  raw_text text not null,         -- the unchunked original (needed for JIT part processing)
  char_count int not null,
  part_count int not null,
  continuity jsonb default '{}',  -- rolling summary + proper-noun map (design §4, Phase B)
  reading_position jsonb,         -- { part_index, block_index } (design §5, Phase B)
  status text not null default 'active' check (status in ('active', 'finished', 'archived')),
  created_at timestamptz default now()
);

-- RLS mirrors processed_news: per-user isolation, full manage rights on own rows.
alter table public.long_form_works enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'long_form_works'
      and policyname = 'Users can manage own works'
  ) then
    create policy "Users can manage own works"
      on public.long_form_works for all
      using (auth.uid() = user_id);
  end if;
end $$;

-- Library list query: this user's works, newest first.
create index if not exists idx_long_form_works_user_created
  on public.long_form_works (user_id, created_at desc);

-- ── Part columns on processed_news ───────────────────────────────────────────
-- A part IS an article; these columns only add grouping. Every existing row
-- backfills to source_type='news' via the column default (metadata-only in PG11+).
-- work_id cascades: deleting a work removes its part rows (word progress is
-- keyed separately and is untouched).
alter table public.processed_news
  add column if not exists source_type text not null default 'news',
  add column if not exists work_id uuid references public.long_form_works (id) on delete cascade,
  add column if not exists part_index int;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'processed_news_source_type_check'
  ) then
    alter table public.processed_news
      add constraint processed_news_source_type_check
      check (source_type in ('news', 'import', 'magazine'));
  end if;
end $$;

-- Part lookup for a work (reader open, part-status list). Partial: news rows
-- vastly outnumber parts and never need to be here.
create index if not exists idx_processed_news_work_part
  on public.processed_news (work_id, part_index)
  where work_id is not null;

-- ── Buffer accounting: works never consume the news buffer/cap (design §1) ───
-- ensure_buffer_claim counted ALL processed_news rows, so an imported work
-- would occupy a news-buffer slot and eat the news daily cap. Both counts now
-- filter source_type='news'. Long-form has its own server-side guard in the
-- edge function (3 imports / 15 parts per user per day, design §7). The claim
-- INSERT is unchanged — it creates news rows (source_type defaults 'news').
CREATE OR REPLACE FUNCTION public.ensure_buffer_claim(
  p_user_id         uuid,
  p_candidates      jsonb,            -- [{id text, title text}], in priority order
  p_n               int DEFAULT 2,    -- target buffer depth (N)
  p_m               int DEFAULT 15,   -- hard daily cap (M)
  p_reclaim_minutes int DEFAULT 5     -- stale-pending reclaim window
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reclaimed int  := 0;
  v_buffer    int  := 0;
  v_produced  int  := 0;
  v_deficit   int  := 0;
  v_claimed   jsonb := '[]'::jsonb;
  v_len       int  := COALESCE(jsonb_array_length(p_candidates), 0);
  i           int  := 0;
  v_elem      jsonb;
  v_id        text;
  v_title     text;
BEGIN
  -- Serialize ALL production decisions for this user. Released at txn end, so
  -- concurrent/duplicate triggers (open+read, multi-tab, multi-device) queue
  -- here and each sees the others' claimed `pending` rows → no double-produce.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- Guardrail #4: an orphaned `pending` (producer crashed/killed before flipping
  -- the row ready/failed) would occupy a buffer slot forever and deadlock refills.
  -- Reclaim → failed so the slot frees; it still counts toward the daily cap
  -- (created_at within 24h), so a crash-loop can't run up Gemini cost.
  UPDATE processed_news
     SET status = 'failed'
   WHERE user_id = p_user_id
     AND status = 'pending'
     AND source_type = 'news'
     AND created_at < now() - make_interval(mins => p_reclaim_minutes);
  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;

  -- Guardrail #1: buffer = ready + (fresh) pending. In-flight slots count.
  -- News rows only — a long-form part must never occupy a news-buffer slot.
  SELECT count(*) INTO v_buffer
    FROM processed_news
   WHERE user_id = p_user_id AND status IN ('ready', 'pending')
     AND source_type = 'news';

  -- Guardrail #3: hard daily cap — everything produced in the rolling 24h,
  -- regardless of final status (failed included), so failures can't loop.
  -- News rows only — imports are guarded separately in the edge function.
  SELECT count(*) INTO v_produced
    FROM processed_news
   WHERE user_id = p_user_id AND created_at > now() - interval '24 hours'
     AND source_type = 'news';

  -- Guardrail #2: bounded deficit, computed ONCE. No internal loop.
  v_deficit := least(p_n - v_buffer, p_m - v_produced);

  IF v_deficit > 0 THEN
    -- Claim up to v_deficit candidates we don't already have a row for. The
    -- composite-PK ON CONFLICT skips any story this user already holds in ANY
    -- status (ready/pending/read/dismissed/failed) — so we never re-produce a
    -- story they've seen, dismissed, or failed, and never double-claim.
    WHILE i < v_len AND jsonb_array_length(v_claimed) < v_deficit LOOP
      v_elem  := p_candidates -> i;
      i       := i + 1;
      v_id    := v_elem ->> 'id';
      v_title := v_elem ->> 'title';
      CONTINUE WHEN v_id IS NULL;

      INSERT INTO processed_news (id, user_id, title, status)
      VALUES (v_id, p_user_id, v_title, 'pending')
      ON CONFLICT (user_id, id) DO NOTHING;

      IF FOUND THEN
        v_claimed := v_claimed || jsonb_build_array(
          jsonb_build_object('id', v_id, 'title', v_title)
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'buffer',      v_buffer,
    'produced24h', v_produced,
    'deficit',     greatest(v_deficit, 0),
    'reclaimed',   v_reclaimed,
    'claimed',     v_claimed
  );
END;
$$;

-- ── Verify (run after applying) ──────────────────────────────────────────────
--   -- table + policy present:
--   SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='long_form_works';
--   SELECT policyname FROM pg_policies WHERE tablename='long_form_works';
--
--   -- part columns present:
--   SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='processed_news'
--     AND column_name IN ('source_type','work_id','part_index');
--
--   -- every existing row backfilled to news:
--   SELECT source_type, count(*) FROM public.processed_news GROUP BY source_type;
--
--   -- buffer RPC still healthy (dry run, claims nothing):
--   SELECT public.ensure_buffer_claim(
--     (SELECT user_id FROM processed_news LIMIT 1), '[]'::jsonb
--   );
