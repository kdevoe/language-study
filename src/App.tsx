import { Reader } from './components/Reader'
import { Feed } from './components/Feed'
import { Onboarding } from './components/Onboarding'
import { BottomNav } from './components/BottomNav'
import { Settings } from './components/Settings'
import { LandingPage } from './components/LandingPage'
import { useAppStore } from './services/store'
import { supabase } from './services/supabase'
import { useEffect, useState, useCallback } from 'react'
import { fetchNewsFeed, NewsArticle, rewriteArticleWithGemini } from './services/api'
import { MoreVertical, RefreshCcw, ChevronLeft } from 'lucide-react'

const FEED_TOPICS = ['Japan News', 'Technology News', 'Science News', 'World News'];

function App() {
  const isOnboarded = useAppStore(state => state.isOnboarded);
  const checkDailyKanji = useAppStore(state => state.checkDailyKanji);
  const [activeTab, setActiveTab] = useState<'news' | 'progress' | 'settings'>('news');
  const [showNav, setShowNav] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // News Hub State
  const [newsView, setNewsView] = useState<'hub' | 'reading'>('hub');
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [isLoadingFeed, setIsLoadingFeed] = useState(false);
  const [isReplenishing, setIsReplenishing] = useState(false);
  const [newsPage, setNewsPage] = useState(1);
  const [topicIndex, setTopicIndex] = useState(0);
  const [activeArticle, setActiveArticle] = useState<NewsArticle | null>(null);

  const processingArticles = useAppStore(state => state.processingArticles || []);
  const articlesCache = useAppStore(state => state.articlesCache || {});
  const setProcessing = useAppStore(state => state.setProcessing);
  const saveProcessedArticle = useAppStore(state => state.saveProcessedArticle);
  const dismissedArticleIds = useAppStore(state => state.dismissedArticleIds || []);
  const dismissArticle = useAppStore(state => state.dismissArticle);

  const handleProcessArticle = useCallback(async (article: NewsArticle) => {
    if (!article.id || articlesCache[article.id] || (processingArticles || []).includes(article.id)) return;
    
    setProcessing(article.id, true);
    try {
      const vocabTargets = Object.entries(useAppStore.getState().wordDatabase)
        .filter(([_, data]) => data.mastery === 'hard' || data.mastery === 'medium')
        .map(([w]) => w);
      
      const snippet = article.blocks[0].content?.[0]?.text || '';
      const rewrittenBlocks = await rewriteArticleWithGemini(
        article.title, snippet, 
        useAppStore.getState().jlptLevel || 5, 
        useAppStore.getState().rtkLevel || 0,
        useAppStore.getState().studyMode,
        useAppStore.getState().vocabMode,
        vocabTargets,
        () => {} 
      );
      saveProcessedArticle(article.id, { ...article, blocks: rewrittenBlocks });
    } catch (e) { 
      console.error("Prefetch error:", e); 
    }
    setProcessing(article.id, false);
  }, [articlesCache, processingArticles, setProcessing, saveProcessedArticle]);

  const syncPrefetchQueue = useCallback(() => {
    if (articles.length === 0) return;
    const visibleArticles = articles.filter(a => !(dismissedArticleIds || []).includes(a.id));
    const nextCandidate = visibleArticles.find(a => !articlesCache[a.id] && !processingArticles.includes(a.id));
    
    // Check if we ALREADY have a processed, readable article waiting in the visible feed
    const hasUnreadReady = visibleArticles.some(a => articlesCache[a.id]);
    const isAlreadyWorking = processingArticles.length > 0;
    
    // Only trigger heavy LLM processing if the pipeline is completely empty
    if (nextCandidate && !hasUnreadReady && !isAlreadyWorking) {
      handleProcessArticle(nextCandidate);
    }
  }, [articles, dismissedArticleIds, articlesCache, processingArticles, handleProcessArticle]);

  const replenishFeedAtBottom = useCallback(async () => {
    if (isReplenishing || isLoadingFeed) return;
    
    setIsReplenishing(true);
    try {
      let found = false;
      let attempts = 0;
      let finalSearchPage = newsPage;
      
      while (!found && attempts < 10) {
        attempts++;
        
        // Wrap finalSearchPage strictly under 20 to prevent NewsAPI 100-item hard limit errors
        finalSearchPage = ((newsPage + attempts) % 20);
        if (finalSearchPage === 0) finalSearchPage = 1;
        
        const topic = FEED_TOPICS[(topicIndex + attempts) % FEED_TOPICS.length];
        
        const finalTopic = attempts > 6 ? 'Top Headlines' : topic;
        // Fetch a batch of 10 to guarantee finding at least one valid one efficiently
        const moreNews = await fetchNewsFeed(finalTopic, 10, finalSearchPage);

        // Synchronously check against our closure's tracking lists
        const existingIds = new Set(articles.map(a => a.id));
        const dismissedSet = new Set(useAppStore.getState().dismissedArticleIds || []);

        const validCandidate = moreNews.find(a => {
          const isJunk = !a.title || a.title.includes('[Removed]') || a.title.length < 10 || /^[0-9:\/\s]+$/.test(a.title);
          return !isJunk && !existingIds.has(a.id) && !dismissedSet.has(a.id);
        });

        if (validCandidate) {
          found = true;
          // React state is safe to update since we break immediately
          setArticles(prev => [...prev, validCandidate]);
        }
        
        if (found) break;
        await new Promise(r => setTimeout(r, 100));
      }
      
      // ALWAYS advance the page tracker so the next sentinel call 
      // doesn't start from the same spot
      setNewsPage(finalSearchPage);
      setTopicIndex(prev => prev + 1);
    } catch (e) { 
      console.error("Endless search error:", e); 
    } finally {
      setIsReplenishing(false);
    }
  }, [newsPage, topicIndex, isReplenishing, isLoadingFeed]);

  // THE SENTINEL: Ensure we always have at least 5 visible articles
  useEffect(() => {
    if (isLoadingFeed || isReplenishing || articles.length === 0) return;
    
    const visibleArticles = articles.filter(a => !(dismissedArticleIds || []).includes(a.id));
    if (visibleArticles.length < 5) {
      // Cooldown timer: Only attempt to replenish every 2 seconds if the count is low
      const timer = setTimeout(replenishFeedAtBottom, 2000);
      return () => clearTimeout(timer);
    }
  }, [articles, dismissedArticleIds, isReplenishing, isLoadingFeed, replenishFeedAtBottom]);

  const loadHub = async () => {
    setIsLoadingFeed(true);
    try {
      const feed = await fetchNewsFeed('Japan News', 10, 1);
      // Ensure initial set is unique (NewsAPI can be weird)
      const uniqueFeed = Array.from(new Map(feed.map(a => [a.id, a])).values());
      setArticles(uniqueFeed);
      setNewsPage(1);
    } catch (e) { console.error(e); }
    setIsLoadingFeed(false);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setIsInitializing(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
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
      if (articles.length === 0) loadHub();
    }
  }, [isOnboarded, session, checkDailyKanji, articles.length, checkMidnightReset]);

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

  useEffect(() => {
    if (articles.length > 0) syncPrefetchQueue();
  }, [articles, syncPrefetchQueue]);

  const handleSelectArticle = (article: NewsArticle) => {
    if (!article.id) return;
    useAppStore.getState().setCurrentArticle(null);
    if (articlesCache[article.id]) {
      setActiveArticle(articlesCache[article.id]);
      setNewsView('reading');
      setShowNav(false);
      setTimeout(() => {
        syncPrefetchQueue();
        replenishFeedAtBottom(); // Pull more when reading starts
      }, 500); 
    } else {
      handleProcessArticle(article);
    }
  };

  const handleDismissAndSync = (id: string) => {
    dismissArticle(id);
    setTimeout(() => {
      syncPrefetchQueue();
      replenishFeedAtBottom(); // Pull more when dismissing
    }, 100);
  };

  const handleBackToHub = () => {
    setNewsView('hub');
    setShowNav(true);
    syncPrefetchQueue();
  };

  useEffect(() => {
    let lastScrollY = window.scrollY;
    let ticking = false;
    const updateNav = () => {
      const currentScrollY = window.scrollY;
      if (currentScrollY > lastScrollY && currentScrollY > 50) {
        setShowNav(false);
      } else if (lastScrollY - currentScrollY > 15) {
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

  if (isInitializing) {
    return <div style={{ height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center' }} />;
  }

  if (!session) return <LandingPage />;
  if (!isOnboarded) return <Onboarding />;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: 'max(1.5rem, env(safe-area-inset-top)) 1.25rem 1.5rem',
        position: 'sticky',
        top: 0,
        backgroundColor: 'var(--bg-color)',
        zIndex: 10,
        transform: (showNav || newsView === 'reading') ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s',
        opacity: (showNav || newsView === 'reading') ? 1 : 0
      }}>
        {newsView === 'reading' ? (
          <button onClick={handleBackToHub} style={{ background: 'none', border: 'none', color: 'var(--text-main)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <ChevronLeft size={24} strokeWidth={1.5} />
          </button>
        ) : (
          <button onClick={loadHub} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', opacity: isLoadingFeed ? 0.3 : 1 }}>
            <RefreshCcw size={20} strokeWidth={1.5} className={isLoadingFeed ? 'lucide-spin' : ''} />
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h1 className="serif" translate="no" style={{ fontSize: '1.4rem', letterSpacing: '0.1em', color: 'var(--text-main)' }}>読書家</h1>
        </div>
        <button onClick={() => setActiveTab('settings')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <MoreVertical size={24} strokeWidth={1.5} />
        </button>
      </header>

      <main style={{ flex: 1, padding: newsView === 'reading' ? '1rem 1.25rem' : '0rem 1.25rem', maxWidth: '600px', margin: '0 auto', width: '100%' }}>
        {activeTab === 'news' && (
          newsView === 'hub' ? (
            <Feed 
              articles={articles.filter(a => !(dismissedArticleIds || []).includes(a.id))} 
              isLoading={isLoadingFeed} 
              isReplenishing={isReplenishing}
              onSelect={handleSelectArticle} 
              onDismiss={handleDismissAndSync}
              processingIds={processingArticles || []}
              cachedIds={Object.keys(articlesCache)}
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
      <BottomNav activeTab={activeTab} onChange={setActiveTab} isVisible={showNav} />
    </div>
  )
}

export default App
