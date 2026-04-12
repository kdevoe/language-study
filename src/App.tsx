import { Reader } from './components/Reader'
import { Feed } from './components/Feed'
import { Onboarding } from './components/Onboarding'
import { BottomNav } from './components/BottomNav'
import { Settings } from './components/Settings'
import { LandingPage } from './components/LandingPage'
import { useAppStore } from './services/store'
import { supabase } from './services/supabase'
import { useEffect, useState, useCallback } from 'react'
import { fetchNewsFeed, NewsArticle, requestArticleProcessing } from './services/api'
import { MoreVertical, ChevronLeft } from 'lucide-react'

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';
if (DEV_MODE) console.log('%c🛠 DEV MODE ACTIVE', 'color: #4a5d23; font-weight: bold; font-size: 14px');

function App() {
  const isOnboarded = useAppStore(state => state.isOnboarded);
  const checkDailyKanji = useAppStore(state => state.checkDailyKanji);
  const [activeTab, setActiveTab] = useState<'news' | 'progress' | 'settings'>('news');
  const [showNav, setShowNav] = useState(true);
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
  const [failedArticleIds, setFailedArticleIds] = useState<Set<string>>(new Set());

  const handleProcessArticle = useCallback(async (article: NewsArticle) => {
    if (!article.id || articlesCache[article.id] || (processingArticles || []).includes(article.id) || failedArticleIds.has(article.id)) return;

    setProcessing(article.id, true);
    try {
      const snippet = article.blocks[0].content?.[0]?.text || '';
      let userId: string;
      if (DEV_MODE) {
        userId = 'dev-user';
      } else {
        const { data: { user } } = await (await import('./services/supabase')).supabase.auth.getUser();
        if (!user) throw new Error('No user');
        userId = user.id;
      }
      const processedBlocks = await requestArticleProcessing(
        userId,
        article.id,
        article.title,
        snippet,
        () => {}
      );
      saveProcessedArticle(article.id, { ...article, blocks: processedBlocks });
    } catch (e) {
      console.error('[process] Failed for article:', article.id, article.title, e);
      setFailedArticleIds(prev => new Set(prev).add(article.id));
    }
    setProcessing(article.id, false);
  }, [articlesCache, processingArticles, setProcessing, saveProcessedArticle, failedArticleIds]);

  const replenishFeedAtBottom = useCallback(async () => {
    if (isReplenishing || isLoadingFeed || isEndOfFeed) return;
    
    setIsReplenishing(true);
    try {
      const currentPage = Math.floor(articles.length / 20) + 1;
      let newArticles: NewsArticle[] = [];
      
      // Try current and next page if first is full of dupes
      for (let p = currentPage; p < currentPage + 2; p++) {
        const moreNews = await fetchNewsFeed(p);
        if (moreNews.length === 0) {
          setIsEndOfFeed(true);
          break;
        }

        const existingIds = new Set(articles.map(a => a?.id).filter(Boolean));
        const dismissedSet = new Set(useAppStore.getState().dismissedArticleIds || []);

        const filtered = moreNews.filter(a => {
          if (!a || !a.id) return false;
          const isJunk = !a.title || a.title.includes('[Removed]') || a.title.length < 10;
          return !isJunk && !existingIds.has(a.id) && !dismissedSet.has(a.id);
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
      const feed = await fetchNewsFeed(1);
      const uniqueFeed = Array.from(new Map(feed.map(a => [a.id, a])).values());
      
      // If we start the app, uniqueFeed could contain up to 20 raw items.
      setArticles(uniqueFeed);
      if (uniqueFeed.length === 0) {
        setIsEndOfFeed(true);
      }
    } catch (e) { console.error(e); }
    setIsLoadingFeed(false);
  };

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
        // Robust initialization with a 5s timeout to prevent blank screens on startup
        const sessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Supabase initialization timed out")), 5000)
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
        console.error("Initialization error:", err);
        setSession(null);
        setApprovalStatus(null);
      } finally {
        setIsInitializing(false);
      }
    };

    initSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
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
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadGlobalCache = async (userId: string) => {
    const { fetchCachedArticlesFromSupabase } = await import('./services/api');
    const cache = await fetchCachedArticlesFromSupabase(userId);
    if (Object.keys(cache).length > 0) {
      useAppStore.getState().setArticlesCache(cache);
    }
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

  useEffect(() => {
    if (isOnboarded && session) {
      checkDailyKanji();
      checkMidnightReset();
      loadGlobalCache(session.user.id);
      useAppStore.getState().syncSrsWithSupabase(session.user.id);
      if (articles.length === 0) loadHub();
    }
  }, [isOnboarded, session, checkDailyKanji, articles.length, checkMidnightReset]);

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

  // JIT PRE-PROCESSOR: Ensure exactly 1 article ahead is processed or processing
  useEffect(() => {
    if (isLoadingFeed || isReplenishing || isEndOfFeed) return;

    const visibleArts = articles.filter(a => !(dismissedArticleIds || []).includes(a.id));
    if (visibleArts.length === 0) return;

    // Check if there is ANY article in the buffer that's already processed or currently processing
    // We ignore the activeArticle because if they are reading it, we need a fresh one in the buffer!
    const isBufferReady = visibleArts.some(a =>
      (articlesCache[a.id] || (processingArticles || []).includes(a.id)) &&
      activeArticle?.id !== a.id
    );

    if (!isBufferReady) {
      // Triggers processing for the very first available raw article (skip failed ones)
      const nextTarget = visibleArts.find(a =>
        !articlesCache[a.id] &&
        !(processingArticles || []).includes(a.id) &&
        !failedArticleIds.has(a.id) &&
        activeArticle?.id !== a.id
      );

      if (nextTarget) {
        handleProcessArticle(nextTarget);
      }
    }
  }, [articles, dismissedArticleIds, articlesCache, processingArticles, activeArticle, handleProcessArticle, failedArticleIds, isLoadingFeed, isReplenishing, isEndOfFeed]);


  // Removed: syncPrefetchQueue useEffect - the daily-feed Edge Function handles background processing

  const handleSelectArticle = (article: NewsArticle) => {
    if (!article.id) return;
    useAppStore.getState().setCurrentArticle(null);
    if (articlesCache[article.id]) {
      setActiveArticle(articlesCache[article.id]);
      setNewsView('reading');
      setShowNav(true);
      window.scrollTo(0, 0);
      setTimeout(() => replenishFeedAtBottom(), 500);
    } else {
      // Not yet cached — request on-demand server-side processing
      handleProcessArticle(article);
    }
  };

  const handleDismissAndSync = (id: string) => {
    dismissArticle(id);
    setTimeout(() => replenishFeedAtBottom(), 100);
  };

  const handleBackToHub = () => {
    setNewsView('hub');
    setShowNav(true);
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
        paddingTop: 'calc(5rem + env(safe-area-inset-top))', // Space for fixed header
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
            <Reader key={activeArticle?.id} initialArticle={activeArticle} onComplete={handleBackToHub} />
          )
        )}
        {activeTab === 'progress' && (
          <div className="fade-in" style={{ textAlign: 'center', marginTop: '4rem', color: 'var(--text-muted)' }}>
            <p>Progress dashboard placeholder.</p>
          </div>
        )}
        {activeTab === 'settings' && <Settings />}
      </main>
      <BottomNav activeTab={activeTab} onChange={setActiveTab} isVisible={showNav && newsView !== 'reading'} />
    </div>
  )
}

export default App
