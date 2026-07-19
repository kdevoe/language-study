import { Reader } from './components/Reader'
import { Feed } from './components/Feed'
import { Onboarding } from './components/Onboarding'
import { BottomNav } from './components/BottomNav'
import { Settings } from './components/Settings'
import { Progress } from './components/Progress'
import { Flashcards } from './components/Flashcards'
import { LandingPage } from './components/LandingPage'
import { useAppStore } from './services/store'
import { supabase } from './services/supabase'
import { useEffect, useState, useCallback, useRef } from 'react'
import { fetchNewsFeed, NewsArticle, requestArticleProcessing, fetchReadyBufferArticles, ensureBuffer, isServerBusyError } from './services/api'
import { MoreVertical, ChevronLeft } from 'lucide-react'
import { UpdatePrompt } from './components/UpdatePrompt'

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';
if (DEV_MODE) console.log('%c🛠 DEV MODE ACTIVE', 'color: #4a5d23; font-weight: bold; font-size: 14px');

function App() {
  const isOnboarded = useAppStore(state => state.isOnboarded);
  const checkDailyKanji = useAppStore(state => state.checkDailyKanji);
  const [activeTab, setActiveTab] = useState<'news' | 'flashcards' | 'progress' | 'settings'>('news');
  const [showNav, setShowNav] = useState(true);
  // Flashcard focus mode: tapping into a card hides the bottom nav so the card
  // can use that space; Flashcards reports the state up from its card flow.
  const [studyFocus, setStudyFocus] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [approvalStatus, setApprovalStatus] = useState<'approved' | 'waitlisted' | 'not_joined' | null>(null);

  // News Hub State
  const [newsView, setNewsView] = useState<'hub' | 'reading'>('hub');
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [isLoadingFeed, setIsLoadingFeed] = useState(false);
  const [isReplenishing, setIsReplenishing] = useState(false);
  const [isEndOfFeed, setIsEndOfFeed] = useState(false);
  const [activeArticle, setActiveArticle] = useState<NewsArticle | null>(null);

  const processingArticles = useAppStore(state => state.processingArticles || []);
  const articlesCache = useAppStore(state => state.articlesCache || {});
  const setProcessing = useAppStore(state => state.setProcessing);
  const saveProcessedArticle = useAppStore(state => state.saveProcessedArticle);
  const dismissedArticleIds = useAppStore(state => state.dismissedArticleIds || []);
  const dismissArticle = useAppStore(state => state.dismissArticle);
  const markArticleRead = useAppStore(state => state.markArticleRead);
  // Transient, user-visible message for failures that would otherwise be silent
  // (e.g. an article that does nothing when tapped because processing failed).
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 5000);
    return () => clearTimeout(t);
  }, [actionError]);

  const handleProcessArticle = useCallback(async (article: NewsArticle): Promise<NewsArticle | null> => {
    // null return = a no-op guard (already cached or a tap while a prior run for
    // this same article is still in flight), NOT a failure. Real failures throw,
    // so the caller can classify them and show accurate copy. We deliberately do
    // NOT remember failures: the only caller is an explicit user tap (the client
    // JIT pre-processor is retired), so a re-tap should always retry — a single
    // transient blip must never permanently brick a card for the session.
    if (!article.id || articlesCache[article.id] || (processingArticles || []).includes(article.id)) return null;

    setProcessing(article.id, true);
    try {
      const snippet = article.blocks[0].content?.[0]?.text || '';
      let userId: string;
      if (DEV_MODE) {
        userId = 'dev-user';
      } else {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) throw new Error('No user');
        userId = session.user.id;
      }
      const processedBlocks = await requestArticleProcessing(
        userId,
        article.id,
        article.title,
        snippet,
        article.sources,
        () => {}
      );
      const processed = { ...article, blocks: processedBlocks };
      saveProcessedArticle(article.id, processed);
      return processed;
    } catch (e) {
      console.error('[process] Failed for article:', article.id, article.title, e);
      throw e;
    } finally {
      setProcessing(article.id, false);
    }
  }, [articlesCache, processingArticles, setProcessing, saveProcessedArticle]);

  const replenishFeedAtBottom = useCallback(async () => {
    if (isReplenishing || isLoadingFeed || isEndOfFeed) return;
    
    setIsReplenishing(true);
    try {
      const currentPage = Math.floor(articles.length / 20) + 1;
      let newArticles: NewsArticle[] = [];
      
      // Try current and next page if first is full of dupes
      for (let p = currentPage; p < currentPage + 2; p++) {
        const moreNews = await fetchNewsFeed(p, useAppStore.getState().feedTopics);
        if (moreNews.length === 0) {
          setIsEndOfFeed(true);
          break;
        }

        const existingIds = new Set(articles.map(a => a?.id).filter(Boolean));
        const { dismissedArticleIds: dismissed, readArticleIds: read } = useAppStore.getState();
        const seenSet = new Set([...(dismissed || []), ...(read || [])]);

        const filtered = moreNews.filter(a => {
          if (!a || !a.id) return false;
          const isJunk = !a.title || a.title.includes('[Removed]') || a.title.length < 10;
          return !isJunk && !existingIds.has(a.id) && !seenSet.has(a.id);
        });

        if (filtered.length > 0) {
          newArticles = filtered;
          break;
        }
      }

      if (newArticles.length > 0) {
        setArticles(prev => [...prev, ...newArticles]);
      } else {
        setIsEndOfFeed(true); // No unique news found in search depth
      }
    } catch (e) { 
      console.error("Replenishment failure:", e);
      setIsEndOfFeed(true);
    } finally {
      setIsReplenishing(false);
    }
  }, [articles, isReplenishing, isLoadingFeed, isEndOfFeed]);


  const loadHub = async () => {
    setIsLoadingFeed(true);
    setIsEndOfFeed(false);
    try {
      // Who are we? The ready buffer + ensureBuffer are per-user (skipped in dev,
      // which has no real session / server rows).
      let userId: string | null = null;
      if (DEV_MODE) {
        userId = 'dev-user';
      } else {
        const { data: { session } } = await supabase.auth.getSession();
        userId = session?.user?.id ?? null;
      }

      // App-open trigger: idempotent safety net so a new/drained user gets a
      // buffer even if no cron/read fired. Fire-and-forget — never blocks the feed.
      if (userId && !DEV_MODE) ensureBuffer(userId);

      const [feed, readyBuffer] = await Promise.all([
        fetchNewsFeed(1, useAppStore.getState().feedTopics),
        userId && !DEV_MODE ? fetchReadyBufferArticles(userId) : Promise.resolve([] as NewsArticle[]),
      ]);

      // Drop articles the user has already read or dismissed so they're never
      // pulled back in as fresh suggestions (e.g. on reopen the same day).
      const { dismissedArticleIds: dismissed, readArticleIds: read } = useAppStore.getState();
      const seen = new Set([...(dismissed || []), ...(read || [])]);

      // Server-produced ready articles go FIRST — they're fresh and instantly
      // openable. They surface even when not in today's raw NewsAPI fetch, fixing
      // the original "processed-but-unread article never appears on open" bug.
      //
      // Do NOT re-filter these through the local `seen` set: the server's `ready`
      // status is authoritative. ensure_buffer_claim only produces a story the
      // user has no row for, and markArticleConsumed flips a row OUT of `ready`
      // the instant it's read/dismissed — so a row that is STILL `ready` is
      // genuinely unread. A ready id CAN sit in the local seen set when a raw
      // headline was swiped before it was ever processed (that dismiss only
      // touched localStorage, leaving no DB row, so the buffer later re-produced
      // it). Filtering it here hid the article AND wedged the buffer full of
      // invisible rows so nothing new ever loaded (issue #31 deadlock).
      const readyFresh = readyBuffer.filter(a => a && a.id);
      const readyIds = new Set(readyFresh.map(a => a.id));

      const uniqueFeed = Array.from(new Map(feed.map(a => [a.id, a])).values());
      const freshFeed = uniqueFeed.filter(a => a.id && !seen.has(a.id) && !readyIds.has(a.id));

      const combined = [...readyFresh, ...freshFeed];
      setArticles(combined);
      if (combined.length === 0) {
        setIsEndOfFeed(true);
      }

      // Cache the ready articles so they show the READY badge and open instantly.
      if (readyFresh.length > 0) {
        const cache = useAppStore.getState().articlesCache;
        const add: Record<string, NewsArticle> = {};
        readyFresh.forEach(a => { add[a.id] = a; });
        useAppStore.getState().setArticlesCache({ ...add, ...cache });
      }
    } catch (e) { console.error(e); }
    setIsLoadingFeed(false);
  };

  // ── Mid-session buffer surfacing ─────────────────────────────────────────────
  // loadHub only pulls the server's `ready` buffer on open, but the server keeps
  // producing (on every read/dismiss, plus the overnight cron). Without this, a
  // user who reads through the buffer sees nothing new until they reopen the app
  // — exactly the "I swiped everything and it's stuck on raw cards" report. This
  // prepends any freshly-produced ready article into the live feed. Returns true
  // if it added at least one (so the watcher can stop early).
  const articlesRef = useRef<NewsArticle[]>([]);
  articlesRef.current = articles;
  const surfaceReadyBuffer = useCallback(async (): Promise<boolean> => {
    if (DEV_MODE) return false;
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return false;
    const ready = await fetchReadyBufferArticles(userId);
    if (ready.length === 0) return false;
    const have = new Set(articlesRef.current.map(a => a?.id).filter(Boolean));
    const fresh = ready.filter(a => a && a.id && !have.has(a.id));
    if (fresh.length === 0) return false;
    // Cache so they open instantly and show the READY badge.
    const cache = useAppStore.getState().articlesCache;
    const add: Record<string, NewsArticle> = {};
    fresh.forEach(a => { add[a.id] = a; });
    useAppStore.getState().setArticlesCache({ ...add, ...cache });
    setArticles(prev => {
      const ids = new Set(prev.map(a => a?.id).filter(Boolean));
      const toAdd = fresh.filter(a => !ids.has(a.id));
      return toAdd.length ? [...toAdd, ...prev] : prev;
    });
    return true;
  }, []);

  // A read/dismiss that moves a buffer row triggers server production (~10-20s of
  // Gemini work). Poll a few times afterward to surface the result, then stop.
  // One watcher at a time (ref guard) so rapid swiping doesn't stack timers; it
  // ends early the moment a fresh article lands.
  const readyWatchRef = useRef(false);
  const watchForFreshReady = useCallback(() => {
    if (readyWatchRef.current) return;
    readyWatchRef.current = true;
    let tries = 0;
    const tick = async () => {
      tries++;
      const added = await surfaceReadyBuffer().catch(() => false);
      if (added || tries >= 4) { readyWatchRef.current = false; return; }
      setTimeout(tick, 8000);
    };
    setTimeout(tick, 8000);
  }, [surfaceReadyBuffer]);

  useEffect(() => {
    const initSession = async () => {
      if (DEV_MODE) {
        console.log('[DEV] Skipping auth — loading feed directly');
        setSession({ user: { email: 'dev@yugen.local', id: 'dev-user' } });
        setApprovalStatus('approved');
        setIsInitializing(false);
        loadHub();
        return;
      }

      try {
        // 8s timeout only prevents a blank screen on a slow/hung network. It must
        // NOT force-logout: on timeout we leave the session untouched and let the
        // onAuthStateChange INITIAL_SESSION event below deliver the restored
        // session. Throwing it away here was bouncing valid users to re-login.
        const sessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Supabase initialization timed out")), 8000)
        );

        const { data: { session } } = await Promise.race([sessionPromise, timeoutPromise]) as any;
        setSession(session);

        if (session?.user?.email) {
          const { data: status, error } = await supabase.rpc('check_is_approved', { p_email: session.user.email });
          if (error) console.error("Whitelist check error:", error);
          setApprovalStatus(status || 'not_joined');
        } else {
          setApprovalStatus(null);
        }
      } catch (err) {
        // Slow/transient init — do NOT clear the session. The auth listener will
        // populate it from persisted storage once getSession resolves.
        console.warn("Session init slow; deferring to auth listener:", err);
      } finally {
        setIsInitializing(false);
      }
    };

    initSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      // IMPORTANT: this callback runs while GoTrue still holds its navigator
      // auth lock. Calling another auth-dependent Supabase fn (rpc, getUser…)
      // inside it would re-enter the lock and deadlock — hanging every later
      // getSession/getUser until timeout. Defer with setTimeout(0) so the lock
      // is released first. (Keep the callback itself synchronous.)
      setTimeout(async () => {
        if (session?.user?.email) {
          try {
            const { data: status } = await supabase.rpc('check_is_approved', { p_email: session.user.email });
            setApprovalStatus(status || 'not_joined');
          } catch (e) {
            console.error("Auth change status check error:", e);
          }
        } else {
          setApprovalStatus(null);
        }
      }, 0);
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadGlobalCache = async (userId: string) => {
    const { fetchCachedArticlesFromSupabase } = await import('./services/api');
    const serverCache = await fetchCachedArticlesFromSupabase(userId);
    if (Object.keys(serverCache).length === 0) return;
    // Merge server-side completions (e.g. an article that finished processing
    // after the app was closed) into the local cache. Local copies win on
    // overlap so we don't clobber anything saved this session.
    const existingCache = useAppStore.getState().articlesCache;
    useAppStore.getState().setArticlesCache({ ...serverCache, ...existingCache });
  };

  const checkMidnightReset = useCallback(() => {
    const lastReset = useAppStore.getState().lastResetTs;
    const now = new Date();
    // Compare only YYYY-MM-DD
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    
    if (!lastReset || lastReset < todayStart) {
      useAppStore.getState().resetFeedForNewDay(todayStart);
      loadHub(); // Fully fresh start for the new day
    }
  }, [loadHub]);

  // One-time init: runs when user is onboarded + authenticated
  const loadedCacheForUser = useRef<string | null>(null);
  useEffect(() => {
    if (isOnboarded && session) {
      checkDailyKanji();
      checkMidnightReset();
      // This effect re-runs on every `session` change (token refresh / tab
      // refocus produce a new session object with the same user id). Only the
      // first run per user should hydrate the processed-article cache — re-pulling
      // the recent-articles `content` JSONB on each refocus was the repeated
      // multi-MB network/Disk-IOPS burst seen in Observability.
      if (loadedCacheForUser.current !== session.user.id) {
        loadedCacheForUser.current = session.user.id;
        loadGlobalCache(session.user.id);
      }
      // Sync first (hydrates remote progress + the new-words/day preference), then run
      // the daily intake promotion (#68) so it sees the up-to-date queue + cap.
      useAppStore.getState().syncSrsWithSupabase(session.user.id)
        .then(() => useAppStore.getState().promoteIntakeQueue(Date.now()))
        .catch((e) => console.warn('[app] SRS sync / intake promotion failed:', e));
    }
  }, [isOnboarded, session, checkDailyKanji, checkMidnightReset]);

  // Separate effect: load feed if empty (no cascade from articles.length changes)
  useEffect(() => {
    if (isOnboarded && session && articles.length === 0) {
      loadHub();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnboarded, session]);

  useEffect(() => {
    const handleOnline = () => {
      if (session?.user?.id) {
        useAppStore.getState().syncSrsWithSupabase(session.user.id);
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [session]);

  // THE SENTINEL: Ensure we always have at least 5 visible articles
  useEffect(() => {
    if (isLoadingFeed || isReplenishing || articles.length === 0) return;
    
    const visibleArticles = articles.filter(a => !(dismissedArticleIds || []).includes(a.id));
    if (visibleArticles.length < 5) {
      // Small delay to let animations settle before pulling another
      const timer = setTimeout(replenishFeedAtBottom, 200);
      return () => clearTimeout(timer);
    }
  }, [articles, dismissedArticleIds, isReplenishing, isLoadingFeed, replenishFeedAtBottom]);

  // RETIRED (issue #31): the client-side JIT pre-processor. The SERVER now owns
  // production via ensureBuffer — it keeps N ready articles in processed_news,
  // under a per-user advisory lock + daily cap. The client is a pure consumer:
  // loadHub surfaces the ready buffer, ensureBuffer is triggered on open/read/
  // dismiss, and handleSelectArticle keeps on-tap processing as a last resort.
  //
  // ⚠️  This client JIT and the server JIT are MUTUALLY EXCLUSIVE: the old effect
  // called process-article directly, bypassing the buffer accounting and daily
  // cap. Re-enabling it alongside the server JIT would mean uncapped production.
  // Do not restore it. (And this branch must not ship until JIT_ENABLED=true is
  // set in prod, else there is no pre-processing at all → spinner on every open.)

  // Tracks the article the user most recently asked to open. On-demand processing
  // takes ~10-20s; by the time it resolves the user may have tapped a different
  // article, opened another, or gone back to browsing the list. A stale resolution
  // must NOT yank them into an article they're no longer waiting for — it just
  // lands in the cache (READY badge) for them to open on their own terms.
  const pendingOpenIdRef = useRef<string | null>(null);

  const openReader = useCallback((article: NewsArticle) => {
    setActiveArticle(article);
    setNewsView('reading');
    setShowNav(true);
    window.scrollTo(0, 0);
    setTimeout(() => replenishFeedAtBottom(), 500);
  }, [replenishFeedAtBottom]);

  const handleSelectArticle = async (article: NewsArticle) => {
    if (!article.id) return;
    // Mark this as the live open request. Any in-flight processing for a PREVIOUS
    // tap will see a changed token when it resolves and decline to navigate.
    pendingOpenIdRef.current = article.id;
    // Reading marks the article read (so it's never pulled back in as a fresh
    // suggestion) but does NOT remove it from the visible feed — the user
    // dismisses it manually when they're done with it.
    markArticleRead(article.id);
    watchForFreshReady(); // reading a buffer article frees a slot → server refills
    // NOTE: do NOT null currentArticle here. The Reader loads its own article by id on
    // mount (keyed by activeArticle.id), so blanking the shared currentArticle only
    // served to flash the article you're currently reading down to a spinner the moment
    // you tapped a different one — before the new article had even finished loading.

    if (articlesCache[article.id]) {
      openReader(articlesCache[article.id]);
      return;
    }

    try {
      // Not in the local cache. It may have finished processing on the server
      // while the app was closed — pull it down before starting a fresh run.
      let userId = 'dev-user';
      if (!DEV_MODE) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) {
          setActionError('You appear to be signed out. Refresh and try again.');
          return;
        }
        userId = session.user.id;
      }
      const { fetchProcessedArticleById } = await import('./services/api');
      const fromServer = await fetchProcessedArticleById(article.id, userId);
      if (fromServer) {
        saveProcessedArticle(article.id, fromServer);
        // Cached now; only navigate if the user is still waiting on THIS article.
        if (pendingOpenIdRef.current === article.id) openReader(fromServer);
        return;
      }

      // Genuinely not processed yet — process on demand, then open the Reader.
      const processed = await handleProcessArticle(article);
      // A null (non-throwing) result means a no-op guard fired — most likely a
      // tap while a prior run for this same article is still in flight. Don't
      // show an error; the in-flight run will open it.
      if (processed && pendingOpenIdRef.current === article.id) openReader(processed);
    } catch (e) {
      console.error('[select] Failed to open article:', article.id, e);
      const busy = isServerBusyError(e);
      setActionError(
        busy
          ? "The server's busy right now — give it a moment and tap again."
          : "Couldn't load this article. Please try again, or pick another."
      );
    }
  };

  const handleDismissAndSync = (id: string) => {
    dismissArticle(id);
    watchForFreshReady(); // dismissing a buffer article frees a slot → server refills
    setTimeout(() => replenishFeedAtBottom(), 100);
  };

  const handleBackToHub = () => {
    setNewsView('hub');
    setShowNav(true);
    surfaceReadyBuffer(); // returning to the feed: pull in anything produced while reading
  };

  // Finish button at the end of the Reader: mark the article done AND remove it
  // from the feed (handleDismissAndSync), then return to the hub.
  const handleFinishArticle = () => {
    if (activeArticle?.id) handleDismissAndSync(activeArticle.id);
    handleBackToHub();
  };

  useEffect(() => {
    let lastScrollY = window.scrollY;
    let ticking = false;
    const updateNav = () => {
      const currentScrollY = window.scrollY;
      const isAtBottom = (window.innerHeight + currentScrollY) >= document.body.offsetHeight - 50;

      if (currentScrollY > lastScrollY && currentScrollY > 50) {
        setShowNav(false);
      } else if (lastScrollY - currentScrollY > 40 && !isAtBottom) {
        // Require a 40px scroll UP to show the nav, AND prevent it from popping
        // if we just bounced off the absolute bottom of the page
        setShowNav(true);
      }
      lastScrollY = currentScrollY > 0 ? currentScrollY : 0;
      ticking = false;
    };
    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(updateNav);
        ticking = true;
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  if (isInitializing && !DEV_MODE) {
    return (
      <div style={{ 
        height: '100vh', 
        display: 'flex', 
        flexDirection: 'column',
        justifyContent: 'center', 
        alignItems: 'center',
        backgroundColor: 'var(--bg-color)',
        color: 'var(--text-muted)'
      }}>
        <div className="lucide-spin" style={{ 
          width: '32px', 
          height: '32px', 
          border: '2px solid var(--border-light)', 
          borderTopColor: 'var(--text-main)', 
          borderRadius: '50%',
          marginBottom: '1.5rem'
        }} />
        <span className="serif" style={{ fontSize: '0.9rem', letterSpacing: '0.1em' }}>INITIALIZING</span>
      </div>
    );
  }

  if (!session && !DEV_MODE) return <LandingPage />;
  
  // Whitelist Gate
  if (!DEV_MODE && (approvalStatus === 'waitlisted' || approvalStatus === 'not_joined')) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '2rem', textAlign: 'center', backgroundColor: 'var(--bg-color)', color: 'var(--text-main)' }}>
        <h2 className="serif" style={{ fontSize: '2rem', marginBottom: '1rem' }}>Private Beta</h2>
        <p className="sans" style={{ color: 'var(--text-muted)', marginBottom: '2rem', maxWidth: '400px' }}>
          {approvalStatus === 'waitlisted' 
            ? `Your email (${session?.user?.email}) is on our waitlist. We'll be in touch as soon as we're ready for more testers.`
            : `Your email (${session?.user?.email}) is not yet on our authorized beta list. Please join the waitlist on the landing page.`
          }
        </p>
        <button 
          onClick={() => supabase.auth.signOut()}
          style={{ background: 'none', border: 'none', color: 'var(--text-main)', textDecoration: 'underline', cursor: 'pointer' }}
        >
          Sign out
        </button>
      </div>
    );
  }

  if (!isOnboarded && !DEV_MODE) return <Onboarding />;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <UpdatePrompt />
      {actionError && (
        <div
          role="alert"
          onClick={() => setActionError(null)}
          style={{
            position: 'fixed',
            top: 'max(1rem, env(safe-area-inset-top))',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            maxWidth: 'min(90vw, 420px)',
            padding: '0.75rem 1.1rem',
            borderRadius: '14px',
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-light)',
            boxShadow: '0 6px 30px rgba(0,0,0,0.12)',
            color: 'var(--text-main)',
            fontSize: '0.85rem',
            lineHeight: 1.4,
            cursor: 'pointer',
            textAlign: 'center',
          }}
        >
          {actionError}
        </div>
      )}
      <header
        data-shownav={showNav}
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          padding: 'max(1.5rem, env(safe-area-inset-top)) 1.25rem 1.5rem',
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          backgroundColor: 'var(--bg-color)',
          zIndex: 10,
          transform: showNav ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s',
          opacity: showNav ? 1 : 0
        }}
      >
        {newsView === 'reading' ? (
          <button onClick={handleBackToHub} style={{ background: 'none', border: 'none', color: 'var(--text-main)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <ChevronLeft size={24} strokeWidth={1.5} />
          </button>
        ) : (
          <div style={{ width: '24px' }} /> // Placeholder to maintain centered title
        )}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h1 className="serif" translate="no" style={{ fontSize: '1.4rem', letterSpacing: '0.1em', color: 'var(--text-main)' }}>読書家</h1>
        </div>
        <button onClick={() => setActiveTab('settings')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <MoreVertical size={24} strokeWidth={1.5} />
        </button>
      </header>

      <main style={{ 
        flex: 1, 
        // Space for the fixed header. Mirror the header's own `max(1.5rem, safe-area)`
        // top-padding floor — otherwise when the safe-area inset is small/zero, main
        // under-reserves and the first card tucks ~4px under the header.
        paddingTop: 'calc(5rem + max(1.5rem, env(safe-area-inset-top)))',
        paddingRight: '1.25rem',
        paddingBottom: newsView === 'reading' ? '1rem' : '0rem',
        paddingLeft: '1.25rem',
        maxWidth: '600px', 
        margin: '0 auto', 
        width: '100%' 
      }}>
        {activeTab === 'news' && (
          newsView === 'hub' ? (
            <Feed 
              articles={(articles || []).filter(a => a && a.id && !(dismissedArticleIds || []).includes(a.id)).slice(0, 5)} 
              isLoading={isLoadingFeed} 
              isReplenishing={isReplenishing}
              onSelect={handleSelectArticle} 
              onDismiss={handleDismissAndSync}
              processingIds={processingArticles || []}
              cachedIds={Object.keys(articlesCache)}
              onManualFetch={loadHub}
              isManualFetching={isLoadingFeed}
            />
          ) : (
            <Reader key={activeArticle?.id} initialArticle={activeArticle} onComplete={handleFinishArticle} />
          )
        )}
        {activeTab === 'flashcards' && <Flashcards onFocusChange={setStudyFocus} />}
        {activeTab === 'progress' && <Progress />}
        {activeTab === 'settings' && <Settings />}
      </main>
      <BottomNav
        activeTab={activeTab}
        onChange={setActiveTab}
        isVisible={showNav && newsView !== 'reading' && !(activeTab === 'flashcards' && studyFocus)}
      />
    </div>
  )
}

export default App
