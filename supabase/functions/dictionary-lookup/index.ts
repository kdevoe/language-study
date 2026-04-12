import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function groqComplete(prompt: string, jsonMode = false): Promise<string> {
  const apiKey = Deno.env.get('GROQ_API_KEY')!;
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: jsonMode ? { type: 'json_object' } : undefined,
    }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Groq error: ${err.error?.message || response.statusText}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { word, contextSentence, jmdictEntryId, type } = await req.json();

    if (!word) {
      return new Response(JSON.stringify({ error: 'word is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // type = 'definition' | 'grammar' | 'translation'
    if (type === 'grammar') {
      // Grammar insight using Gemini
      const geminiKey = Deno.env.get('GEMINI_API_KEY')!;
      const prompt = `Analyze the word "${word}" in this sentence: "${contextSentence}".
MANDATORY: Provide ONLY 1 SINGLE brief sentence in English explaining its specific usage or grammar in this context.
Be extremely concise.`;

      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent(prompt);
      const insight = result.response.text().trim();

      return new Response(JSON.stringify({ insight }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (type === 'translation') {
      // Sentence translation using Groq
      const prompt = `Translate this Japanese sentence into natural, elegant English: "${word}"
Context: "${(contextSentence || '').substring(0, 300)}"
Just provide the English translation, no other text.`;
      const translation = await groqComplete(prompt);
      return new Response(JSON.stringify({ translation }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Default: word definition using Groq (LLM fallback when JMDict has no match)
    const prompt = `Define "${word}" for context: "${contextSentence}".
CRITICAL: The "furiganaMap" MUST account for EVERY character in "${word}". Break it down 1:1.
Output JSON:
{
  "word": "${word}",
  "reading": "full reading",
  "meaning": "English translation",
  "furiganaMap": [ { "kanji": "...", "kana": "..." }, ... ]
}`;

    const text = await groqComplete(prompt, true);
    const definition = JSON.parse(text);

    return new Response(JSON.stringify(definition), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[dictionary-lookup] Error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
