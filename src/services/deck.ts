// Flashcard deck selection (#70) — the pure "what do I study now" logic.
//
// The deck draws from two sources (see docs/flashcard-ui-design-70.md, D1):
//   1. Due reviews — active words whose FSRS schedule (#67) has come due
//      (dueAt <= now). Ordered most-overdue first.
//   2. New cards — words just promoted from the intake queue (#68) but never
//      actually studied (promotedTs set, reps still 0). A freshly promoted word
//      is seeded with a FUTURE dueAt, so it would never surface as a "due review"
//      for days; but #68's daily cap IS the Anki-style "new cards today" limit, so
//      a promoted word is meant to be studyable now. Ordered foundation-first.
//
// `reps === 0` means the scheduler has never advanced this word (a read-past or a
// prior flashcard both bump reps), and `promotedTs != null` excludes grandfathered
// known words (the #68 migration set intake_status='active' but left promoted_at
// null), so a returning user's whole back-catalog doesn't land in "new".
//
// Queued words never appear — they aren't scheduled yet.
//
// This module is intentionally pure (no store/Supabase/clock access) so the deck
// ordering is unit-testable with a standalone runner, mirroring intake.ts / srs.ts.

/**
 * The subset of a word's fields the deck cares about. `key` is the wordDatabase
 * key (canonical entry_id post-#39). Everything else mirrors WordData.
 */
export interface DeckEntry {
  key: string;
  jlptLevel: number | null;
  freqRank: number | null;
  dueAt: number | null;
  reps: number | null;
  stability: number | null;
  intakeStatus?: 'queued' | 'active';
  promotedTs: number | null;
}

/** A card in the deck, tagged with which source put it there (drives ordering). */
export interface DeckCard extends DeckEntry {
  kind: 'review' | 'new';
}

/**
 * Active = promoted into FSRS scheduling. An explicit `queued` status always wins
 * (it is unscheduled by definition). A stability-bearing legacy row with NO
 * intake_status is treated as active so grandfathered schedules still surface.
 */
export function isActive(e: DeckEntry): boolean {
  if (e.intakeStatus === 'queued') return false;
  return e.intakeStatus === 'active' || e.stability != null;
}

/** A due review: active and its schedule has come due. */
export function isDue(e: DeckEntry, now: number): boolean {
  return isActive(e) && e.dueAt != null && e.dueAt <= now;
}

/**
 * A new card: promoted from the intake queue (promotedTs set) but never studied
 * (reps still 0). Excludes grandfathered known words (promotedTs null) and words
 * already advanced by reading/flashcards (reps > 0).
 */
export function isNewCard(e: DeckEntry): boolean {
  return isActive(e) && e.promotedTs != null && (e.reps ?? 0) === 0;
}

/**
 * Foundation-first order for NEW cards: easiest JLPT level first (higher number),
 * then most common (lowest freq_rank; nulls last), then a stable key tiebreak.
 * Mirrors intake.ts:compareIntakeItem so intake and the deck agree on "what's
 * foundational".
 */
function compareNew(a: DeckCard, b: DeckCard): number {
  const la = a.jlptLevel ?? Number.NEGATIVE_INFINITY; // unknown level = hardest, last
  const lb = b.jlptLevel ?? Number.NEGATIVE_INFINITY;
  if (la !== lb) return lb - la; // easier (higher number) first
  const fa = a.freqRank ?? Number.POSITIVE_INFINITY;
  const fb = b.freqRank ?? Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa - fb; // most common (lowest rank) first
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Most-overdue-first for DUE reviews; equal due dates fall back to a stable key. */
function compareDue(a: DeckCard, b: DeckCard): number {
  const da = a.dueAt ?? 0;
  const db = b.dueAt ?? 0;
  if (da !== db) return da - db; // earlier due (more overdue) first
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * A word is deck-eligible only if it has a JLPT level. Words with no JLPT rating
 * are the un-enriched long tail (kuromoji-parsed fragments, particles, junk that
 * never resolved to a JMDict entry) — showing them as flashcards is noise. Since
 * foundation-first ordering is JLPT-based anyway, a level-less word has no place
 * in the ordering. (Coarse gate for now; a fuller fix would enrich or prune those
 * rows at the source — see docs/flashcard-ui-design-70.md.)
 */
export function isEligible(e: DeckEntry): boolean {
  return e.jlptLevel != null;
}

/**
 * Build today's ordered deck: all due reviews (most overdue first), then all new
 * cards (foundation-first). A word that is both due AND new counts once, as a
 * review (it's already scheduled and urgent). No session cap — #68 paces new
 * words upstream and hiding genuinely-due reviews would be wrong. Level-less words
 * are excluded (isEligible).
 */
export function selectDeck(entries: DeckEntry[], now: number): DeckCard[] {
  const reviews: DeckCard[] = [];
  const news: DeckCard[] = [];
  for (const e of entries) {
    if (!isEligible(e)) continue;
    if (isDue(e, now)) reviews.push({ ...e, kind: 'review' });
    else if (isNewCard(e)) news.push({ ...e, kind: 'new' });
  }
  reviews.sort(compareDue);
  news.sort(compareNew);
  return [...reviews, ...news];
}
