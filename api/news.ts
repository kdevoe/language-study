export default async function handler(req: any, res: any) {
  const { topic } = req.query;
  const apiKey = process.env.VITE_NEWS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Missing VITE_NEWS_API_KEY in environment' });
  }

  try {
    const query = encodeURIComponent(topic || 'Technology startups');
    const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&language=en&pageSize=5&apiKey=${apiKey}`;
    
    // As a backend serverless function, NewsAPI will accept this request (bypassing browser CORS/localhost blocks)
    const response = await fetch(url);
    const data = await response.json();
    
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch news from generic fallback' });
  }
}
