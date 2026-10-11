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
| `--accent-primary` | `#d4e0e8` | Soft blue: badges and small highlights only |
| `--accent-progress` | `#8fb0c4` | Muted slate blue: progress fills on a pale track |
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
`--bg-card` (or `--bg-pure` for a featured item such as the daily digest), radius 24px, padding `1.4rem 1.5rem`, 1px `--border-light`, shadow `0 4px 25px rgba(0,0,0,0.03)`. Kicker tag at top-left, status at top-right, serif title, one muted meta line. Progress is shown as a 3px bar along the bottom edge.
### 6.6 Toast
Fixed at the top centre, `--bg-card`, radius 14px, 1px `--border-light`, shadow `0 6px 30px rgba(0,0,0,0.12)`, 0.85rem, tap to dismiss, auto-hides after about 5s. Keep messages to a few words (聴くタブで作成中).
### 6.7 Icon buttons
Lucide icons, stroke width 1.5, 20–24px, `--text-muted` at rest, no background. An icon can show a "done" state by darkening to `--text-main`.
### 6.8 Archive list (LISTEN, LIBRARY)
Source of truth: `src/components/ArchiveList.tsx`, mockup `docs/mockups/archive-organize.html`.

- **Months, not filters.** Items group by month under a serif month heading (year in small muted sans for any month but the current one) with the count and a chevron at the right. The newest month starts open and older ones collapsed; a collapsed month shows one muted summary line (`4本 · 未再生 2`).
  
- **Search** is a hero input on a hairline under the page heading (§6.9), matching Japanese and English. Results stay grouped by month with every month open, under a muted `n件`. A hit in body text adds a short excerpt marked `EN` / `JA`, the match tinted `--accent-primary`.
  
- **Swipe left to delete** (the Feed's gesture): a `--accent-danger` panel with a serif 削除 is revealed behind the card; a long swipe deletes outright. One row open at a time.
  
- **Long-press (0.5s) to select.** The header becomes `n件を選択` + 完了, each card's status corner becomes a check circle, selected cards turn white with the thumb shadow, and an action bar (count + coral 削除) covers the bottom nav. Months offer すべて選択.
  
- **Undo, not confirm.** Deletes hide at once and reach the server after a 5s toast with 元に戻す (§6.6).
  
- The `+` sits at the end of the search row: a small (34px) white lifted circle, not a black fill.
  
### 6.9 Page heading (tab pages)
Source of truth: `src/components/PageHeading.tsx`, mockup `docs/mockups/top-row.html` (見出しに統合).

- **No global header on tab pages.** Each tab opens with one serif title (2rem) in one language, and the settings mark on the same line at the right. Nothing sits above it but the status bar.
  
- The **settings mark** is thin slider lines (stroke 1.25, `--text-muted`, 44px hit area), not a gear or ⋮.
  
- Right-edge icons share one vertical line: the settings mark's icon centre sits 17px in from the content edge, the same as the 34px `+` in the archive search row below it.
  
- The first content after the heading starts 1.6rem below it (the heading's 1rem margin plus 0.6rem on News; the search row's margin on the archive pages).
  
- The page's own controls sit directly below: search + `+` (LISTEN, LIBRARY), the 復習 | 進捗 segment (REVIEW).
  
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
  
- Japanese labels: ニュース (katakana, not 読む), 本棚 → 書庫, 聞く → 聴く, 復習, 検索, 設定. A new label needs its JMDict entry id in `UI_LABELS`.
  

* * *
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
