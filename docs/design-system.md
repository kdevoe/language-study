# Yugen Study — Design System
The reference for how the app looks and moves. Check new UI against it before building, and update it when a pattern changes. Values here are taken from the code (`src/index.css` and the components), not invented.

Interactive reference: `docs/mockups/podcast-create.html` shows the slider toggle, bottom sheet and create button below working together.

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
Same as the Feed's news card: `--bg-card`, radius 24px, padding `1.5rem`, 1px `--border-light`, shadow `0 4px 25px rgba(0,0,0,0.03)`. Kicker tag at top-left, one plain status at top-right, serif title at 1.35rem. Nothing below the title: no meta line, no progress bar. The top-right says where you are, nothing more: `2 / 4` (part read / total) for a long-form work, `4 / 12分` for a podcast in progress (just `12分` before it starts). Long-form works carry no tag; their count then floats in the corner beside the title instead of taking a row, and a single-part work shows no count.
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
  
- The **settings mark** sits only on 今日 (§6.12), at the right of its title: thin slider lines (stroke 1.25, `--text-muted`, 44px hit area), not a gear or ⋮. The other tabs show no settings mark.
  
- Right-edge heading icons (settings on 今日, `+` on 番組 and 本棚) have their icon centre 17px in from the content edge. Page actions sit in the heading row, never stacked under it.
  
- The first content after the heading starts 1.6rem below it (the heading's 1rem margin plus 0.6rem on 今日 and 読む's ニュース; the search row's margin on the archive pages).
  
- **Title switch** (mockup `docs/mockups/title-type.html`, #1): a tab with several pages sets them all in the title row instead of a segment, as 読む (ニュース | 本棚) and 聞く (番組 | 音楽) do. They stay in a fixed order on one baseline: the active page at 2rem, the others at 1.2rem and half opacity, 0.95rem apart, with no hint dot. Tapping a small title switches to that page (landing at the top); tapping the active one opens its word card as usual. Page actions follow the active page (`+` on 本棚 and 番組 only).
  
- The page's own controls sit directly below: search (本棚, 番組), the 復習 | 進捗 segment (REVIEW, the shared `Segment` component: serif labels on a `--bg-card` pill, the active one on white).
  
- **Reading surfaces** (Reader, podcast player) keep a fixed row with only the back arrow; it hides on scroll with the nav.
  
- Never a bilingual kicker + title pair.
  
### 6.10 Adaptive labels
Source of truth: `src/services/uiLabels.ts`, `src/components/AdaptiveLabel.tsx`, keyframes in `src/index.css` (`.ui-sw`).

- Page titles, bottom-nav labels and the search placeholder are **English by default** and turn **Japanese when the reader actually learns the word** (marked easy in the word database). Vocabulary, not JLPT level, drives it. The switch is sticky.
  
- A label can have **stages**: LIBRARY becomes 本棚, then 書庫 once that word is learned too. A stage can also wait for a kanji: LISTEN becomes 聞く, then 聴く once 聴 is within the reader's RTK progress (one JMDict entry, so the kanji is the signal). Each step plays the same event.
  
- **Tap a page title** to open its word card (the first Japanese word while the title is English, else the one shown). Label words like 本棚 rarely appear in articles, so this is where they get met and graded.
  
- The **switch is an event**, played once per label on its page title when it's on screen, one at a time (about 4.5s): a soft `--accent-primary` glow rises and the English brightens (0–1.2s); the English dissolves upward while the Japanese emerges blurred and widely spaced and comes into focus (1.2–3.2s); a small settle as the glow fades (3.2–4.5s). **No English caption afterwards.** Reduced motion gets a 0.6s crossfade.
  
- Nav labels follow the title's switched state without an event; the search placeholder switches quietly. Nav labels are uppercase sans at 0.6rem in English and 0.78rem in Japanese (kana and kanji aren't legible smaller), in a fixed 1rem line so the nav doesn't change height when a label switches.
  
- Settings → Interface Language overrides it: English / Adaptive / 日本語.
  
- Japanese labels: 今日, 読む, ニュース, 本棚 → 書庫, 聞く → 聴く, 番組, 音楽, 復習, 検索, 設定. ニュース | 本棚 and 番組 | 音楽 are the page titles of 読む and 聞く (title switch, §6.9); 番組 stands in for ポッドキャスト, which is too long for it. A new label should carry its JMDict entry id in `UI_LABELS`; until it's verified (今日, 読む, 番組, 音楽), the word is matched by surface and a title tap looks it up by text.
  
### 6.11 Long-form part navigation
Source of truth: `src/components/PartsSheet.tsx` and the part section of `Reader.tsx`, mockup `docs/mockups/longform-section-nav.html`.

- **One entry point:** the Reader's `第N部 / 全M部` meta text, with a 13px chevron, opens the **目次** sheet (§6.2). Nothing else is added to the top of the reader.
  
- **目次 rows:** `第N部` in small sans, the part's opening line in serif (part rows all carry the work title, so the opening line is what tells them apart), and a state at the right. The current part is white with the thumb shadow; parts already read are muted with a check; the しおり part has a small `--accent-progress` dot.
  
- **Parts generate in order** (each needs the previous part's continuity), so only the first missing part can be started (準備する → 準備中). Parts after it are faded to 0.42 and inert. A failed part shows もう一度 on an `--accent-danger` tint.
  
- **しおり = the furthest point read.** Position saves only move it forward; an earlier part opens at its top; tapping the しおり part resumes mid-part. While reading behind it, a white pill **しおりに戻る** (toast shadow) sits at the bottom centre, hidden once the part's end is on screen.
  
- **End of a part:** 続きを読む stays the main action; under it (and under 完了 on the last part) quiet serif links **前の部** and **目次**.
  

* * *

### 6.12 今日 (home)
Source of truth: `src/components/Today.tsx`, mockup `docs/mockups/home-today.html`.

- **Tabs:** 今日 · 読む · 聞く · 復習. The app opens on 今日. 読む holds the news feed and the 本棚, 聞く the 番組 (podcasts) and 音楽 (a 近日公開 placeholder for now), each behind a title switch (§6.9).
  
- **What's waiting today, in order:** cards due (one white row: count in serif 1.8rem on the left, 始める › on the right; no 新 / 復習 split); 本棚 (the last-opened work in progress, as an archive card); 聞く (a ready, unplayed podcast: title over the adaptive 番組 label, with a play button); ニュース (two headlines as plain text, no card: a small sans category kicker over a serif headline clamped to two lines, 1.4rem between picks; すべて opens 読む). Every block is marked by its tab's icon alone (復習 layers, 本棚 book, 聞く headphones, ニュース newspaper) at 19px in `--text-muted`, with no label text; the word stays as the icon's accessible name (the page's adaptive label where there is one). Text inside a block that names a page uses that page's adaptive label (番組), so it reads the same as the page it opens. Each kind keeps its own shape (a card for reading, a play row for audio, plain text for news) so the page doesn't read as one list.
  
- **Each block is a shortcut into the tab that owns it,** never a copy. A block with nothing to show is left out, the review card included when nothing is due; whichever block shows first sits right under the heading.
  
- Section kickers are 0.7rem sans, 600, `--text-muted`, 2rem above their block. **No stats, streaks or charts**: those belong in 進捗.
  
- No date beside the title.

## 7. Copy
- Short. Prefer one word to a sentence. Chrome labels (titles, tabs) follow §6.10; content and in-page controls are Japanese.
  
- No sentences explaining what a control obviously does. If a control needs explaining, redesign the control.
  
- Empty states: one line of title and at most one short line of hint.
  

* * *
## 8. Known drift (fix when touching these areas)
- **Olive** `#4a5d23` is hard-coded about 33 times (READY labels, progress bars, spinners) and isn't a token. Decide whether it becomes a token (`--accent-olive`) or moves to the neutral and soft-blue system.
  
- **Black primary actions:** the Library import button uses a `--text-main` fill (the Listen and Library `+` buttons are fixed, §6.8).
  
- **Two toggle styles:** REVIEW's 復習 | 進捗 control (serif, `--bg-card` track, no sliding thumb) differs from the Settings slider.
  
- **Outlined black-fill pills** remain in the Library import sheet (貼り付け | URL) and should become the slider toggle. (The Library and Listen filter rows are gone, replaced by §6.8.)
  
- **Slider duplication** in `Settings.tsx` (§6.1).
