# Yugen Study — Design System
The reference for how the app looks and moves. Check new UI against it before building, and update it when a pattern changes. Values here are taken from the code (`src/index.css` and the components), not invented.

Interactive reference: `docs/mockups/podcast-create.html` shows the slider toggle, bottom sheet and create button below working together.

**Mockups must size things the way the app does.** Build a mockup's phone at a real phone size (390 × 844), and size each component with the same rule the code uses: the same max width, height cap and aspect ratio. Then carry those rules into the code, not just the font sizes. Text is in fixed rem, so a container that grows with the viewport changes the balance even when every font size matches. The study card was tuned on a fixed 296 × 470 card, but shipped sized by viewport height. On a phone it grew to about 315 × 612, with the text floating in white space (fixed in #175, §6.16). Before merging, compare one screenshot at phone size against the mockup.

* * *
## 1. Principles
The look comes from Japanese and Scandinavian minimalism. The ideas below (ma, kanso, shibui) come from that tradition.

- **Typography first.** Hierarchy comes from type size, weight and the serif/sans contrast, not from boxes, borders or colour. A screen should still read in greyscale.
  
- **Ma (間), meaningful empty space.** Spacing does the organising. Keep gaps tight inside a group and generous between groups, so the structure is readable without dividers or labels. Equal gaps everywhere means no grouping, and that reads as crowded.
  
- **Kanso (簡素), subtraction.** Every element must earn its place. Before adding a label, helper sentence, border or option, try removing something instead. Optional things stay quiet (a text link) until asked for.
  
- **Shibui (渋い), quiet over loud.** Muted, warm neutrals. No saturated accent colours and no "statement" buttons. Emphasis comes from contrast (white on the warm grey), never from a new hue.
  
- **One shape per job.** Don't stack many elements of the same width and shape. Vary width by importance: only the primary choice in a group runs full width.
  

* * *
## 2. Colour
All colour comes from the tokens in `src/index.css`. Don't add new hex values to components.

| Token | Value | Use |
|---|---|---|
| `--bg-color` | `#f5f5f0` | Page and sheet background |
| `--bg-pure` | `#ffffff` | Raised surfaces: the slider thumb, inputs that need a box, the ready create button, digest card |
| `--bg-card` | `#f0f0e8` | Cards, tags, soft filled areas (e.g. a paste box) |
| `--border-light` | `#e0e0d8` | Slider track, resting button, hairline rules, the rare border |
| `--text-main` | `#2d2d2d` | Body text, active labels |
| `--text-muted` | `#666666` | Secondary text, inactive labels, kickers |
| `--accent-primary` | `#d4e0e8` | Soft blue: badges, small highlights, and the progress edge on cards |
| `--accent-progress` | `#8fb0c4` | Muted slate blue: progress fills on a pale track (flashcard session bar, 目次 sheet). Too strong for a card edge |
| `--accent-success` | `#dee5d5` | Soft green: success *tints* only |
| `--accent-danger` | `#fde2da` | Soft coral: destructive or warning *tints* only |

Rules:

- **Accents are tints, never fills for primary actions.** A full green, olive or black primary button is off-theme (see §8).
  
- Ready, selected and active states are shown by **white + shadow on the warm grey**, the way the slider thumb does it, not by colour.
  
- Semantic colours for data, such as Progress mastery levels (`#5b8c5a` for "Easy"), belong to their charts and don't get reused as UI accents.
  

* * *
## 3. Typography
Fonts: **Shippori Mincho** (`--font-serif`) and **Inter** (`--font-sans`).

| Role | Font | Size and weight | Example |
| --- | --- | --- | --- |
| Tab title | serif | 2rem / 500 | 聴く, Settings |
| Reader title | serif | 2.5rem / 500, line-height 1.3 | Article headline |
| Card title | serif | 1.25rem / 500, line-height 1.5 | Episode and article cards |
| Sheet title | serif | 1.3rem / 600 | 新しいエピソード |
| Hero input | serif | about 1.35rem | The one thing a sheet asks for |
| Reading body | serif | 18px default (user setting), line-height 2.2 | Reader paragraphs |
| Kicker | sans | 0.6–0.62rem / 800, letter-spacing 0.15–0.2em, uppercase | LISTEN, DAILY DIGEST |
| Control label | sans | 0.85rem / 600, going to 700 when active | Slider options |
| Meta and secondary | sans | 0.72–0.8rem / 500, `--text-muted` | 約6分 · 昨日 |

- Japanese content and anything you'd "read" is serif. UI chrome (controls, kickers, meta) is sans.
  
- Labels in the action voice (完了, 続きを読む, 作る) are serif. They read as part of the page, not as a form.
  

* * *
## 4. Shape, depth and borders
**Radii in use:** `100px` (pills, sliders, buttons), `24px` (cards), `16px` (inputs, settings panels, filled boxes), `28px 28px 0 0` (sheets), `8px` and `4px` (small tags).

**Shadows: few and soft.** The canonical set:

| Use | Shadow |
| --- | --- |
| Slider thumb, selected chip | `0 2px 8px rgba(0,0,0,0.1)` |
| Card at rest | `0 4px 25px rgba(0,0,0,0.03)` |
| Lifted, ready button | `0 4px 14px rgba(0,0,0,0.1)`, then `0 6px 18px rgba(0,0,0,0.12)` on hover |
| Toast | `0 6px 30px rgba(0,0,0,0.12)` |
| Bottom sheet | `0 -10px 40px rgba(0,0,0,0.15)` |
| Study card (the one exception: lifted paper, §6.16) | `0 1px 2px` / `0 8px 18px` / `0 24px 48px`, `rgba(40,40,30,0.06–0.08)`, plus a ground shadow |

**Borders:** default to none. Use a 1px `--border-light` hairline only when a surface would otherwise vanish against its background (a card on the page, an input that needs a box). Prefer a **bottom hairline** over a full box for text inputs.

* * *
## 5. Motion
| Use | Easing |
| --- | --- |
| Controls (slider thumb, colour and weight changes, button ripen) | `0.4s cubic-bezier(0.4, 0, 0.2, 1)` |
| Chrome hide and show (header, nav) | `0.4s cubic-bezier(0.22, 1, 0.36, 1)` |
| Bottom sheet in and out (Framer Motion) | spring `stiffness: 400, damping: 40` |
| Content appearing | `.fade-in`: 0.3s ease-out, 4px rise |
| Press feedback | `scale(0.98)`, 0.1s |
| Study card flip (§6.16) | 0.6s `cubic-bezier(0.45, 0, 0.2, 1)`, no spring, 6px rise mid-turn |

Motion confirms an action; it never decorates. Nothing loops or bounces at rest (spinners while working are the exception).

* * *
## 6. Components
### 6.1 Slider toggle (the app's only choice control)
Source of truth: Settings (JLPT, Article Intensity, Vocab Use, Kanji Use).

- **Track:** `--border-light`, `border-radius: 100px`, `padding: 4px`, `height: 45px`, `position: relative`.
  
- **Thumb:** absolute, `top/bottom: 4px`, `left: calc(4px + i * (100% - 8px) / n)`, `width: calc((100% - 8px) / n)`, `--bg-pure`, shadow `0 2px 8px rgba(0,0,0,0.1)`, transition `all 0.4s cubic-bezier(0.4, 0, 0.2, 1)`.
  
- **Labels:** sans 0.85rem, 600 to 700, `--text-muted` to `--text-main`, colour transition on the same easing.
  
- **Width follows importance:** full width for a primary choice; a fixed compact width (about 200px for three short options) for a secondary one.
  
- Use it for every one-of-n choice: filters, source type, length. Don't use outlined or black pills for choices.
  

> Status: copied four times inside `Settings.tsx`. It should become one shared `SliderToggle` component (with Settings migrated to it).
### 6.2 Bottom sheet
- Backdrop `rgba(45,45,45,0.35)` (tap closes); sheet `--bg-color`, radius `28px 28px 0 0`, padding `1.5rem 1.5rem calc(2.2rem + env(safe-area-inset-bottom))`, max-width 600px, grabber bar 36×4px `--border-light`.
  
- **Locks page scroll** while open: `useScrollLock(open)` from `src/hooks/useScrollLock.ts`.
  
- **Layout = groups, not a list:** title, then _what_ (primary choice + hero input), then _optional_ (quiet link), then _go_ (secondary choice + action on one row). Tight inside groups, generous between them.
  
- **Stable height:** a pane that changes with a choice (topic, text or URL) has one fixed height, so the sheet and the rows below never move.
  
- **No helper copy** that restates the obvious (timing notes, field labels that repeat the placeholder). Show validation text only when the input is invalid.
  
### 6.3 Create / primary action button
- **Resting (not yet possible):** `--border-light` fill, `--text-muted`, about 0.7 opacity, no shadow.
  
- **Ready:** becomes the slider thumb: `--bg-pure`, `--text-main`, weight 700, `translateY(-1px)` and shadow `0 4px 14px rgba(0,0,0,0.1)`; hover lifts a little more; press settles to `scale(0.98)`.
  
- Serif label, compact (`height: 45px`, auto width), placed at the right end of the sheet's _go_ row.
  
- Not black, not green, not full width.
  
### 6.4 Text inputs
- **Hero input** (the one thing a sheet asks for): no box, transparent, bottom hairline `--border-light` that darkens to `--text-muted` on focus, serif about 1.35rem.
  
- **Multi-line paste:** a soft `--bg-card` filled box, radius 16px, no border.
  
- **Optional input:** hidden behind a `＋ label` text link, which swaps for an underline field in the same reserved slot.
  
- **Suggestions:** plain serif text buttons in `--text-muted`, no outline.
  
### 6.5 Cards
Same as the Feed's news card: `--bg-card`, radius 24px, padding `1.5rem`, 1px `--border-light`, shadow `0 4px 25px rgba(0,0,0,0.03)`. Kicker tag at top-left, one plain status at top-right, serif title at 1.35rem. Nothing below the title: no meta line, no progress bar. The top-right is a **progress ring** (`ProgressRing` in `ArchiveList.tsx`, mockup `docs/mockups/progress-ring.html`, variant 1 · INK): the total alone, with no unit (a work's parts, `4`; a podcast's minutes, `12`), in sans 0.68rem 700 `--text-muted`, inside a 26px hairline ring (1.5px `--border-light` track). An arc in `--text-muted` at 55% fills clockwise from 12 o'clock with overall progress (a work's `readingPosition.percent`, a podcast's listen position) and eases 0.6s when it changes. Only a finished item closes it: in-progress arcs stop at 97%. Finished, the track drops away, the closed ring shifts to `--accent-progress` and the number fades to 60%, so done recedes. The spoken label keeps the old text (`2 / 4部`, `4 / 12分`). Home's card uses the same 26px ring. Long-form works carry no tag; their ring then floats at the title's top right and the title wraps around it, so only the first line gives up room. Titles stop at three lines with an ellipsis (two on Home). Single-part works get a ring too.
### 6.6 Toast
Fixed at the top centre, `--bg-card`, radius 14px, 1px `--border-light`, shadow `0 6px 30px rgba(0,0,0,0.12)`, 0.85rem, tap to dismiss, auto-hides after about 5s. Keep messages to a few words (聴くタブで作成中).
### 6.7 Icon buttons
Lucide icons, stroke width 1.5, 20–24px, `--text-muted` at rest, no background. An icon can show a "done" state by darkening to `--text-main`.
### 6.8 Archive list (LISTEN, 読む's LIBRARY)
Source of truth: `src/components/ArchiveList.tsx`, mockup `docs/mockups/archive-organize.html`.

- **Months, not filters.** The newest month is the list itself: its items sit straight under the search row with no heading and are always open. Older months group under a serif month heading (year in small muted sans for any month but the current one) with the count and a chevron at the right, collapsed to start; a collapsed month shows one muted summary line (`4本 · 未再生 2`). The newest month's heading appears only while searching or selecting (for すべて選択).
  
- **Search** is a hero input on a hairline under the page heading (§6.9), matching Japanese and English. Results stay grouped by month with every month open, under a muted `n件`. A hit in body text adds a short excerpt marked `EN` / `JA`, the match tinted `--accent-primary`.
  
- **Swipe left to delete** (the Feed's gesture): a `--accent-danger` panel with a serif 削除 is revealed behind the card; a long swipe deletes outright. One row open at a time.
  
- **Long-press (0.5s) to select.** The header becomes `n件を選択` + 完了, each card's status corner becomes a check circle, selected cards turn white with the thumb shadow, and an action bar (count + coral 削除) covers the bottom nav. Months offer すべて選択.
  
- **Undo, not confirm.** Deletes hide at once and reach the server after a 5s toast with 元に戻す (§6.6).
  
- The `+` sits in the page heading, just left of the settings mark: a plain Lucide `Plus` matching the mark (22px, stroke 1.25, `--text-muted`, 44px hit area), not a lifted circle. The search row runs full width.
  
### 6.9 Page heading (tab pages)
Source of truth: `src/components/PageHeading.tsx`, mockup `docs/mockups/top-row.html` (見出しに統合).

- **No global header on tab pages.** Each tab opens with one serif title (2rem) in one language. Nothing sits above it but the status bar.
  
- The **settings mark** sits only on Home (§6.12), at the right of its title: thin slider lines (stroke 1.25, `--text-muted`, 44px hit area), not a gear or ⋮. The other tabs show no settings mark.
  
- Right-edge heading icons (settings on Home, `+` on 番組 and 本棚) have their icon centre 17px in from the content edge. Page actions sit in the heading row, never stacked under it.
  
- The first content after the heading starts 1.6rem below it (the heading's 1rem margin plus 0.6rem on Home and 読む's ニュース; the search row's margin on the archive pages).
  
- **Title switch** (mockup `docs/mockups/title-type.html`, #1): a tab with several pages sets them all in the title row instead of a segment, as 読む (ニュース | 本棚) and 聞く (番組 | 音楽) do. They stay in a fixed order on one baseline: the active page at 2rem, the others at 1.2rem and half opacity, 0.95rem apart, with no hint dot. Tapping a small title switches to that page (landing at the top); tapping the active one opens its word card as usual. Page actions follow the active page (`+` on 本棚 and 番組 only).
  
- The page's own controls sit directly below: search (本棚, 番組), the 復習 | 進捗 segment (REVIEW, the shared `Segment` component: serif labels on a `--bg-card` pill, the active one on white).
  
- **Reading surfaces** (Reader, podcast player) keep a fixed row with only the back arrow; it hides on scroll with the nav.
- **Podcast player transport:** speed pill, ⟲10 / ⟳10 skip buttons (circular arrows with the seconds inside, 30px), the round play button, 耳で聴く. Opening an episode starts it playing from the saved position; the opening tap unlocks the app's one shared audio element (`services/sharedAudio.ts`), which music will use too.
  
- Never a bilingual kicker + title pair.
  
### 6.10 Adaptive labels
Source of truth: `src/services/uiLabels.ts`, `src/components/AdaptiveLabel.tsx`, keyframes in `src/index.css` (`.ui-sw`).

- Page titles, bottom-nav labels and the search placeholder are **English by default** and turn **Japanese when the reader actually learns the word** (marked easy in the word database). Vocabulary, not JLPT level, drives it. The switch is sticky.
  
- A label can have **stages**: LIBRARY becomes 本棚, then 書庫 once that word is learned too. A stage can also wait for a kanji: LISTEN becomes 聞く, then 聴く once 聴 is within the reader's RTK progress (one JMDict entry, so the kanji is the signal). Each step plays the same event.
  
- **Tap a page title** to open its word card (the first Japanese word while the title is English, else the one shown). Label words like 本棚 rarely appear in articles, so this is where they get met and graded.
  
- The **switch is an event**, played once per label on its page title when it's on screen, one at a time (about 4.5s): a soft `--accent-primary` glow rises and the English brightens (0–1.2s); the English dissolves upward while the Japanese emerges blurred and widely spaced and comes into focus (1.2–3.2s); a small settle as the glow fades (3.2–4.5s). **No English caption afterwards.** Reduced motion gets a 0.6s crossfade.
  
- Nav labels follow the title's switched state without an event; the search placeholder switches quietly. Nav labels are uppercase sans at 0.6rem in English and 0.78rem in Japanese (kana and kanji aren't legible smaller), in a fixed 1rem line so the nav doesn't change height when a label switches. Japanese words that open on a dense kanji and close on a light kana (読む, 聞く, 聴く) are nudged 1.5px right so they look centred under the icon; the rule is per word (`.nav-label [data-word]` in index.css), so English and balanced words (ホーム, 復習) aren't touched.
  
- Settings → Interface Language overrides it: English / Adaptive / 日本語.
  
- Japanese labels: ホーム, 読む, ニュース, 本棚 → 書庫, 聞く → 聴く, 番組, 音楽, 復習, 検索, 設定. ニュース | 本棚 and 番組 | 音楽 are the page titles of 読む and 聞く (title switch, §6.9); 番組 stands in for ポッドキャスト, which is too long for it. A new label should carry its JMDict entry id in `UI_LABELS`; until it's verified (ホーム, 読む, 番組, 音楽), the word is matched by surface and a title tap looks it up by text.
  
### 6.11 Long-form part navigation
Source of truth: `src/components/PartsSheet.tsx` and the part section of `Reader.tsx`, mockup `docs/mockups/longform-section-nav.html`.

- **One entry point:** the Reader's `第N部 / 全M部` meta text, with a 13px chevron, opens the **目次** sheet (§6.2). Nothing else is added to the top of the reader.
  
- **目次 rows:** `第N部` in small sans, the part's opening line in serif (part rows all carry the work title, so the opening line is what tells them apart), and a state at the right. The current part is white with the thumb shadow; parts already read are muted with a check; the しおり part has a small `--accent-progress` dot.
  
- **Parts generate in order** (each needs the previous part's continuity), so only the first missing part can be started (準備する → 準備中). Parts after it are faded to 0.42 and inert. A failed part shows もう一度 on an `--accent-danger` tint.
  
- **しおり = the furthest point read.** Position saves only move it forward; an earlier part opens at its top; tapping the しおり part resumes mid-part. While reading behind it, a white pill **しおりに戻る** (toast shadow) sits at the bottom centre, hidden once the part's end is on screen.
  
- **End of a part:** 続きを読む stays the main action; under it (and under 完了 on the last part) quiet serif links **前の部** and **目次**.
  

* * *

### 6.12 Home
Source of truth: `src/components/Today.tsx`, mockups `docs/mockups/home-today.html`, `home-music-polish.html`.

- **Tabs:** Home · 読む · 聞く · 復習 (Home's icon is Lucide `house`; its Japanese label is ホーム, was 今日). The app opens on Home. 読む holds the news feed and the 本棚, 聞く the 番組 (podcasts) and 音楽 (songs, §6.13), each behind a title switch (§6.9).
  
- **What's waiting today, in order:** cards due (one white row: count in serif 1.8rem on the left, 始める › on the right; no 新 / 復習 split; with a kanji deck, two counts side by side, `12 単語  3 漢字`, the deck name in muted serif 0.85rem); 本棚 (the last-opened work in progress, as an archive card); 聞く (a ready, unplayed podcast: title over the adaptive 番組 label, with the play circle); 音楽 (the list last played on this device, すべての曲 included, else the last one added to: a 58px collage, name and `n曲 · 約m分`, and the play circle; the row opens the list, the circle plays it from the top); ニュース (two headlines as plain text, no card, inset 1.5rem so they start on the cards' text edge; すべて opens 読む). One type system on this page: every item title (本棚 card, 聞く row, 音楽 list, news headline) is serif 1.2rem at two lines max with an ellipsis; every small label (番組, list count, news category) is sans 0.74rem 700 at 0.06em; actions (始める, すべて) are serif 1.02rem; only the 復習 count is larger (1.8rem). The 本棚 card here uses `CardBody compact`, so the 本棚 page keeps its 1.35rem titles. Every block is marked by its tab's icon alone (復習 layers, 本棚 book, 聞く headphones, 音楽 music note, ニュース newspaper) at 19px in `--text-muted`, with no label text; the word stays as the icon's accessible name (the page's adaptive label where there is one). Each icon is a button (padded to a ~40px tap target) that opens its block's page: 復習 → Review, 本棚 → 読む's 本棚, 聞く → 番組, 音楽 → 音楽, ニュース → 読む's ニュース. Text inside a block that names a page uses that page's adaptive label (番組), so it reads the same as the page it opens. Each kind keeps its own shape (a card for reading, a play row for audio, plain text for news) so the page doesn't read as one list.
  
- **Play circle** (`PlayCircle` in `MusicParts.tsx`): a white `--bg-pure` circle with the thumb shadow and a filled `--text-main` triangle; 44px on Home's rows, 56px as a list page's 再生. Never a pill with ▶ text.
  
- **Each block is a shortcut into the tab that owns it,** never a copy. A block with nothing to show is left out, the review card included when nothing is due; whichever block shows first sits right under the heading.
  
- Section kickers are 0.7rem sans, 600, `--text-muted`, 2rem above their block. **No stats, streaks or charts**: those belong in 進捗.
  
- No date beside the title.

### 6.13 音楽 (songs)
Source of truth: `src/components/Music.tsx`, `SongSheet.tsx`, `SongPlayer.tsx`, `PlaylistPage.tsx`, `AddToListSheet.tsx`; mockups `docs/mockups/music.html`, `music-playlists.html` (option 3), `music-lists.html`.

- **Grid:** two columns of square covers (16px radius, the card shadow), newest first. Under each: the title, serif 1.05rem at two lines max, over the style label in the small-label style (sans 0.68rem 700, 0.06em). An in-flight song shows its stage (作詞中… / 作曲中…) with the olive spinner; a failed one shows 再試行. Empty state: まだ曲がありません, one hint line and a 曲を作る button (§6.3).
  
- **Long-press a tile** and it splits: リストに追加 (white) over 削除 (`--accent-danger` tint). The delete waits 5s behind a 元に戻す toast (undo, never confirm). Tapping a cover plays it, then carries on through the grid.
  
- **Kickers and ＋:** リスト and 曲 are sans 0.82rem 600 `--text-muted`. The page heading has no ＋: making a song is the ＋ at the right end of the 曲 row (Lucide `Plus`, 20px, stroke 1.4, 40px hit area), so it reads as “make a song”; lists have their own tile.
  
- **Lists (リスト):** a shelf above the grid (kicker リスト; the grid's kicker is 曲). Each list is a 116px 2×2 collage of its first four covers, the name (serif 0.95rem) and a count, scrolling sideways. It opens with the built-in **すべての曲** (every song, newest first; can't be edited or deleted) and ends with a `--bg-card` ＋ 新しいリスト tile. User lists come last used first. Long-press a list for 削除 (undo toast).
  
- **リストに追加 sheet** (§6.2): every add goes through it, whether from the player's back row or a long-pressed cover. The song, then the lists as pick rows (white + check = in it; transparent at 50% = not), in the order they had when the sheet opened. Tapping a list adds the song: the row lifts, the sheet closes after about half a second, and a toast names the list with 元に戻す. Tapping a white row removes the song and the sheet stays. ＋ 新しいリスト swaps in place for the hero name field, with the song's theme and style as suggestions; 作る makes the list with the song in it.
  
- **A list's page:** back chevron, 168px collage, name (tap to rename in place), `n曲 · 約m分`, then the 56px play circle (再生) with a quiet シャッフル icon beside it (Lucide `shuffle`, 19px, muted). Songs as rows (48px cover, title, style, length, grip): drag the grip to reorder, swipe left to take one out (外す, undo toast). ＋ 曲を追加 opens the **picker**: the covers with §6.8 check circles (picked ones lift), and an action bar over the nav with the count and 追加. A new list from the shelf is a name sheet, then the picker.
  
- **New-song sheet:** the §6.2 sheet with PodcastSheet's three groups: スタイル | 自分で slider, then the style chips (serif 0.92rem; the picked one lifts like the slider thumb) or a description box, in one fixed-height pane so switching never moves the sheet; ＋ テーマ swaps for its field in the same slot; 1/2/3分 slider + 作る.
  
- **Player** (mockup `docs/mockups/lyrics.html`, phone B): the whole page turns soft blue (`--accent-primary`, via `body.song-mode`, which also tints the back row and the browser's theme colour). Cover, title and style open big; as the page scrolls they shrink into the back row beside the chevron and pin there. Lyrics are bold serif (700, 1.5rem) in two colours: sung so far in `--text-main`, still to come in pale ink `#728997` (`--accent-progress` with 30% `--text-main`, 2.7:1 on the blue; white was too faint, see `docs/mockups/lyrics-contrast.html`); ♪ marks the gap between sections. The page scrolls itself to keep the sung line about 40% down. Words are tappable like the reader (the song pauses). Controls are the podcast player's: speed, ⟲10 / ⟳10, play, and リピート, which cycles リピート → 1曲 → 全部 (off, this song, the whole queue).
  
- **Queue:** the player plays through whatever the song was started from (the grid or a list). The pinned back row's right end holds the リストに追加 icon (Lucide `list-plus`, muted; `list-check` in `--text-main` once the song is in a list) and the position `3 / 8`. Playing from a list, its name replaces the style under the title. After the lyrics and words comes **次の曲**: the next song as a row, the one after smaller and at 55%; tap one to jump. When a song ends, a soft-blue handoff shows the next cover and title with a 3-second ring (tap it to go now) and 止める to stay. With the screen locked it goes straight on. Lock-screen next and previous follow the queue.

### 6.14 Settings
Source of truth: `src/components/Settings.tsx`, mockup `docs/mockups/settings.html`.

- **Four plain sections,** no boxes: 学習 (JLPT, new words/day, RTK), 読む (topics, intensity, length, vocabulary, kanji), 聞く (songs, song styles, podcast hosts), 表示 (interface, text size, weight). Section titles are serif 1.3rem 600, 3rem apart; spacing does the grouping.
  
- **A setting** is a label (sans 0.85rem 600, value or unit in a muted `small` on the right) over its control, with at most one hint line (0.75rem muted). Numbers use the round −/+ stepper; a long range (RTK) also takes a typed number.
  
- **Pick lists** (song styles, hosts): one row each, serif name + optional muted tag + a one-line description. White row (`--bg-pure`, soft shadow) = on, transparent at 50% = off; tap the row to switch it. The heading carries an "N of M" count. A list keeps its minimum (one style; two hosts, one of them 標準語) by ignoring the tap that would break it.
  
- **Editing in place:** 編集 on a host opens its personality as a serif underline textarea in the row, with 元に戻す (restore the original) and 保存 (serif 0.8rem, 保存 in `--text-main`).
  
- **One editable text** (the song cover's art direction) is a single white row with its text and 編集, plus a muted "Default" / "Your own" count in the heading. It uses the same in-place editor.
  
- **詳細** (serif, muted, centred, chevron) at the bottom holds the one-off maintenance tools, the sandbox switch and the danger zone, unchanged.

### 6.15 Grammar in the reader
Source of truth: `src/components/WordModal.tsx` (grammar mode), `src/services/grammar/`, mockup `docs/mockups/grammar.html`.

- **No marks on the page.** Grammar is found by tapping, as words are. The piece you tap decides the panel: a word opens the word panel; a grammar piece (ば, なりません, ので, います), or a word wholly inside a point (前 in 〜前に), opens the grammar panel, with "As a word: …" when the piece is also a word.
  
- **While a point is open** its whole span is lit in the text (`.grammar-lit`, `--accent-primary`, radius 3px), across token boundaries.
  
- **Word panel:** the AI box is labelled INSIGHT; below its text, a PATTERNS divider lists the points the word takes part in.
  
- **Point rows** (PATTERNS, the 。 sheet's "GRAMMAR · n IN THIS SENTENCE"): 6px `--accent-progress` dot (hollow once EASY), serif pattern, olive N-level, muted one-line meaning, chevron. A row opens the point on top, with ‹ back.
  
- **Grammar panel order:** GRAMMAR kicker, serif pattern (2.1rem), N-level + meaning, the EASY / MEDIUM / HARD slider, GRAMMAR INSIGHT (AI, about this sentence), この文では (the sentence with the span marked), HOW IT'S BUILT (slots as small white chips), 使い方, 例 (marked like この文では), then the formal/casual partner and As a word links. Reversed when the panel drops from the top, like the word panel.
  
- **Height:** the panel's cap rises from 52% to 70% when it shows grammar (an open point, PATTERNS rows, or a sentence's points), and still never covers the tapped word.
  
### 6.16 Flashcards: deck rows, the study card and the grade slider
Source of truth: `src/components/Review.tsx`, `Flashcards.tsx`, `KanjiFlashcards.tsx`, `StudyCard.tsx`, `GradeSlider.tsx`, the `.study-*` rules in `index.css`, mockups `docs/mockups/kanji-deck.html` and `flashcard-feel-2.html` (variant C).

- **Proportions.** The card keeps the mockup's 296 × 470 shape (`aspect-ratio`, width up to 340px), capped at 62vh (74vh in focus mode) on short screens. Don't size it by viewport height alone: on a tall phone that stretched it into a column of white space around the fixed-size text.
  
- **The study card is lifted paper.** It's the one surface allowed real depth: no border, three stacked soft shadows (`0 1px 2px / 0 8px 18px / 0 24px 48px`, warm ink `rgba(40,40,30,…)` at 0.06–0.08), and a separate blurred ellipse on the "table" under its bottom edge. That ground shadow paints **behind** the card, never over its face. The cards still to come wait underneath: up to two, bottom-anchored at `12px / 0.95` and `22px / 0.9` (75% opacity), and the pile thins as the session goes.
  
- **It moves only when touched, and quietly.** Press: it sinks to `scale(0.985)`, 1px down, and the shadow tightens (0.18s). Flip: it turns evenly in 0.6s `cubic-bezier(0.45, 0, 0.2, 1)`, **no spring**, rising 6px and growing about 1% mid-turn while the ground shadow softens. Move on: it drifts up 24px as it fades (0.34s), straight up, no sideways throw or tilt. The pile moves up one place underneath, so the next card is already there. Reduced motion drops the rise and the press. **Don't** add idle drift, springs or a bigger lift; the user tried them and they read as too much.
  
- **Card back layout.** Content centres in the space above the slider (padding `1.6rem` top, `1rem` above the slider). Kanji back: kanji 7.2rem, keyword 1.2rem (0.6rem below), readings 0.8rem (0.8rem below), components 0.72rem (0.35rem below), known words 1.1rem with 1.2rem between them (1.6rem below), the whole block nudged up 6px.

- **Deck rows.** With an RTK kanji deck, 復習 opens on two rows, 単語 and 漢字. Each is a white card (radius 24px, hairline, card shadow): serif 1.4rem name over a muted 0.75rem line (`vocabulary · 3 new today`, `RTK · #727–729 new today`), and the due count in serif 1.8rem over a small DUE. The 復習 badge is the sum. Tapping a row replaces the heading and segment with `‹ 単語` / `‹ 漢字` (serif 2rem, muted chevron back) and **enters focus mode at once**: the bottom nav is gone before the first card is tapped. The ✕ in the progress row, or a tap beside the card, brings it back, and it returns by itself at the finish. Finishing 漢字 offers 単語へ (lifted white button). Without a kanji deck, 復習 is the vocab deck as before.
  
- **New cards are mixed in, not saved for the end.** In both decks, today's new cards are spread evenly through the due reviews (`mixNewCards` in `services/deck.ts`). With 9 reviews and 3 new, a new card comes every 3 or so, and the run opens and closes on reviews.
  
- **もう一度 comes back in the same run.** A card graded もう一度 returns after 3 other cards (or last, if fewer are left), labelled AGAIN in the progress row. The repeat is practice only: the first もう一度 already set the schedule. A second grade the same day would undo it (new card: もう一度 then 正解 five minutes later gave 3 days, the same as never failing). The repeat isn't logged and doesn't count in the finish total.
  
- **Late arrivals join the run.** The app-open sync and the daily new-card drip can land after a session is open, and an opened session stays mounted. Cards that become due join the part of the run still ahead: new reviews go to the end, and new cards are spread through what's left. The card on screen and everything before it never move. Today's new kanji used to wait until the reviews were done and the deck was reopened.
  
- **Grade slider.** Both decks grade with the slider toggle's shape (§6.1): もう一度 · 難しい · 正解 · 簡単 in serif 0.84rem, track 44px high, inset 1.1rem from the card's sides and **1.6rem up from its bottom edge**. It arrives already set to a grade guessed from the thinking time: quick means 簡単, normal 正解, slow 難しい, measured against the user's own median. It never starts on もう一度. **One tap moves on either way.** Tap the card to keep the suggested grade, the same gesture that flipped it. Or tap a grade: the thumb slides there and, 260ms later, the card moves on with that grade. Tapping another grade inside that beat re-aims it, and a card can only be graded once. Nothing under the track: the `次は 3ヶ月` / `タップで次へ` caption was removed, and "tap to move on" is left to tutorial mode.
  
- **History:** the first slider only moved the thumb (a setting) and needed a card tap to commit. With the suggested grade in place, the user asked for the grade tap to commit too, to save the extra tap (2026-10-17). Don't bring back coloured grade pills for reviews. Discover's Hard / Medium / Easy triage pills are a different job and stay.
  
- **Kanji card.** Front: the keyword, serif 2.3rem. Back (sizes above): the kanji, keyword, 音 / 訓 readings (muted sans label, serif value), components (muted), then up to three known words with furigana and a one-line meaning. No rule above them, no title, no stroke count, no Heisig number.
  
### 6.17 ハルカ (the tutor)
Mockup: `docs/mockups/tutor.html`. Components in `src/components/tutor/`, styles under `.tutor-*` in `index.css`.

- **Side panel, not a sheet.** Slides in from the hand side (right by default, left in Settings), 88% wide (max 420px), full height, `--bg-color`, radius 28 on the inner corners, shadow toward the screen. The screen stays visible beside it under a 35% dim. A short vertical grabber sits on the inner edge; swipe back toward the edge or tap the dim to close.
- **Ways in.** Swipe in from the hand-side edge (the touch must start in a 16px strip; the panel follows the finger and commits past 70px). A faint 4×46px mark on that edge shows it's there. In a Safari tab, drag up on the bottom nav. The pinned Home card. ハルカに聞く in the word, grammar and 。sentence panels. **Never sentence long-press**: long-press is furigana.
- **Home card.** First thing under the 今日 heading: a `--bg-card` card with a light border, radius 24, a small ハ avatar + ハルカ label, then her line in serif 1.2rem, at most 3 lines. Before you've talked today it's the opener from last night's brief, and tapping it (or swiping in on Home) opens with that line as her first message. Once today's conversation is going it's her last line (asides dropped), and tapping it picks the conversation back up. After 終わる it goes back to the opener. No 話す link: keep it short.
- **Context chip** only when there's something specific (an article paragraph, a word, a card, an episode line). None on Home or list pages. The chip can be tapped away, and then the context isn't sent.
- **Messages.** Hers: serif 1.05rem, line-height 1.95, words tappable (same word panel as the Reader), long-press furigana. Recasts: the corrected words on `--accent-primary`, one tap target; a tap opens a note under the line, styled like an aside ("You wrote 「…」 — why"), from the tag's `was`/`why`. Asides (explanations, English by default): sans 0.8rem muted, 2px `--accent-primary` left rule. Yours: a `--bg-card` bubble on the right. Until her reply starts, three 6px `--text-muted` dots breathe in turn where it will appear (still under reduced motion). Suggestions are quiet serif text, not pills. The input is a bottom-ruled line, with no box. Its return key is labelled send (`enterkeyhint`). While the keyboard is up the panel loses its bottom corner and runs behind iOS's form bar, which web pages can't hide.
- **Recap** (終わる): 今日の会話, then 直したところ (struck-through original → better, a sans note), 新しい単語 rows with ＋ デッキ (lift to white when added), 使えた単語 with a ✓. 完了 is the white pill.
- **Audio pauses** while the panel is open and resumes when it closes.
- **Flashcards are front-only** until flipped: she gives hints, not the answer.
  
## 7. Copy
- Short. Prefer one word to a sentence. Chrome labels (titles, tabs) follow §6.10; content and in-page controls are Japanese.
  
- No sentences explaining what a control obviously does. If a control needs explaining, redesign the control.
  
- Empty states: one line of title and at most one short line of hint.
  

* * *
## 8. Known drift (fix when touching these areas)
- **Olive** `#4a5d23` is hard-coded about 33 times (READY labels, progress bars, spinners) and isn't a token. Decide whether it becomes a token (`--accent-olive`) or moves to the neutral and soft-blue system.
  
- **Black primary actions:** the Library import button uses a `--text-main` fill (the Listen and Library `+` buttons are fixed, §6.8).
  
- **Two toggle styles:** REVIEW's 復習 | 進捗 control (serif, `--bg-card` track, no sliding thumb) differs from the slider toggle.
  
- **Outlined black-fill pills** remain in the Library import sheet (貼り付け | URL) and should become the slider toggle. (The Library and Listen filter rows are gone, replaced by §6.8.)
  
- **Slider duplication** in `Settings.tsx` (§6.1).
