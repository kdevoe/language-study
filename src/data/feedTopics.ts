// Curated feed-topic catalog (#10). Mirrors the topic ids tagged onto FEED_LIST
// in supabase/functions/fetch-raw-news/index.ts — keep the two in sync when
// adding a topic there. Selection is stored in user_preferences.feed_topics;
// null means "never chosen" and the server falls back to DEFAULT_FEED_TOPICS.
export interface FeedTopic {
  id: string;
  label: string;
  hint: string;
}

export const FEED_TOPICS: FeedTopic[] = [
  { id: 'world',      label: 'World',      hint: 'BBC, NPR, Guardian world desks' },
  { id: 'technology', label: 'Technology', hint: 'The Verge, Ars Technica, Wired, TechCrunch' },
  { id: 'science',    label: 'Science',    hint: 'Guardian and BBC science & environment' },
  { id: 'business',   label: 'Business',   hint: 'BBC and Guardian business desks' },
  { id: 'sports',     label: 'Sports',     hint: 'BBC Sport, Guardian Sport' },
  { id: 'culture',    label: 'Culture',    hint: 'Arts, film, music, entertainment' },
  { id: 'health',     label: 'Health',     hint: 'BBC Health, NPR Health' },
  { id: 'japan',      label: 'Japan',      hint: 'Japan Times, Guardian Japan coverage' },
  { id: 'ai',         label: 'AI',         hint: 'The Verge, TechCrunch, Guardian AI desks' },
  { id: 'space',      label: 'Space',      hint: 'Guardian Space, NASA news' },
  { id: 'gaming',     label: 'Gaming',     hint: 'Polygon, Guardian Games' },
  { id: 'climate',    label: 'Climate',    hint: 'Guardian Environment, NPR Climate' },
  { id: 'food',       label: 'Food',       hint: 'Guardian Food, NPR Food' },
  { id: 'travel',     label: 'Travel',     hint: 'Guardian Travel' },
  { id: 'politics',   label: 'Politics',   hint: 'NPR Politics, Guardian US Politics' },
];

export const DEFAULT_FEED_TOPICS = ['world', 'technology', 'science'];
