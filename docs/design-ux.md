# قريض — Frontend UX + Game Design (authoritative)

Ports (verified free in the suite): dev API **5750**, Vite dev **5751**, preview **6750**, prod **8010**. Domain qarid.avicenna.space.

## 0. Project shape & identity
mimema/leyline shape: single npm package, `client/` + `server/` + `shared/` + `tools/`, Vite root `client`, build `outDir: ../dist`, dev proxy `/api → 127.0.0.1:5750`.
- `<body data-app="qarid">`, `<html lang="ar" dir="rtl">`.
- `document.body.dataset.appReady = '1'` after first render.
- localStorage `qarid:v1:*`, hand-rolled `persist.ts` copied from daedalus (`{v,data}` envelope, Zod safeParse, corrupt payloads backed up to `qarid:corrupt-backup:<slice>`, 300ms debounce + `flushNow()` on visibilitychange).
- Seeded RNG: `shared/rng.ts` = daedalus sfc32 + hashSeed + rngFrom(seed). No Math.random for anything deterministic.

### Load-bearing invariant
**`shared/arabic.ts` is the only normalizer.** Server FTS index, server chain-letter derivation, client live letter indicator, search highlighter, dedup key — all use the same functions. Exports:
```
stripTashkeel(s)   // U+064B–U+0655, U+0670, U+06D6–U+06ED, tatweel U+0640, ZW U+200B–U+200F
foldLetters(s)     // أإآٱ→ا  ى→ي  ة→ه  ؤ→و  ئ→ي
normalize(s)       // strip + fold + collapse whitespace
lastChainLetter(ajuz)   // letter the NEXT bayt must start with
firstChainLetter(text)  // folded first letter of player's text
baytKey(poemId, i) // `${poemId}:${i}`
foldedIndex(s)     // fold consulted, never materialized → offsets stay in ORIGINAL string (vellum-prod/client/books/search.ts trick) for snippet highlighting
```
Chain-letter rule (server is authority, client mirrors for preview): strip tashkeel from ajuz, drop trailing non-letters, take last Arabic letter, fold. If it's a bare ا/و/ي acting as وصل (preceding letter is not a chain-terminal), step back one. Server returns `requiredLetter`, `requiredLetterSource: 'rawiyy'|'wasl-stepback'`, `alsoAccepts: string[]`; UI renders letter + one Arabic clause + ghost chips for alsoAccepts.

## 1. Route map (hash router, daedalus flavour: parseHash / routeHash / useRoute / navigate / initRouter)
| Hash | Route |
|---|---|
| `#/` | home: daily bayt, omnibox, facet doors, duel CTA |
| `#/poets?era=&letter=` | poets index |
| `#/poet/<slug>` | poet page |
| `#/poem/<id>?bayt=7` | poem page, bayt deep-link anchor |
| `#/browse?era=&meter=&theme=&rawiyy=&letter=&sort=&p=` | faceted browse (URL owns facet state; store mirrors) |
| `#/search?q=&p=` | search |
| `#/wander` | serendipity walk (v1.5) |
| `#/duel`, `#/duel/play`, `#/duel/summary` | game (play/summary guard → `#/duel` when no session) |
| `#/daily` | shared daily chain |
| `#/train`, `#/train/drill`, `#/train/arsenal` | training |
| `#/stats`, `#/favorites?collection=`, `#/rules` | |
Unknown → `#/`. `?` opens HelpOverlay everywhere. Slugs ASCII for era/meter/theme (server-supplied); single Arabic char for rawiyy/letter.

## 2. Visual language
- Accent: `[data-app='qarid'] { --accent-rgb: 214, 173, 96; }` (#d6ad60 illumination gold) on blue-black ink. Derived accent vars on **body, not :root**.
- Second ink, lapis `--lapis-rgb: 92,124,200`, used ONLY for: (1) opponent's bayt card border/recitation sweep in duel, (2) rawiyy underline when "أظهر الروي" on, (3) search-match »« markers. ok/warn/danger = semantics only.
- Surfaces: `--bg-0:#07080c; --bg-1:rgba(17,19,27,.82); --bg-2:rgba(26,30,42,.86); --panel:rgba(11,13,19,.78); --line-1:rgba(255,255,255,.08); --line-2:rgba(255,255,255,.15); --text-1:#ece6da; --text-2:#9d9689; --text-3:#6a6459; --rule-gold: linear-gradient(90deg,transparent,rgba(var(--accent-rgb),.34) 18%,rgba(var(--accent-rgb),.34) 82%,transparent)`.
- Background: slow illumination bloom (two radial gradients gold 22%/14% + lapis 78%/86%, 8% opacity, 40s drift, off under reduced-motion).
- Two type scales: UI (IBM Plex Sans Arabic) 12/13/14.5/16/18/22/28; VERSE (Amiri) `--fs-bayt-sm: clamp(1.05rem,1rem+.5vw,1.25rem)`, `-md: clamp(1.25rem,1.1rem+1.1vw,1.75rem)`, `-lg: clamp(1.5rem,1.2rem+2.2vw,2.4rem)`, `--lh-bayt: 2.05` (2.30 with tashkeel).
- Arabic typography rules: NEVER letter-spacing on Arabic; never italic Arabic; logical properties only (start/end, inline-*); `:dir(rtl){font-family:var(--naskh)}` catch-all; ornaments are SVG never font glyphs; verse numbers Arabic-Indic, stats/timers Latin tabular-nums.
- **The numeral line, stated precisely (amendment 18).** ARABIC-INDIC, in the UI face, through `formatCount`: any number that is part of the Arabic page — verse numbers, بيت/قصيدة/شاعر counts, chip and facet counts, the إحصاءات tiles and bars, the شعراء letter rail. LATIN `tabular-nums`, in `--font-mono`, through `formatScore`/`formatClock`: the GAME's instruments and nothing else — the duel clock, the score, the streak multiplier, the أبيات-said tally, the summary's four big numbers, the hint price, the exchange award, the ترسانة ring, and the search timing. `--font-mono` is Plex Mono's LATIN subset (that is all that is imported), so it must NEVER be set on Arabic-Indic digits: their glyphs would come from an unspecified OS fallback with a different U+066C, and `tabular-nums` would be a silent no-op. The corollary the duel screens exist to obey: one strip, one scale — the HUD a player watches as «النقاط 320» must not hand them «٥٣٤» on the summary.
- Chips: one component, 4 variants by shape+SVG mark not hue: بحر pill with tafʿila glyph + tafʿilat popover; غرض filled pill; عصر square-cornered; روي circular 1.9em letter in Amiri, lapis hairline. Active → accent border + accent-dim fill + glow. Facet chips carry counts.
- Empty states carry real abyat (client/data/flavor.ts): search-none «وما نيلُ المطالبِ بالتمنّي / ولكن تُؤخذُ الدنيا غِلابا» (شوقي); no favorites «إذا لم تستطعْ شيئًا فدعْهُ / وجاوزْهُ إلى ما تستطيعُ»; defeat «ومن يكُ ذا فمٍ مرٍّ مريضٍ / يجدْ مُرًّا به الماءَ الزُّلالا» (المتنبي); facets-zero «قد يُدركُ المتأنّي بعضَ حاجتِهِ / وقد يكونُ مع المستعجلِ الزللُ»; no due cards «العلمُ يُحيي قلوبَ الميّتينَ كما / تُحيي البلادَ إذا ما مَسَّها المطرُ».

## 3. Screens
### Home `#/`
Centred column max 46rem: wordmark قريض (Aref Ruqaa, gold, dissolving gold hairline) → بيت اليوم hero (BaytPlate lg, illumination corners, poet/era/meter chips, actions نسخ·بطاقة·حفظ·«ساجِلني من هنا», reveal gated on document.fonts.ready) → Omnibox (placeholder «ابحث في ٢٥٥ ألف قصيدة… بيتٍ، أو شاعرٍ، أو قافية», `/` focuses, 200ms debounced dropdown with 3 groups شعراء·أبيات·قصائد max 4 each, arrow keys mirrored under RTL) → أبواب 4 door tiles (العصور/البحور/الأغراض/القوافي with top-3 + counts) → المساجلة bar (best streak, arsenal ring, CTA) + slim daily row → شاعر اليوم card.
### Poets `#/poets`
Sticky era chip strip + letter rail (vertical inline-end on wide, horizontal sticky on mobile; counts; click scrolls + writes ?letter= replace). Sections per folded letter (h2 Aref Ruqaa gold) → grid of PoetCard (name, era chip, N قصيدة, 2-line clamped bio). Grouping by shuhra letter: strip leading ال, fold — `sortName()` in shared/arabic.ts, must match server grouping. Virtualized.
### Poet `#/poet/<slug>`
Header (name Aref Ruqaa 2xl, era chip, dates, bio 38rem lh 1.75 clamped 5 lines + المزيد) → signature bayt (BaytPlate, corners) → toolbar (sort الأشهر·الأطول·حسب البحر + meter/theme chips scoped to poet with counts, written to hash) → virtualized diwan rows (title or matlaʿ when untitled — common; meter chip, theme chip, N بيتًا; 76px/92px rows). Breadcrumb الشعراء ← العصر ← الشاعر.
### Poem `#/poem/<id>` — crown jewel
```css
.bayt { display:grid; grid-template-columns: 1fr var(--gutter,2.25rem) 1fr; align-items:baseline; }
.bayt .sadr { justify-self:end; text-align:start } .bayt .ajuz { justify-self:start; text-align:end }
```
DOM order sadr, gutter, ajuz. The two TRACKS stay reserved and equal (so the block is optically centred and hover shifts nothing), but each شطر is pulled to the INNER edge of its track — `.sadr{justify-self:end}` / `.ajuz{justify-self:start}` — so the two inner edges align and the quiet centre channel IS the gutter (amendment 19). Outer alignment was measured at 0.61 track fill and a 408px void between two 265px runs, i.e. a canyon wider than the verse; the reading column is 54rem, not 64, for the same reason. Gutter empty; on hover/focus-within a 12px gold Shamsa SVG fades in 45%. Bayt number in 4ch inline-start column, text-3, Arabic-Indic. <860px: single column, `.ajuz` padding-inline-start 1.75rem + 1px line-1 inline-start border.
Row interactions: hover → accent .045 bg + 2px accent inline-start bar + action rail (نسخ·بطاقة·♥·⌁ساجِلني); touch: rail always at reduced opacity. `j`/`k` move focus (not mirrored), `c` copy, `f` fav, `s` share. `?bayt=N` scroll-anchor + pulse twice.
Header: title or «matlaʿ…», poet link, breadcrumbs; badges: بحر chip → tafʿilat popover (client/data/buhur.ts static: tafʿilat + مفتاح mnemonic for 16 buhur), قافية chip with rawiyy glyph, era chip, N بيتًا. Toolbar: تشكيل (ONLY rendered when API `hasTashkeel: true`; default on; off = client stripTashkeel; when on lh 2.30 + one size step), إظهار الروي (lapis underline), حجم الخط sm/md/lg persisted, نسخ القصيدة.
Copy: prefix U+200F RLM; hemistichs joined ` … ` on one line; alt-click menu البيت · البيت والشاعر · القصيدة كاملة; copies displayed tashkeel state.
### Browse `#/browse`
Two-pane wide / drawer mobile. Facet rail (sticky inline-start): 5 accordions العصر·البحر·الغرض·الروي·حرف البداية; era/meter/theme chip clouds w/ counts; rawiyy + first-letter as 7×4 circular letter grids, count under each, disabled at 0. Counts from single `/api/facets?<query>` refreshed on change. Applied bar of dismissible chips + «امسح الكل». Results: virtualized PoemRow, or BaytPlate list when rawiyy/letter active. Sort الأشهر·الأطول·عشوائي (seeded rngFrom(queryString), stable across pagination). **«الأحدث» is NOT shipped and is struck from this spec (amendment 20):** `arbml/ashaar` carries no date on a قصيدة — only the شاعر's عصر, which is a twelve-value facet, not an ordering — so «الأحدث» could only have sorted by ingest rowid and called it recency. عصر is the facet that answers the question honestly. «المزيد» + intersection autoload, `?p=` in hash. Empty combo → flavor bayt + «جرّب إزالة: X (٠ نتيجة)».
### Search `#/search`
Query echoed; count + timing text-3. Unit = bayt with poem/poet context. Highlight via foldedIndex; »…« as `<mark>` lapis-dim bg, no bold. Facet strip era/meter/theme. Segmented modes كلمات (AND) · عبارة (phrase) · أي كلمة (OR); OR auto-fires when AND returns 0 with note «لا نتيجة بكل الكلمات — هذه نتائج بعضها».

## 4. المساجلة (strict only)
### Setup `#/duel`
1. المستوى tiers (params shown, not hidden):
| Tier | Pool | Timer | Lives | Hints | Adversarial |
|---|---|---|---|---|---|
| مبتدئ | top fame decile | 60s | 3 | full, half price | no — avoids ending on ظ ذ غ ز ث |
| شاعر | top half | 40s | 3 | full | neutral |
| فحل | full | 25s | 2 | double price | prefers rare terminal letters |
| سيف | full | 15s | 1 | none | yes |
2. القيود optional era/bahr with live eligible count; warn (not block) below 2,000.
3. الوقت on/off (off forces tier ≤ شاعر). 4. النمط الوصال (endless) / المبارزة (best of 10 on points).
Record for config shown; «ابدأ». Session seed `rngFrom(\`duel:${startedAt}:${config}\`)` stored.
### Play `#/duel/play`
Recitation transcript, newest at bottom. Exchange log of BaytPlates: computer's = lapis inline-start hairline, name «الخصم» replaced with poet only after exchange resolves; yours = gold hairline; `+140` award animates in. Progressive reveal: sadr words staggered 55ms (opacity+blur 3px→0, 180ms), 400ms caesura, ajuz same; **timer starts only after reveal completes**; any key/tap skips; instant under reduced-motion.
Letter indicator (most important element): `[المطلوب: ن] → [عندك: ن] ✓` — required letter 2.4rem Amiri gold in circular accent-dim well; typed letter live via firstChainLetter(): neutral empty / gold+✓ match (or alsoAccepts) / danger mismatch; one clause beneath only when relevant («التاء المربوطة تُحسب هاءً» / «الهمزات كلها ألف»).
Input: auto-growing `<textarea dir="rtl" lang="ar" enterkeyhint="send" autocorrect="off" autocapitalize="off" spellcheck="false">`; Enter submits, Shift+Enter newline; accepts full bayt or sadr only; placeholder rotates real corpus openings with required letter (removed in سيف).
Timer: hairline arc around letter well; last 5s warn pulse, last 2s danger; Plex Mono readout. HUD sticky: lives as 3 nib SVGs (spent → 18% opacity), streak ×٧ gold, score mono, used count.
Hints (هَمْس button popover, prices visible, consumed against server-held candidate): «من قائله؟» −40 · «أول كلمة» −60 · «البحر» −20.
Rejection outcomes:
| tag | copy | cost | UI |
|---|---|---|---|
| wrong-letter | «هذا البيت يبدأ بـ «م»، والمطلوب «ن»» | none | input kept, letter marked danger, shake |
| already-used | «قيل هذا البيت في هذه المساجلة» | none | link scrolls+pulses that exchange |
| not-found | «لم أجده في الديوان» | −1 life | shows normalized form + ≤3 near-misses «هل تقصد؟» tappable to fill input |
| timeout | «انقضى الوقت» | −1 life | computer recites a bayt that would have worked |
| ambiguous | «وجدتُ أكثر من بيت» | none | chip row of matches, tap to pick → accepted |
Verification server-side only: `POST /api/game/verify {text, requiredLetter, usedKeys, constraints, sessionSeed}` → discriminated union. Client never decides acceptance.
### State machine (pure reducer client/duel/machine.ts)
```
idle —START(config)→ dealing
dealing (POST /api/game/open) —DEALT→ reciting | —ERROR→ failed
reciting (reveal, timer NOT running) —REVEAL_DONE|SKIP→ awaiting
awaiting (timer running) —SUBMIT→ verifying | —HINT→ awaiting(score-=price) | —TICK→ awaiting | —TIMEOUT→ penalising(timeout) | —ABANDON→ summary(abandoned)
verifying (timer PAUSED) —ACCEPT→ accepted | —REJECT(wrong-letter|already)→ rejected(soft) | —REJECT(not-found,nearMisses)→ penalising(not-found) | —AMBIGUOUS→ disambiguating | —ERROR→ rejected(network) (never costs a life)
disambiguating —PICK→ accepted | —CANCEL→ awaiting
rejected(soft) (1.2s toast, timer resumes) —AUTO→ awaiting
penalising (lives-=1, streak=0) → lives>0: awaiting (same letter, timer reset) | lives==0: summary(defeat)
accepted (score+=award, streak++, push exchange, arsenal[letter]++) → match&&count==10: summary(win|loss) | else computerThinking
computerThinking (POST /api/game/reply, 700–1400ms floor) —REPLY→ reciting | —NO_REPLY→ summary(victory «أفحمتَ الخصم»)
summary terminal: PLAY_AGAIN→dealing, EXIT→idle. failed: RETRY→dealing
```
Scoring: `award = 100 + 10*min(streak,10) + (timerOn ? round(msRemaining/1000)*2 : 0) + round(50*obscurity) - hintsSpentThisExchange`.
### Summary `#/duel/summary`
Headline (Aref Ruqaa): «أفحمتَ الخصم» / «سلسلة من ١٤ بيتًا» / «انقضت الأرواح». Big numbers النقاط·أطول سلسلة·الأبيات·الوقت. سلسلة الحروف ribbon (gold yours, lapis computer's; tap scrolls). الأبيات: every exchange as BaytPlate with poet, ♥, بطاقة. الشعراء الذين لقيتهم: poet-card grid, new-to-you marked with gold nib, «لقيت ٤٧ شاعرًا من ٢٤٠٠» (retention mechanic — v1). زدت في ترسانتك letters. Actions: مرة أخرى · احفظ في مجموعة · شارك.

## 5. تحفيظ training (v1.5)
Hub `#/train`: المذاكرة (due count), الترسانة (heatmap thumb + weakest 3), تحدّي اليوم, streak ribbon.
Drill `#/train/drill`: card = bayt (baytKey). Show sadr; ajuz as ruled blank of honest width; type or «أظهر»; grade `sim = 1 - lev(normalize(typed), normalize(ajuz))/max(len)`: sim==1 → good (easy if <8s); 0.65≤sim<1 → hard + word diff (correct text-1, missing text-3, wrong danger); else again. Reveal shows full bayt, poet, link, «هذا في ترسانتي». New cards from `/api/train/candidates?famous=1&letter=`.
Schedule SM-2-lite (client/training/schedule.ts, pure, tested): Card {id, ease 2.3 [1.3,2.8], interval days [1,365], due, reps, lapses, leech, addedAt}. again: reps=0, lapses++, ease-=0.2, due=now+10min, leech at 8 lapses. else reps++, ease += {hard:-0.15,good:0,easy:+0.10}, mod {0.7,1,1.3}, interval = reps==1?1 : reps==2?3 : round(interval*ease*mod), jitter ±10% via rngFrom(`due:${id}:${reps}`), due = startOfDay(now)+interval days. buildQueue: due & !leech sorted asc cap 20; new up to 10/day famous-first biased to arsenal letters with coverage <3; never two consecutive cards from same poem; leeches surfaced on hub (replace/delete). dayKey local YYYY-MM-DD.
Arsenal `#/train/arsenal`: 7×4 heatmap of 28 folded letters, fill opacity min(1,count/12) accent-dim, count Plex Mono, zero → dashed line-2 border. Per letter مستعمَل (played in duel) and محفوظ (interval ≥ 21). الحروف الضعيفة bottom 5 with «تدرّب» → drill from `/api/poems?firstLetter=L&famous=1`. Ring «تغطية ٢١ من ٢٨ حرفًا».
Daily `#/daily`: same opening bayt for everyone from server `rngFrom(\`daily:${YYYY-MM-DD}\`)`; 1 life, no timer; one attempt/day client-enforced; shareable text block «قريض — تحدّي ٢٣ آب / ن → م → ب → ر / سلسلة من ٦ أبيات».

## 6. Architecture
```
qarid/
├─ package.json tsconfig.json vite.config.ts CLAUDE.md README.md
├─ shared/ schema.ts arabic.ts(+test) rng.ts constants.ts (CHAIN_LETTERS[28], ERAS, METERS, THEMES slugs)
├─ server/ (see design-server.md)
├─ tools/ screenshot.mjs smoke-seed.json devshot.mjs
└─ client/
   ├─ index.html main.tsx App.tsx router.ts persist.ts
   ├─ api/ client.ts (fetch + zod parse + ApiError + in-flight dedupe) queries.ts
   ├─ store/ settingsStore libraryStore duelStore trainingStore profileStore collectionsStore toastStore
   ├─ bayt/ BaytPlate.tsx (THE only bayt renderer) BaytActions BaytSkeleton tashkeel.ts copy.ts BaytPlate.test.ts
   ├─ components/ Chip ChipCloud LetterGrid LetterRail Omnibox Breadcrumbs Panel Segmented Skeleton EmptyState Portal Toasts HelpOverlay Ornaments(SVG only) VirtualList
   ├─ hooks/ useWindowedList useKeyboard useAppHeight useDebounced
   ├─ views/ Home Poets Poet Poem Browse Search Wander Stats Favorites Rules
   ├─ duel/ DuelSetupView DuelPlayView DuelSummaryView machine.ts(+test) scoring.ts(+test) LetterIndicator RecitationReveal ExchangeLog AnswerInput HintPopover RejectionCard Hud
   ├─ training/ TrainHubView DrillView ArsenalView DailyView schedule.ts(+test) grade.ts(+test) ArsenalHeatmap WordDiff
   ├─ share/ renderCard.ts (THE only card renderer) ShareDialog.tsx
   ├─ data/ buhur.ts flavor.ts shortcuts.ts
   └─ styles/ tokens.css base.css components.css bayt.css app.css
```
Stores: `qarid:v1:settings` {tashkeel:true, showRawiyy:false, verseSize:'md', numerals:'arabic', sound:false, reduceMotion:'system'}; `useLibrary` in-memory only (poems LRU 200, poets 400, facets 40, inflight dedupe) — 255K poems never hit localStorage; `qarid:v1:duel` {config, seed, phase, required{letter,source,alsoAccepts}, exchanges[{side,baytKey,sadr,ajuz,poet,poemId,award,hints,ms}], usedKeys[], score, lives, streak, best, startedAt, deadline, pausedAt, lastResult, dispatch}; `qarid:v1:training` {cards, dayKey, newIntroducedToday, arsenal{letter:{used,mastered,lastAt}}, session}; `qarid:v1:profile` {gamesPlayed, abyatPlayed, bestStreak, bestScore, poetsMet, dailyResults, reviewStreak, firstSeenAt}; `qarid:v1:favorites` {favorites[] DENORMALIZED (sadr/ajuz/poet/poemId — render offline), collections[]}. Persist shapes are Zod in shared/schema.ts with PERSIST_VERSION + MIGRATIONS chain.
API client: `request<T>(path, schema, init)` parses through Zod; in-flight dedupe by method+path; AbortController per view; named methods only, no ad-hoc fetch.
Virtualization: no dep; `useWindowedList` ~70 lines (fixed rowHeight, overscan 6, scroll + ResizeObserver). Applied to poets index, poet diwan, browse results ONLY. Poem verse lists NOT virtualized (Ctrl+F, anchors, selection).
Loading: skeletons match final geometry (BaytSkeleton = BaytPlate grid with ruled bars + 1.4s gold sweep), nothing spins <200ms, poem header renders from cached list data while verses load, facet counts optimistic (stale marked text-3).

## 7. Fonts (self-hosted via @fontsource, per-subset imports)
`@fontsource/amiri/arabic-400.css, arabic-700.css` (verse, `--font-verse`); `@fontsource/aref-ruqaa/arabic-400.css` (display: wordmark, poet header names, summary headlines only); `@fontsource/ibm-plex-sans-arabic/arabic-400/500/600.css + latin-400/500.css` (UI); `@fontsource/ibm-plex-mono/latin-400/500.css` (numerals/timers, tabular-nums). ~510KB total.
Hard reqs: CSP includes `font-src 'self' data:`; `await document.fonts.load('400 64px Amiri')` before any canvas paint; home hero gated on document.fonts.ready.
Ornaments.tsx: inline SVGs Shamsa, Rule, Corner, Nib. Favicon inline SVG gold Nib. No raster images in v1.

## 8. Delight verdicts
v1: copy-bayt (RLM), favorites, poets-you-met summary grid, hints, near-miss suggestions, tafʿilat popover, بيت/شاعر اليوم, core keyboard shortcuts. v1.5: share cards (canvas 1200×630 + 1080×1080; `ctx.direction='rtl'; ctx.textAlign='right'`), named collections, daily chain, `#/wander` (one bayt, three doors شاعره·بحره·قافيته), sound (default off), full shortcuts + HelpOverlay, training mode, StatsView, RulesView. v2: poet comparison, scansion visualizer, async multiplayer, audio.

## 9. Build order
Phase 0 skeleton: shared/arabic.ts+tests, rng, schema, persist, router+tests, tokens/base CSS, fonts, App shell with appReady, tools/screenshot.mjs — done bar green on empty app.
Phase 1 the bayt: BaytPlate + bayt.css both breakpoints, BaytSkeleton, copy, PoemView; screenshot at 1440 and 390 and iterate.
Phase 2 the browser: api client, libraryStore, PoetsView, PoetView, useWindowedList, Chip/ChipCloud/LetterGrid, BrowseView (URL facets), SearchView (folded highlighting), Omnibox, HomeView.
Phase 3 the duel: machine.ts+tests headless first, scoring+tests, Setup, LetterIndicator, AnswerInput, RecitationReveal, ExchangeLog, RejectionCard (all outcomes + near-misses), HintPopover, Hud, Summary with poets-met, persistence+resume, smoke seed mid-duel. **v1 ships here.**
Phase 4 v1.5: training (schedule.ts→Drill→Arsenal→Hub), Daily, share cards, Wander, tiers فحل/سيف, sound, full keymap, Stats, collections, Rules.

## 10. Client assumptions the API must honour
- Poem detail returns `hasTashkeel: boolean` and verses as `{sadr, ajuz}[]` paired server-side.
- Every bayt-bearing response carries `baytKey`.
- `/api/game/open` and `/api/game/reply` return `{bayt, requiredLetter, requiredLetterSource, alsoAccepts}`; reply may return `noReply: true` (victory must be reachable).
- `/api/game/verify` returns exactly the five tags; not-found carries `nearMisses: Bayt[]` (≤3); sadr-only answers accepted.
- `/api/facets?<query>` returns counts for every facet value incl. zeros.
- `obscurity: number` 0..1 on accepted abyat.
- `/api/train/candidates?famous=1&letter=<L>`.
