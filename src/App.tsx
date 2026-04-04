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
        () => {} // Background processing
      );
      saveProcessedArticle(article.id, { ...article, blocks: rewrittenBlocks });
    } catch (e) { 
      console.error("Prefetch error:", e); 
    }
    setProcessing(article.id, false);
  }, [articlesCache, processingArticles, setProcessing, saveProcessedArticle]);

  // THE INFINITE PIPELINE: Automatically process the next available article
  const syncPrefetchQueue = useCallback(() => {
    if (articles.length === 0) return;
    
    // Find articles that aren't dismissed and aren't cached/processing
    const visibleArticles = articles.filter(a => !(dismissedArticleIds || []).includes(a.id));
    const nextCandidate = visibleArticles.find(a => !articlesCache[a.id] && !processingArticles.includes(a.id));
    
    // Only prefetch if we don't have at least ONE ready article already processed
    const hasReady = visibleArticles.some(a => articlesCache[a.id]);
    const isAlreadyWorking = processingArticles.length > 0;

    if (nextCandidate && (!hasReady || !isAlreadyWorking)) {
      handleProcessArticle(nextCandidate);
    }
  }, [articles, dismissedArticleIds, articlesCache, processingArticles, handleProcessArticle]);

  const loadHub = async () => {
    setIsLoadingFeed(true);
    try {
      const feed = await fetchNewsFeed('Japan News');
      setArticles(feed);
    } catch (e) { console.error(e); }
    setIsLoadingFeed(false);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setIsInitializing(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Proactive Prefetch on Boot/Feed Change
  useEffect(() => {
    if (articles.length > 0) syncPrefetchQueue();
  }, [articles, syncPrefetchQueue]);

  useEffect(() => {
    if (isOnboarded && session) {
      checkDailyKanji();
      if (articles.length === 0) loadHub();
    }
  }, [isOnboarded, session, checkDailyKanji, articles.length]);

  const handleSelectArticle = (article: NewsArticle) => {
    if (!article.id) return;
    
    useAppStore.getState().setCurrentArticle(null);

    if (articlesCache[article.id]) {
      setActiveArticle(articlesCache[article.id]);
      setNewsView('reading');
      setShowNav(false);
      // Trigger prefetch for the NEXT one after selecting
      setTimeout(syncPrefetchQueue, 500); 
    } else {
      handleProcessArticle(article);
    }
  };

  const handleDismissAndSync = (id: string) => {
    dismissArticle(id);
    // Explicitly check for next article to pull in after dismissal
    setTimeout(syncPrefetchQueue, 100);
  };

  const handleBackToHub = () => {
    setNewsView('hub');
    setShowNav(true);
    // Sync again when coming back
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

  if (!session) {
    return <LandingPage />;
  }

  if (!isOnboarded) {
    return <Onboarding />;
  }

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
