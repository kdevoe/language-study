# Yūgen Study

A Japanese language study platform that uses AI to rewrite real news articles into personalized Japanese reading practice, tailored to your JLPT grammar level, RTK kanji progression, and vocabulary mastery.

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Supabase (Auth, Postgres, RLS)
- **AI**: Google Gemini (article rewriting, grammar insights), Groq (fast dictionary lookups)
- **Dictionary**: JMDict-Simplified (216k+ entries with JLPT tagging)

## Setup

1. Copy `.env.example` to `.env` and fill in your API keys
2. `npm install`
3. `npm run dev`

### Database

Run the SQL files in `database/` in order (00–08) in the Supabase SQL Editor. Then run the import scripts:

```bash
node scripts/import_jmdict.cjs        # Import 216k JMDict entries
node scripts/enrich_jlpt.cjs          # Tag vocabulary with JLPT N1-N5
node scripts/enrich_kanji_jlpt.cjs    # Tag individual kanji with JLPT N1-N5
```

## Data Sources & Attribution

This project uses the following open data sources:

- **[JMDict](http://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project)** — Japanese-Multilingual Dictionary by the [Electronic Dictionary Research and Development Group (EDRDG)](http://www.edrdg.org/). Used via [jmdict-simplified](https://github.com/scriptin/jmdict-simplified). Licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **[KANJIDIC](http://www.edrdg.org/wiki/index.php/KANJIDIC_Project)** — Kanji database by the EDRDG. Licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **[JLPT Vocabulary Lists](https://github.com/jamsinclair/open-anki-jlpt-decks)** — Open-source JLPT N1–N5 vocabulary, community-maintained. Licensed under MIT.
- **[JLPT Kanji Levels](http://www.tanos.co.uk/jlpt/)** — JLPT kanji classification by Jonathan Waller, via [kanji-data](https://github.com/davidluzgouveia/kanji-data) (MIT license).
- **[Remembering the Kanji](https://en.wikipedia.org/wiki/Remembering_the_Kanji_and_Remembering_the_Hanzi)** — RTK ordering by James Heisig. Kanji ordering data used for study progression.

## License

Private — not open source.
