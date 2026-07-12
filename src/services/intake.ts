// Word intake queue selection (#68) — the pure, foundation-first promotion logic.
//
// Encountering a word no longer grades it on sight. Instead words WAIT in an intake
// queue (unscheduled) until a daily cap promotes the top `cap` of them into active
// FSRS scheduling (src/services/srs.ts). Promotion order is FOUNDATION-FIRST: easiest
// JLPT level first, then most common in normal text — so the common N5/N4 backbone is
// mastered before harder/rarer words ever enter active study.
//
// The queue has two sources (see docs/intake-queue-design-68.md, D1):
//   1. Encountered-queued — words the user bumped into while reading (a local
//      `user_word_progress` row with intake_status='queued').
//   2. Unseen-foundation — important common words at/below the user's level they have
//      NOT read yet, pulled on demand from the get_intake_candidates RPC. Virtual:
//      not stored until promoted, so we never materialise a huge backlog.
//
// This module is intentionally pure (no store/Supabase/clock access) so the ordering
// is unit-testable with a standalone runner, mirroring how srs.ts is tested.

/** A virtual unseen-foundation candidate row from the get_intake_candidates RPC. */
export interface IntakeCandidate {
  entryId: string;
  jlptLevel: number | null;
  freqRank: number | null;
  word: string;
  reading: string;
  meaning: string;
}

/**
 * One word competing for promotion. `key` is the store key of an already-encountered
 * queued record, or null for a virtual unseen-foundation candidate (materialised into
 * a record only if it wins a promotion slot). `candidate` carries the display fields
 * needed to build that record.
 */
export interface IntakeItem {
  key: string | null;
  entryId: string;
  jlptLevel: number | null;
  freqRank: number | null;
  timesSeen: number;
  candidate?: IntakeCandidate;
}

/**
 * Foundation-first promotion order. Mirrors `_shared/wordPriority.ts:compareIntake`
 * (kept as a small local copy rather than imported across the Vite/Deno module
 * boundary, exactly as srs.ts mirrors the SQL seed): easiest JLPT level first (higher
 * number), then most common (lowest freq_rank; nulls last). Unknown level sorts last.
 * Tiebreak: a word the user has actually encountered (higher timesSeen) edges out a
 * never-seen candidate at the same level+frequency.
 */
export function compareIntakeItem(a: IntakeItem, b: IntakeItem): number {
  const la = a.jlptLevel ?? Number.NEGATIVE_INFINITY; // unknown level = hardest, last
  const lb = b.jlptLevel ?? Number.NEGATIVE_INFINITY;
  if (la !== lb) return lb - la; // easier (higher number) first
  const fa = a.freqRank ?? Number.POSITIVE_INFINITY;
  const fb = b.freqRank ?? Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa - fb; // most common (lowest rank) first
  return (b.timesSeen ?? 0) - (a.timesSeen ?? 0); // encountered edges out never-seen
}

/**
 * Choose up to `cap` words to promote this cycle, foundation-first. Merges the two
 * queue sources and de-dupes by entryId — a locally-queued word and an unseen
 * candidate can name the same entry, in which case the local (encountered) record
 * wins so we promote in place instead of creating a duplicate. Returns [] for cap<=0.
 */
export function selectPromotions(
  queued: IntakeItem[],
  candidates: IntakeItem[],
  cap: number,
): IntakeItem[] {
  if (cap <= 0) return [];
  const byId = new Map<string, IntakeItem>();
  for (const item of [...queued, ...candidates]) {
    const existing = byId.get(item.entryId);
    // Prefer a real encountered record (key != null) over a virtual candidate.
    if (!existing || (existing.key == null && item.key != null)) {
      byId.set(item.entryId, item);
    }
  }
  return Array.from(byId.values()).sort(compareIntakeItem).slice(0, cap);
}
