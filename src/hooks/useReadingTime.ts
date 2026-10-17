import { useEffect, useRef } from 'react';
import { recordArticleReading } from '../services/api';

// The end coming into view this soon after opening (a short article, or the
// end marker showing while content loads) isn't a finish yet.
const MIN_SECONDS_TO_FINISH = 20;

/**
 * Time on an article and whether it was finished, for learner memory
 * (docs/learner-memory-design.md §3: "read" only means opened).
 * Counts while the page is visible; flushes when the page hides, when the
 * article changes and on leave. `atEnd` stamps finished once per article.
 */
export function useReadingTime(articleId: string | undefined, atEnd: boolean) {
  const startRef = useRef<number | null>(null);   // start of the unflushed stretch
  const openedRef = useRef(0);
  const finishedRef = useRef(false);
  const atEndRef = useRef(atEnd);
  atEndRef.current = atEnd;

  useEffect(() => {
    if (!articleId) return;
    finishedRef.current = false;
    openedRef.current = Date.now();
    startRef.current = document.visibilityState === 'visible' ? Date.now() : null;

    const flush = (finished = false) => {
      const secs = startRef.current ? (Date.now() - startRef.current) / 1000 : 0;
      startRef.current = document.visibilityState === 'visible' ? Date.now() : null;
      if (secs >= 3 || finished) recordArticleReading(articleId, secs, finished);
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
      else startRef.current = Date.now();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      flush();
      startRef.current = null;
    };
  }, [articleId]);

  useEffect(() => {
    if (!articleId || !atEnd || finishedRef.current) return;
    const finish = () => {
      if (finishedRef.current || !atEndRef.current) return;
      finishedRef.current = true;
      const secs = startRef.current ? (Date.now() - startRef.current) / 1000 : 0;
      startRef.current = Date.now();
      recordArticleReading(articleId, secs, true);
    };
    const wait = MIN_SECONDS_TO_FINISH * 1000 - (Date.now() - openedRef.current);
    if (wait <= 0) { finish(); return; }
    const t = setTimeout(finish, wait);
    return () => clearTimeout(t);
  }, [articleId, atEnd]);
}
