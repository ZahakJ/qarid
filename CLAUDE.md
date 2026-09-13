# قريض (Qarid)

Arabic classical poetry corpus browser **and** مساجلة duel at
**qarid.example.com** — قَرِيض, the old word for verse itself. **238,733
poems / 3,369,701 أبيات / 6,941 شعراء** in the built artefact (254,630 rows
read; 15,891 duplicate قصائد and 6 verse-less poems dropped) from `arbml/ashaar`,
of which **1,713,459 أبيات are game-playable**. Ingested into one read-only
SQLite artefact, browsed by era/بحر/غرض/روي, searched with FTS5, and played:
the machine recites a بيت, you must answer with one that starts on its روي.
Single npm package: Vite 7 + React 19 client, Hono 4
server run directly by Node 26 (TS type-stripping, **no server build**),
`node:sqlite` over a gitignored `data/qarid.db`. The only runtime dependency
past that list is `@hono/node-ws`, which carries v2 §5's مساجلة socket.

Ports: dev API **5750**, dev Vite **5751**, smoke/preview **6750**, prod
**8010** (Cloudflare tunnel `cf-qarid` ingress points at 8010, managed in the
CF dashboard — keep 8010 or you must edit the dashboard). Never other ports.
Accent: illumination gold `--accent-rgb: 214, 173, 96` (#d6ad60) on blue-black
ink, with a single second ink, lapis `--lapis-rgb: 92, 124, 200`, reserved for
exactly three things (opponent's بيت card, روي underline, search »« markers).
Verse font **Amiri**, display **Aref Ruqaa**, UI **IBM Plex Sans Arabic**,
numerals/timers **IBM Plex Mono**. All UI strings Arabic; code English.
**Numerals are WESTERN 0-9 everywhere** — a deliberate decision
(amendments §25): «238,733 قصيدة», «951 بيتًا», verse number «12», «×2».
`shared/format.ts` is the only formatter, it takes no numeral scale, there is
no `numerals` setting, and `toArabicDigits` no longer exists. Adding an
Arabic-Indic digit to a rendered string is a regression — `toLatinDigits`
exists only to PARSE what a reader types. **And a number is never glued to a
hard-coded noun**: `countedNoun` (and `countedUnit` / `countedNounGenitive` /
`countedNounWithAdjective`) own العدد والمعدود, because «4 نتيجة», «10 بطاقة»
and «سلسلة من بيتان» are the loudest way an Arabic interface announces that it
was assembled rather than written. See the invariant below.

## Commands

- `npm run dev:server` + `npm run dev` — dev pair (vite 5751 proxies `/api`, `/healthz` → 127.0.0.1:5750)
- `npm run typecheck` / `npm test` / `npm run build` / `npm run smoke` — the done bar
- `npm run ingest` — build `data/qarid.db` from `data/raw/*.parquet`. **Measured: 169 s (3 passes), peak RSS 711 MB, 1.48 GiB out** (§5 estimated 15–30 min; hyparquet made it two and a half minutes). Stop any server on the artefact first — it is replaced, not updated. If one is running anyway (another agent, the prod unit), build to a side path and `mv`: `node scripts/ingest/index.ts build data/raw/*.parquet data/qarid.build.db && mv -f data/qarid.build.db data/qarid.db`, then restart the server — a live process keeps the old, deleted inode open.
- `npm run ingest:fixture` — same `build.ts` over `test/fixtures/ashaar-sample.jsonl` → `data/fixture.db` (tests use the real ingest path)
- `node scripts/ingest/profile.ts` — re-run the corpus profiler → `data/profile.json` + `data/sample-2000.jsonl` (~3 s)
- `npm start` — prod server (reads `.env`, defaults PORT 8010)
- `node tools/screenshot.mjs [--no-build] [--mobile] [--port N] [--db PATH] [--routes …]`
  — the smoke walk. It starts the REAL server itself and kills only that PID;
  never `pkill -f server/index.ts`, the suite shares that path. The server reads
  `dist/index.html` ONCE at boot, so after `npm run build` a long-lived server
  must be restarted or it serves the previous bundle's asset hashes.
  `--mobile` is a PHONE, not a narrow window: `hasTouch` + `isMobile`, so
  `(hover:none)`/`(pointer:coarse)` match and `.keys-only` affordances (the `/`
  badge, «Shift+Enter») are correctly absent from the shots. A failure prints
  the console errors AND the URLs behind them — Chromium's own message for a
  dead subresource names a status and no URL.

## Architecture

- `shared/` is the contract layer: `arabic.ts` (the ONLY normalizer),
  `meters.ts`, `eras.ts`, `themes.ts`, `letters.ts`, `schema.ts` (zod, single
  source of truth for every DTO and every persisted shape), `rng.ts` (seeded
  sfc32 — no `Math.random` anywhere deterministic), `famousPoets.ts` and
  `poetAliases.ts` (the two curated poet tables the ingest reads — the canon
  that sets `fame`, and the 56 alias → canonical `name_key` merges), and
  `anthologies.ts` (the THIRD curated table, and the only one the ingest never
  sees — see the invariant on المختارات المنظومة).
- `scripts/ingest/`: `readers.ts` streams rows (`readRecords(src)`, parquet or
  jsonl) → `transform.ts` (pure, tested) → `build.ts` (two passes, DDL in
  design-server.md §5). Ingest is Node, not Python, precisely so it imports the
  same `shared/arabic.ts` the server does — no normalizer drift.
- `server/` Hono: `app.ts` is listen-free (`createApp(config, db)`) so tests
  drive `app.request()`; `index.ts` binds 127.0.0.1 **and ::1**; `db.ts` opens
  the artefact read-only once and hands out cached prepared statements.
  Route sub-apps live in `server/routes/` and are mounted at the one marked
  block in `app.ts`.
- Route map (`server/routes/`, all mounted under `/api`): **meta** `/meta`
  (whole payload precomputed into `meta.meta_json` at ingest, parsed once per
  process) · **stats** `/stats` (same trick over `stats_json`) · **poets**
  `/poets` (`?slugs=a,b,c` is its batch door: ≤30 full `PoetSummary` rows in the
  order asked, every other filter ignored), `/poets/:slug` (poet + signature بيت
  + first ديوان page + قافية/بحر/غرض chips), `/poets/:slug/poems` · **poems**
  `/poems`, `/poems/:publicId` (أبيات paired, first 200), `/poems/:publicId/baits` (offset/limit ≤ 300),
  `/poems/:publicId/similar` (amendment 9) · **baits** `/baits`,
  `/baits/random` (era/meter/**poet**/rhyme/first/fame/seed — the three
  #/wander doors), `/baits/daily`, `/baits/:id` (prev/next) · **buhur**
  `/buhur` (one exemplar بيت per بحر for `#/buhur`, memoised per DB handle and
  pre-warmed at boot — see the invariant below) · **facets**
  `/facets` · **train** `/train/candidates` · **game** `/game/pool` (the setup
  screen's «العدد المتاح»; it takes the SAME five «قيود» `GameFilters` carries,
  `poet` included, and `poolByLetter` in `server/game.ts` is the one place that
  decides how the per-letter count is obtained — see the invariant below) ·
  **anthologies** `/anthologies`,
  `/anthologies/:slug` (المختارات المنظومة — the curated shelves, resolved
  against the corpus at RUNTIME; see the invariant below) · **albums**
  `/albums` (POST create), `/albums/mine`, `/albums/:code` (GET visibility-gated
  · PATCH · DELETE), `/albums/:code/entries` (POST — a قصيدة by PUBLIC ID or a
  بيت by ANCHOR; the server anchors both by content), 
  `/albums/:code/entries/:anchor` (DELETE), `/albums/:code/save` (POST · DELETE —
  «أضِف إلى مكتبتك», the ONE thing a reader may do to somebody else's shelf),
  `/albums/:code/pool` (GET — the shelf as a مساجلة can play it: count ·
  resolved · **playable** · the bait ids, see the invariant) —
  الدواوين, the shelves a READER compiles, and the only sub-app that needs BOTH
  databases; see the invariant below · **auth** `/auth/register`,
  `/auth/login`, `/auth/logout`, `/auth/me` (the only routes that take a cookie;
  `/auth/me` is ALWAYS 200, `user: null` means nobody) · **profile**
  `/profile/:username` (the page, and the account's PUBLIC دواوين — the one
  listing of another reader's shelves there is), `/profile/update`,
  `/profile/arsenal` · **moderation** `/report` (an account OR a ديوان),
  `/block`, `/admin/*` (allowlist: avatar · display name · suspend · resolve ·
  `album/unlist` · `album/description/clear`) · **room**
  `/room` (create — with `albumCode` it is a ديوان contest: the opening بيت
  comes off the shelf and both players answer from it), `/room/opening`,
  `/room/playable`, `/room/:code/state`,
  `/room/:code/join`, `/room/:code/turn`, `/room/:code/resign`,
  `/room/:code/rematch` — plus the WebSocket `/ws/room/:code`, which is NOT an
  `/api` path (it is an upgrade, and the corpus gate would answer it with JSON
  no browser reads) · plus the `search` and `game` sub-apps other agents own.
  Shared plumbing: `server/dto.ts` is the only place a column name is spelled
  (SQL fragments + row→DTO shaping), `server/query.ts` owns query parsing (zod →
  `400 {error, issues}`), memoised slug→id maps, the poem filter and
  `listPoems`. Three rules hold everywhere: a list route ALWAYS returns
  `{items, total, page, limit}`; an unknown *slug* is an empty result, not a
  400 (only an illegal enum is a 400, because the client cannot emit one); and
  any route that sorts sorts a narrow id subquery first and joins the surviving
  ≤100 rows out afterwards — sorting the joined rows cost 2.6 s on the 1.76M-row
  `game_baits` browse.
- `client/` React, hash-routed, `<html lang="ar" dir="rtl">`,
  `<body data-app="qarid">`; `BaytPlate` is the only بيت renderer,
  `client/share/renderCard.ts` the only share-card renderer (canvas 1200×630 /
  1080×1080; `shareCard()` delivers by share sheet → clipboard → download and
  returns which, `CARD_MESSAGE` is the toast for each). Every «بطاقة» action
  goes through `openShareCard(bayt)` in `client/share/ShareDialog.tsx` — the
  preview IS the canvas the download reads — and `<ShareCardHost/>` is mounted
  once, in App.tsx. Layout in design-ux.md.
- **A shared قصيدة is `/p/<id>`, a PATH — because a fragment never reaches a
  server.** `#/poem/16182` cannot be given per-قصيدة preview tags by any amount
  of server work: the box does not know which قصيدة the link is for, so all
  238,733 unfurled as one generic card. `GET /p/:publicId` (`server/share.ts`)
  answers with the SAME shell plus that قصيدة's عنوان/شاعر/طول in the head, and
  `sharePathToHash` in `client/router.ts` folds the path back to `#/poem/<id>`
  with `replaceState` before the first route is parsed — crawlers keep the tags,
  readers never see the path. An unknown id still serves a working shell: a
  shared link must not end in a 404. Two traps: every interpolated value is
  SCRAPED corpus text going into a quoted attribute, so it is escaped; and a
  great many aldiwan titles ARE the مطلع with the تشكيل stripped, so the
  description compares the two through `shared/arabic.ts` and prints the مطلع
  only when it is not the headline already said twice.
- **A share link is built on `shareOrigin()`, NEVER `location.origin`.** In the
  APK the WebView serves the bundled shell from `https://localhost`
  (`androidScheme: "https"`, no `server.url`), so every link built on
  `location` left the phone dead — `https://localhost/#/diwan/…` in the ديوان's
  case, which shipped that way. `shareOrigin()` (client/platform/native.ts) is
  `API_BASE || location.origin`: the real site on native, same-origin on the
  web, where a reader on a preview host should share the host he is reading.
- **Three blocks of TEXT leave the app, one pure `share.ts` each**:
  `client/duel/share.ts` (a مساجلة result), `client/albums/share.ts` (a ديوان)
  and `client/poem/share.ts` (a قصيدة — «شارِك القصيدة», on the poem toolbar and
  in the phone's «أأ» sheet). The قصيدة one is the link-shaped answer to «نسخ
  القصيدة», which is right for a مقطوعة and wrong the moment a reader tries to
  put 951 أبيات in a chat window; it names the قصيدة, its شاعر and its length,
  then points at it, and costs no `ensureAll` because it carries the count and
  not the verse. All three take the URL from the caller, open EVERY line with
  U+200F, and count through `shared/format.ts`. None of them attributes with
  `lamPrefix`: the لام is a preposition, its noun is مجرور, and these names are
  stored in the nominative — «لأبو الطيب» is what gluing it on gets you, where
  the Arabic is «لأبي الطيب». الأسماء الخمسة decline in the LETTERS, and أبو
  تمام/نواس/العلاء/فراس are a good part of this canon, so a name is written
  bare. `lamPrefix`'s one caller puts it in front of a COUNT («لـ6,941 شاعرًا»),
  where nothing has to agree.
- **The PHONE CHROME** (`client/styles/chrome.css`, `client/chrome.ts`,
  `components/AppBar.tsx` + `TabBar.tsx`, `views/MoreView.tsx`). Below 861px
  **and** on a coarse pointer — `useNativeChrome()`, which the Capacitor shell
  satisfies by construction — the masthead and the footer are replaced by a
  52px app bar and a fixed five-tab bottom bar (الديوان · التصفح · المساجلة ·
  التحفيظ · المزيد, RTL order), and `#/more` carries everything the bar has no
  room for. **There is ONE signal**: `App.tsx` writes the decision onto
  `body[data-chrome="native"|"web"]` and `chrome.css` scopes every adjustment
  under it, so the CSS cannot drift from the JS that mounts the components —
  and the desktop web, which never gets the attribute, is pixel-identical
  (verified at 1440 against the pre-change shots). `client/chrome.ts` is the one
  table both bars read: `tabOf` (which tab a screen belongs to — by CONTENT, so
  #/poets lights الديوان even though its only phone door is المزيد),
  `isTabRoot`, `parentRoute` (the back chevron's fallback) and the tab scroll
  memory. Three rules that shipped as fixes: the app bar's title is NOT a
  heading and the page's own `<h1>` is hidden `.sr-only`, never `display:none`;
  a tapped tab keeps `:hover` and base.css's bare `a:hover` is gold at a higher
  specificity than `.tabbar__tab`, so the tab's colour is pinned on `data-on`
  in both states; and the back chevron reads `navDepth()` (a `qd` counter
  stamped into `history.state` by `initRouter`, because counting `hashchange`
  events counts a BACK too) so a cold `#/room/<code>` link falls back to its
  parent screen instead of throwing the reader out of the app.
  A view lends the bar its title through `useChromeTitle` and, on a sub-screen,
  ONE action through `useChromeAction`. The lent title appears only once the
  reader has SCROLLED past the view's own hero — with ONE exception, and it is
  the whole reason a ديوان مساجلة can be read on a phone: a screen carrying
  `body[data-immersive]` cannot scroll (`.main` is exactly one viewport with
  the overflow hidden), so it could never hand over, and its own head is stood
  down — so the name it lends («ديوان «…»») is the only place that name
  appears at all. `AppBar` reads `useImmersiveActive()` for that. The lendable
  ACTION is one only (the قصيدة's «أأ»); both stores are tiny
  and self-clearing, and the action's handler is held in a ref because it closes
  over the view's state and would otherwise re-register on every keystroke.
- **The PHONE's SCREEN PATTERNS** (`client/styles/phone.css`,
  `client/store/immersiveStore.ts`, `client/components/Sheet.tsx`). Three shapes
  the chrome's two bars needed underneath them, each gated on the same one
  signal:
  - **A مساجلة in play is a GAME SCREEN.** `useImmersive(active, onResign)` in
    DuelPlayView and RoomView writes `body[data-immersive="game"]` (a LAYOUT effect
    — see the invariant), App.tsx drops the tab bar, and the view becomes a flex
    column of a FIXED height: slim HUD, scrolling transcript, docked composer.
    Back — the app-bar chevron and Capacitor's hardware button — goes through
    `askExit()`, which returns whether it TOOK the press, so `nativeInit`'s own
    rule is unamended; it raises «انسحب؟» as a `ConfirmSheet`. The dock's four
    rows are all explicit and only the rejection-card row shrinks.
  - **Every phone dialog is a BOTTOM SHEET.** One `<Sheet>` primitive, seven call
    sites («القيود», the قصيدة's reading controls, دخول, «غرفة مساجلة»,
    البطاقة, the walkthrough, the docked room's «⋯»), and the choice is made in
    JS at each site — the desktop never renders a `.sheet` at all, which is what
    keeps its dialogs untouched. Two things the sheet learned from the audits:
    a five-step WALKTHROUGH is a sheet (its nav and step dots are the pinned
    footer, so «التالي» cannot fall off the screen), and `dismissible={false}`
    takes away the ✕, the scrim and Escape for the ONE surface that must not be
    dismissed by habit — the once-shown recovery code, which also gates
    «حفظتُه — تابِع» behind «انسخ» or «كتبتُه في مأمن».
  - **البحث is a full SCREEN.** `PaletteHost` renders `PhoneSearch` instead of
    the panel; both drive one `usePaletteSearch` hook, so there is one query,
    one debounce and one request between them.
  Plus the 44px touch floor: measured with `getBoundingClientRect` over every
  interactive element on fourteen routes, and the failures named one by one in
  phone.css rather than swept up by a blanket `button {}`. The بيت's action rail
  is the big one — it leaves the hover gutter and becomes an inline row of four
  44px cells UNDER the بيت, which also gives the verse 2.2rem more measure.
- **THE TWO SURFACES FOR A READER WHO IS WRITING** (`client/views/QafiyaView.tsx`
  + `client/styles/qafiya.css`, `client/views/BuhurView.tsx` +
  `client/styles/buhur.css`, `client/data/buhur.ts`, `server/routes/buhur.ts`).
  Everything else in قريض is built for someone reading the ديوان or playing it;
  these two are for the poet and the student.
  - **`#/qafiya` — باحث القافية.** The رويّ is the AXIS, not a facet: it is the
    whole page until one is chosen and nothing is asked of the corpus before
    that, and البحر and العصر sit under it in the order the question is asked in
    («على الراء… من الطويل… في العصر العباسي»). It needed **no new server
    surface** — `/api/baits?rhyme&meter&era` is fame-first already and
    `gb_chain(rawiyy, era_id, meter_id, …)` covers exactly that shape (10 ms for
    the fattest رويّ). The grid's cell numbers cost nothing either:
    `meta.letters[].endsWith` is `COUNT(*) … GROUP BY rawiyy` over `game_baits`,
    which is precisely what `/api/baits?rhyme=` then counts, so the number on
    the cell and the number over the results agree BY CONSTRUCTION. There is no
    sort control (fame-first is the whole value) and the narrowing chips carry
    no counts (the only counts available are of قصائد, and a number answering a
    different question than the list under it is worse than none). On a phone
    the well FOLDS once a رويّ is chosen — 4 × 28 wells is 945px at 390, i.e. the
    whole alphabet standing between the poet and every answer — into one line
    plus a bottom sheet, the browse rail's own move. `.qaf-picker` is built once
    and rendered in whichever surface applies.
  - **`#/buhur` — صفحة البحور.** Grouped by **دائرة**, because الخليل did not
    name sixteen metres, he drew five circles and read the metres off them —
    `DAWAIR` in `client/data/buhur.ts`, with `daira` on every بحر and one `note`
    (المتدارك is الأخفش's, and sixteen tidy cards under الخليل's name would
    credit him with a بحر he never named). Each card teaches with four things in
    order: التفعيلات as countable CELLS, the مفتاح, a voweled بيت from the
    ديوان, and those same تفعيلات printed again under it — the repeat is the
    teaching device. `?b=<slug>` is a scroll target, not a filter.
    Two things the §8 screenshots changed and both are load-bearing: the cards
    are ONE per row at the ديوان's 58rem measure (three-up gave each شطر 150px
    of Amiri and the شاهد broke over three lines), and the card is CENTRED (every
    other band is short, so set against the inline edge they left two thirds of
    the card empty around an optically-centred بيت).
- **وضع القراءة** (`client/views/PoemReader.tsx`, `client/store/readerStore.ts`,
  `client/styles/reader.css`). `#/poem/<id>?read=1` is the قصيدة with every bar
  stood down — masthead, app bar, tab bar and footer — on the DESKTOP as well as
  the phone. It is a ROUTE, not component state, which is what gives it three
  exits for free (browser back, hardware back, a shared link that opens into
  it); `pageKey` drops the flag, so entering and leaving is not arriving at a
  new page. The reader renders INSTEAD of the ديوان entry, not over it (two
  copies of a قصيدة is two of every `id="bayt-N"` anchor), so the page's scroll
  offset is handed to the store on the way in and given back on the way out.
  `body[data-immersive]` now carries WHICH whole-screen this is — `game` or
  `read` — and every rule in phone.css and reader.css names the value, so the
  docked game layout and the reading can never reach each other. The type size
  is `settings.verseSize`, the قصيدة page's own persisted choice; reader.css
  re-declares the `--fs-bayt-*` SCALE those three names resolve to rather than
  adding a fourth size or a second preference. Keep-awake is the duel's plugin,
  taken on mount and released on exit; the exit is registered the way the duel's
  resign is, so `nativeInit` asks the reading first and the مساجلة second.
- **Stylesheets, in cascade order** (`client/main.tsx`): tokens · base ·
  components · bayt · views · **poets** · app · duel · duel-teach · training ·
  palette · auth · **room** · **anthology** · **qafiya** · **buhur** ·
  **reader** · **chrome** · **sheet** · **phone** · **motion**.
  The three before motion are the PHONE and they sit there because they must win
  over every view sheet above them: `chrome.css` is the two bars and «المزيد»,
  `sheet.css` the bottom-sheet primitive, `phone.css` the screen patterns (the
  docked game screen, the full-screen search, the touch floor). Every rule in
  all three is scoped either under a `body[data-…]` attribute App.tsx writes or
  under one of that sheet's own new classes — `.appbar*`, `.tabbar*`,
  `.morelist`, `.moregroup*`, `.morerow*`, `.moreabout*`, `.sheet*`,
  `.fsearch*` — and `client/styles/styles.test.ts` fails if a bare selector
  appears in any of them. They all load after views.css, so the `.letter-well`
  trap below is live for all three. Note what the scoping buys beyond safety:
  `.sheet__body .facet-rail` restyles the browse rail only where it has been put
  INSIDE a sheet, and the desktop's column is untouched by the same declaration.
  `anthology.css` owns المختارات المنظومة whole — `.anth-*`, every class new —
  and `styles.test.ts` fails if a selector there does not LEAD with one, or if
  it ever names `.bayt`/`.sadr`/`.ajuz`: a shelf frames أبيات, it does not set
  them. `qafiya.css` (`.qaf-*`) and `buhur.css` (`.buhur-*`) are held to the
  same rule by the same test, and for a sharper reason: both DECORATE
  components earlier sheets own — the 28-cell `.letter-well` grid, `.chip`,
  `BaytPlate` — which is the exact shape of the `.letter-well` defect below.
  `diwan.css` (`.diwan-*`, `.diwans-*`, `.dw*` — `.dwplay*` is the play/memorise
  panel at the foot of a shelf) is الدواوين and is held to the
  same LEAD-compound rule for the same reason: it decorates `.view`,
  `.view__head`, `.btn` and `BaytPlate` rows, all of which earlier sheets own,
  and `styles.test.ts` also fails if it names a `.bayt`/`.sadr`/`.ajuz` — a
  shelf FRAMES أبيات, `BaytPlate` sets them. Two things it had to learn from
  `.view__head`: that head is `justify-items: start`, so a panel built on it
  needs `stretch` (a dissolving rule inside one came out zero-wide) and `gap: 0`
  (its own sp-2 is added to every margin below it). Three more the §8 read of
  its own screenshots moved. `.dwplay` — the play/memorise colophon at the foot
  of a shelf — is CENTRED: it is 928px of the ديوان's measure at 1440 and every
  child of it is short (title 158, count 161, the three doors 477, the note
  608), so `justify-items: start` left 320px of a corner-pieced frame empty,
  which is `#/buhur`'s card defect one page over. `.dwcard` is a flex COLUMN
  with `margin-block-start: auto` on its foot, because cards stretch to the
  tallest in a row and one without a وصف piled its slack UNDER the foot — the
  hairline over the date sat 19px higher on two cards of three. And
  `.dwplay__rule` is `.friend-row`'s shape (a 6.5rem name column, then the
  control, stacking under 560px) rather than a stack at every width: «ضدّ صديق
  في هذا الديوان» is a short form of «غرفة مساجلة» and the two dialogs may not
  lay the same row out differently.
  qafiya.css deliberately DOES reach `.letter-well__ch`, to set the disc one
  step larger on the one page where the letter IS the subject, and
  `styles.test.ts` fails if it does so from anywhere but `.qaf-picker` — the
  class that also lets ONE picker render inline on a desktop and inside a
  bottom sheet on a phone.
  `reader.css` owns وضع القراءة — `.reader*`, every class new — and is
  held to the same LEAD-compound rule, with `body[data-immersive="read"]` the
  one other selector it may open with. It is the sheet that deliberately DOES
  reach a `.bayt-row` (a بيت being read gives its action rail back to the
  verse), which is exactly why the guard is there: a bare `.bayt-rail` in it
  would take the four actions off every بيت in the app. `room.css` owns
  `#/room/<code>` and
  the «ضدّ صديق» dialog — `.room-*`, `.seat*`, `.friend-*` — and every class in
  it is new, because it loads after views.css (see the `.letter-well` invariant). `poets.css` owns #/poets and #/poet whole — `.poets-*`,
  `.pcard*`, `.letter-rail*`, `.letter-head*`, `.medallion*`, `.era-*`,
  `.poet-*` — and the `--row-poet` half of the row-height contract.
  Two classes the ديوان مساجلة added to sheets it does not own, both new and
  both scoped: `.duel-scope` (duel.css — «الخصم لا يُنشد إلا من ديوان «…»»,
  web only; the phone's docked game screen says it in the app bar instead) and
  `.room-chip--diwan` (room.css — the shelf as one of the room's RULES, and the
  only chip in that row that is a door).
  `motion.css` is LAST and owns the app's motion vocabulary: `--dur-micro`
  180ms / `--dur-enter` 360ms / `--ease-enter` `cubic-bezier(.22,1,.36,1)`,
  the `qr-*` keyframes, the `data-enter` + `--enter-i` entrance utility (at
  most EIGHT staggered steps, 60ms apart), and the hover micro-interactions
  it can add to chips, buttons and letter wells without editing their sheets.
  Reduced motion is honoured in two places: base.css collapses every duration,
  and motion.css sets `--stagger: 0ms` and drops the hover transforms — a
  collapsed duration with a live DELAY leaves the element invisible for the
  delay and then snaps it in.
- `vite.config.ts` also trims the bundle: `dropWoffFallbacks()` is an
  `enforce: "pre"` transform that strips fontsource's `, url(…woff)
  format('woff')` fallback before `vite:css` reads the url()s, so `dist/` is
  woff2-only (1.5 MB → 1.1 MB). Do this at transform time, never in
  `generateBundle` — see §Backlog for why the hash makes that a trap.
- `client/training/` is تحفيظ's brain, all pure and all tested: `schedule.ts`
  (SM-2-lite + `buildQueue`), `grade.ts` (normalized Levenshtein + the word
  diff), `arsenal.ts` (supply / demand / weakness). The views hold no
  arithmetic. `client/store/trainingStore.ts` owns the slice.
  **`buildQueue` takes a `letter`, and it restricts BOTH halves of the plan.**
  `#/train/drill?letter=<L>` is what «ذاكِر حرف ج» in the ترسانة opens, and the
  letter used to bias only which NEW أبيات were fetched — while the due half was
  whatever the deck owed, which is full of the cards the PREVIOUS letter's
  session had just introduced, all of them due immediately. So tapping ظ and
  then ج drilled ظ both times: the heading changed and the card did not
  (measured on a real deck). Keying the view on the letter does not fix it; the
  filter does.
- Client route map — `#/` home · `#/poets` · `#/poet/<slug>` ·
  `#/poem/<publicId>?bayt=N&read=1` (`read=1` is وضع القراءة — the flag is a
  switch, and only that one value turns it on) ·
  `#/browse?era&meter&theme&rawiyy&letter&sort&p` ·
  **`#/qafiya?rawiyy&meter&era&p`** (باحث القافية — التصفح asked a poet's
  question instead of a reader's; its own `QafiyaQuery`, and its بحر narrowing
  takes only one of the SIXTEEN) ·
  **`#/buhur?b=<slug>`** (صفحة البحور; `?b=` is a SCROLL TARGET, not a filter —
  the other fifteen cards stay on the screen) ·
  `#/search?q&p` · **`#/duel?poet=<slug>`** (مساجلة في ديوان شاعرٍ بعينه — the
  SETUP screen with one «قيد» already set, which is where «ساجِل من ديوانه» on
  `#/poet/<slug>` lands; the picker keeps the hash honest with a `replace`, and
  `pageKey` calls it the same page so setting the قيد does not scroll)
  `#/duel/play` `#/duel/summary` · `#/daily` ·
  `#/favorites?collection` · `#/rules` · `#/stats` · `#/wander` ·
  `#/anthology` `#/anthology/<slug>` (المختارات المنظومة; the slug is validated
  against `shared/anthologies.ts` and an unknown one falls back to the strip,
  not to home) ·
  **`#/diwans`** (دواويني — the shelves YOU compiled) and
  **`#/diwan/<CODE>`** (one ديوان — and at its foot the three doors: «ساجِل في
  هذا الديوان» starts a solo مساجلة whose OPPONENT is confined to the shelf,
  «ضدّ صديق في هذا الديوان» opens a room where BOTH players are, and «أضِفه إلى
  التحفيظ» turns its resolved أبيات into local SRS cards; TEN letters of the
  room alphabet, upper-cased
  by the router, and the code is the CAPABILITY — there is no `?k=` because
  there is no second secret. An unknown or malformed code falls back to
  `#/diwans`, not to home) ·
  `#/train` `#/train/drill?letter=<L>` `#/train/arsenal` · `#/u/<username>` ·
  `#/more` (the phone chrome's fifth tab; it renders on the desktop too, where
  nothing links to it, because a route that 404s on a pointer type would be
  worse than one nobody visits) ·
  `#/room/<CODE>` (six letters, upper-cased by the router — the code is spoken
  before it is typed, so «badiru» and «BADIRU» are one room and one URL).
  All of them render a
  real view now; «التحفيظ» is in the masthead nav and `#/wander` is reached by
  `g w` (the arsenal's «تدرّب» is what carries the `?letter`).
  The switch is the `Body` function in `client/App.tsx`: add a `case`, touch
  nothing else. The keymap is `useKeyboard` in `App.tsx` **and**
  `client/data/shortcuts.ts` (HelpOverlay renders the latter) — add to both or
  to neither, and make the label say what the key does.
- **A MODIFIER chord cannot live in `useKeyboard`.** It returns early on
  `ctrlKey`/`metaKey` and on every key that arrives from a field — right for
  `/` and `?`, wrong for `Ctrl+K`/`Ctrl+F`, which must fire while the reader is
  typing into the duel's answer box AND must beat Chromium's find bar. Those
  two live in `PaletteHost` (`client/components/Palette.tsx`) as ONE
  window listener in the **capture** phase that `preventDefault`s and
  `stopPropagation`s — which is also what keeps them from reaching the
  bubble-phase window listeners the views own (RecitationReveal's «any key
  skips», the drill's grades). They are still listed in `shortcuts.ts`.
  The palette is the search door: «البحث» is no longer a navlink (the masthead's
  ⌕ trigger opens the palette instead), and `#/search` is kept for the full
  result list and deep links.

### Invariants (hard-won)

- **Only the OUTERMOST middleware may set a response header and expect it to
  ship.** `@hono/node-server` swaps in a lazy `Response` whose headers live in a
  side cache, and hono's `c.header()` rebuilds that response from its ORIGINAL
  init (`hono/dist/context.js:213`) — so when `compress()` adds
  `Vary: Accept-Encoding` on the way out, every header an inner middleware wrote
  onto `c.res.headers` is silently dropped. It is invisible in tests, because
  `app.request()` sends no `Accept-Encoding` and `compress()` returns early.
  `Cache-Control` therefore lives in the security-header middleware at the top
  of `createApp`.
- **«القيود» narrow the OPPONENT, and a شاعر is the one that does not fit
  `combo_counts`.** `GameFilters` is five optional slugs (`era`, `meter`,
  `theme`, `poet`, `lang`) and it reaches `pickBait` / `hintCandidate` /
  `switchLetterBait` only — `verifyAnswer` never reads it, which is the whole of
  the setup screen's «تحصر ما يُنشده الخصم، لا ما تُجيب به أنت» and is what
  makes «مساجلة في ديوان المتنبي» playable by a human at all. Three things a
  شاعر changes that عصر×بحر did not, all measured on `build_id d1a38337`:
  (1) `combo_counts` is keyed `(letter, era, meter, tier)`, so it cannot count a
  شاعر — `poolByLetter` in `server/game.ts` is the one door, the point lookup
  when the قيود stay on `game_baits` and one memoised grouped scan (`poems_poet`
  → `gb_poem`, 6.2 ms on ابن الرومي, the fattest ديوان) when they touch `poems`.
  `comboCount`'s dead-end short-circuit is still sound on top of that, because
  a filter that only NARROWS cannot turn a zero into a row.
  (2) `weightedLetters` picks the opening letter off that same distribution.
  Off the corpus's instead, eight globally-fat letters are eight letters a
  شاعر of nine أبيات often never opens on: 136 of 2,400 poet-scoped openings
  answered «لا يوجد بيت» over a ديوان that plainly had one.
  (3) A zero is ORDINARY now. «فحل» is `fame <= 2` and fame is a property of the
  شاعر, so every famous ديوان is exactly 0 there and thousands at the رتبة it
  relaxes into (`poolTierIsEmpty` says so in words rather than printing a bare
  0); and 2,488 of the 6,941 شعراء have NO playable بيت at all — 39.8% of قصائد
  carry no بحر and `game_baits` admits only `kind='bahr'` — so «0 بيتًا» under a
  chip reading «443 قصيدة» needs its own sentence (`poolIsEmpty`), not
  «قليل؛ قد ينقطع الخصم سريعًا».
  The client half: `DuelConfig.poetName` denormalizes the display name beside
  the slug (`Exchange`'s rule — a قيد the reader cannot read in an offline
  summary is not a قيد he set), and the شاعر picker stars its last token
  (`poetQuery`) because FTS5 matches whole tokens and «المتنب» otherwise found
  nothing until the ياء landed. That star is affordable ONLY under
  `scope=poets`: 6,941 rows, never `baits_fts`.
- **المختارات المنظومة are anchored by مطلع + شاعر, and resolved at RUNTIME.**
  `shared/anthologies.ts` holds two curated shelves — the ten المعلقات and مئة
  بيت سائر — and not one entry in it is an id. Three reasons, and all three are
  load-bearing. `public_id` is `q<row id>` for 73% of قصائد and MOVES on every
  rebuild, so a table of ids rots at the next `npm run ingest`; a مطلع does not.
  The resolution therefore needs no re-ingest and no new column — it is one FTS5
  phrase per entry over `baits_fts`, folded by `shared/arabic.ts` on both sides,
  memoised per DB handle and pre-warmed at boot by `warmAnthologies` (110 entries,
  167 ms cold, `setImmediate` between each — `warmFacets`' shape, and for the
  same reason: HOME asks for the shelf counts on first paint). And the شاعر is
  half the ANCHOR, never decoration: 21,739 صدور carry a different روي under a
  different name, so on words alone «سئمت تكاليف الحياة» resolves to أبو نصر
  النحاس and «أقيموا بني أمي» to ابن عديّم الرواحي — both real rows, neither the
  poet the anthology names. Two rules fall out. An entry the corpus cannot
  answer is still an ITEM (`poem`/`bait` null, «ليست في الديوان» on the shelf) —
  a المعلقات that printed nine odes and called it ten would be lying about the
  ديوان. And a curated attribution the corpus contradicts is DROPPED, not
  bent: «إذا بلغ الفطام لنا صبي» is عمرو بن كلثوم's and the artefact files it
  under عنترة, so it is simply not on the shelf.
- **A ديوان is a PLAYLIST: a قصيدة is ONE entry.** `album_entries` (migration
  11, replacing `album_baits` — every old row carried over as a `bait` entry in
  place) holds two KINDS on one ordered list: `poem`, a whole قصيدة, and
  `bait`, the single line that stood out. The first shape stored only أبيات,
  so «أضِف القصيدة» exploded a forty-بيت قصيدة into forty rows and two قصائد
  added back to back read as one unbroken run of verse; a reader thinks of a
  ديوان as a folder of poems he can hand to somebody, and the page now draws it
  that way — a قصيدة is a CARD (`.diwan-poem*`: عنوان or مطلع, the مطلع under
  it, شاعر · بحر · length, the whole card a link) and a بيت is a `BaytPlate` row
  with its full rail. The two CHECKs in the DDL make the row shapes exclusive
  (`poem_key` and the title/count snapshot columns exist iff `kind='poem'`).
  Everything a قصيدة entry touches follows from «one entry, opened at play
  time»: `/api/albums/:code/entries` takes a قصيدة by PUBLIC ID (true today,
  the one thing the poem page honestly knows) and the SERVER derives its
  anchor; `albumPool` opens each قصيدة into its أبيات in shelf order (one point
  lookup on `poems.dedup_key`, one range read on `baits_poem_pos`, capped at
  5,000 أبيات a shelf so a hostile reader's fifty دواوين cannot grow the memo
  into gigabytes); «أضِفه إلى التحفيظ» FETCHES the قصائد on the press
  (`gatherAlbumBaits`, client/albums/memorize.ts — the fetcher is injected, so
  the gathering is tested against a table), capped at `ALBUM_LIMITS.memorize`
  cards a sitting and saying what it left; and the share text, the cards and
  the head all count through `formatAlbumContents(poems, baits)` («7 قصائد
  و12 بيتًا») because «19 مدخلًا» would be honest and meaningless. The «⋯»
  sheet («أعِد القصيدة كاملة» / «أزِل القصيدة كلها») and `regroup.ts` are GONE:
  both existed only because a قصيدة was forty rows, and a قصيدة that is one
  row is removed with the same ✕ a بيت is.
- **A ديوان a READER compiles is anchored by CONTENT too, and the code is its
  only credential.** `albums` lands at `PRAGMA user_version` 8 (`saved_albums`
  at 9, `rooms.album_id` at 10, `album_entries` at 11)
  and `server/routes/albums.ts` is the only thing that reads them. Four things
  are load-bearing and each of them was a choice against an easier one.
  (1) **The anchor is CONTENT, never an id — `baits.h_full` for a بيت and
  `poems.dedup_key` for a قصيدة.** `public_id` is `q<row id>`
  for 73 % of قصائد and every id in the artefact moves on `npm run ingest` (the
  d1a38337 rebuild moved 442 قصائد), so a shelf of ids would quietly re-point at
  other people's poetry — the worst failure available to a collection whose only
  value is that the reader chose these lines. `baitAnchor` in `shared/arabic.ts`
  is exactly the hash `scripts/ingest/transform.ts` writes (one normalizer, one
  hash, spelled once), carried as a DECIMAL STRING because JSON has no 64-bit
  integer, and `baits_hfull` makes re-finding a بيت a point lookup. It is null
  for a بيت with no عجز — `transform.ts` writes no `h_full` for those either —
  so «أضِف إلى ديوان» simply does not offer itself on one. A قصيدة's anchor is
  its `dedup_key` — `nameKey|مطلع`, the ingest's own decision about which rows
  are one قصيدة, UNIQUE on `poems` after pass 0 and stable where every id is
  not — stored whole in `poem_key` for the lookup and HASHED for the wire
  (`poemAnchor`, `p` + the decimal fnv1a64): a dedup key is Arabic text up to
  1,763 characters long in the corpus, and an identity that must fit in a URL
  path segment cannot be that. `PoemAnchorSchema` / `BaitAnchorSchema` are
  distinguishable by the prefix, which is what lets one `order` list and one
  DELETE path carry both kinds.
  (2) **The snapshot is the floor, and the SERVER writes it.** `{sadr, ajuz,
  poet}` for a بيت — and `{title, sadr, ajuz, poet, baitCount}` for a قصيدة,
  its مطلع standing in for the whole — is taken at the moment of adding, so an
  entry the artefact can no longer answer still renders as what it was, marked
  «ليس في الديوان اليوم» rather than silently gone — المختارات المنظومة's rule
  («an entry the corpus cannot answer is still an ITEM») applied to a reader's
  own shelf. The client sends a hash or a public id and nothing else: a
  client-supplied «poet» would be a client-supplied attribution on a page
  carrying somebody's name, so an item the artefact refuses is a 404, never a
  stored row.
  (3) **The CODE is the capability, so it is ten letters and not six.** A room
  code is six because it is spoken in the minute before a مساجلة and
  `rooms.join_key` is the credential behind it; a ديوان has no knock and no
  second secret, so its code has to BE one — 14⁵ × 5⁵ = 1.68 billion of the same
  speakable alphabet. And `private` answers a non-owner with `album_not_found`,
  never 403: distinguishing «wrong code» from «not yours» turns the code into a
  probe that says warmer. `/albums/mine` is the ONLY listing; no route
  enumerates another account's دواوين at all.
  (4) **المكتبة is an EDGE, and the gate is re-read, never written down.**
  `saved_albums(user, album)` at migration 9 holds a reader's «أضِف إلى مكتبتك»
  and NOTHING else — no title, no count, no copy of the أبيات — so the curator
  keeps curating and the row follows him. That is also what makes the retraction
  honest: a shelf its owner takes back to `private` closes for everyone who kept
  it in the same instant, because the listing asks the album's CURRENT
  visibility rather than a flag copied at save time. The row is NOT deleted with
  it (`SavedAlbumSchema.gated`: `private` | `blocked`, `album: null`) — it stays
  sayable and removable, with nothing of the shelf on it, which is why
  `DELETE /:code/save` is the one album route deliberately NOT behind the read
  gate: the row a reader most needs to remove points at a shelf `readable`
  refuses. A block, either way round, gates a saved row the same way.
  (5) **ONE listing of another account's shelves exists, and PUBLISHING is what
  opens it.** `GET /api/profile/:username` carries the account's `public`
  دواوين — never the `unlisted` ones, whose link IS the capability, and never a
  `private` one. So «مفتوح» means «show this on my page», the client says so in
  a confirmation before the first press, and a block in either direction empties
  the shelf for the blocker. There is still NO global feed and that is the
  decision, not an omission: a wall of strangers' دواوين is a moderation queue
  (§Backlog). A ديوان itself is UGC for the same reason a display name is — its
  اسم and وصف are a reader's words on a page carrying his name — so `/api/report`
  takes an `albumCode`, DERIVES the reported account from the shelf's owner
  (never the `targetUsername` beside it, which would let a client file against a
  third party), refuses a shelf the reporter cannot open, and the admin
  allowlist gains exactly two actions over one: unlist it and clear its وصف.
  Deleting a reader's collection is not among them.
  (6) **Its own rate bucket, not the profile's.** Same shape (per-IP token
  bucket, ten-minute window) at 60 rather than 20, because pressing «أضِف إلى
  ديوان» twenty times in ten minutes is a slow afternoon and not abuse; the
  50/300/120 caps are what actually bound the data. `GET /api/albums/*` is
  `private, no-store` (`isOwner` rides in the payload), the sub-app mounts
  INSIDE the corpus gate (resolution needs the artefact), and resolution is
  memoised per `(album, updated_at)` — every write helper stamps `updated_at`,
  so the memo invalidates by construction rather than by anyone remembering.

- **A ديوان is PLAYED as a pool of ids and JUDGED as a set of anchors, and the
  two are not interchangeable.** `server/albumGame.ts` is the one place a shelf
  becomes a game, and it hands back both because they answer different
  questions. `game_baits` is keyed on `bait_id`, so the OPPONENT's pool must be
  ids — one per بيت, the best-ranked playable copy (`po.fame DESC, b.position
  ASC, b.id ASC`, the anchor's own order), because two copies of one بيت in the
  pool would let it be recited twice: the duel's exclusions are by id and the
  second copy is a different id in a different قصيدة. Membership, on the other
  hand, is `baitAnchor` over the MATCHED بيت — the corpus holds the same بيت
  under up to 51 ids, and a player who quoted another copy of a بيت that IS on
  the shelf has answered from the ديوان. An id test there would be the exact
  failure the anchor design exists to prevent, one layer in.
  Five more things, all decided rather than fallen into.
  (a) **The pool is a CONSTRAINT, not a «قيد».** `pickBait` drops the filters
  rather than concede («خرج عن القيود», amendment 16's farm), and it must never
  drop this one: reciting outside the shelf is the one thing the feature exists
  to prevent. So `poolBaitIds` rides through the relax untouched and a dry
  letter CONCEDES — «أفحمتَ الخصم» over a thirty-بيت shelf is the honest
  outcome, not a bug. `GbCond.pooled` also nulls `combo`: `combo_counts` is
  keyed (letter, عصر, بحر, رتبة) and knows nothing about which ids are on a
  reader's shelf, so `weightedLetters` scans the ≤300-row pool instead — the
  شاعر lesson, one shelf smaller.
  (b) **The client carries the pool, and that is not a hole.** The solo duel is
  stateless by design (design-server.md §8), the pool can only NARROW what the
  machine says, and it decides nothing about the player's own answers, which
  are still verified against the whole corpus. `[]` means «no ديوان»; an empty
  pool that was ASKED for is `impossible`, never a silent widening.
  (c) **FOUR numbers, and the door says the last two.** `count` (entries on
  the shelf), `resolved` (today's artefact can still find them), `baits` (the
  أبيات those entries amount to once every قصيدة is opened) and `playable`
  (`game_baits` will serve them). 39.8 % of قصائد carry no بحر, so a thirty-بيت
  ديوان is often a twelve-بيت مساجلة; the floor is `ALBUM_LIMITS.playableFloor`
  = 10 playable أبيات, said in words on a shut door rather than enforced in
  silence. And `baitIds` on the WIRE is cut at `ALBUM_LIMITS.pool` (1,000) in
  shelf order while `playable` is not: the solo duel carries the pool on every
  request and a playlist of long قصائد does not fit, so when the two differ the
  door says which part of itself the opponent recites from. The ROOM reads the
  shelf server-side and is not bound by that cap.
  (d) **The room's refusal is SOFT.** «ليس من هذا الديوان» is a real بيت on the
  required letter that is not on the shelf — `wrong_letter`'s shape, not
  `not_found`'s — so it costs no strike, writes no `match_turns` row and leaves
  the turn where it is (`COSTS_LIFE` in RejectionCard.tsx is the philosophy;
  `not_in_album` is deliberately not in it).
  (e) **The room READS the shelf, it does not copy it.** `rooms.album_id` and a
  live lookup per turn, the same choice `saved_albums` made: a curator who
  prunes his shelf mid-match has pruned the game, and a snapshot taken at
  creation would let the room disagree with the page both players are looking
  at. A deleted ديوان sets the column null and the match finishes as an
  ordinary one.

- **صفحة البحور's sixteen شواهد are a MEMO, because the two obvious doors were
  measured and both are worse.** `#/buhur` needs one exemplar بيت per بحر, and
  the shape that looks right is `/api/baits?meter=<slug>&limit=1` — fame-first
  already, and shipped. On `build_id d1a38337` it is **560 ms** for الطويل and
  2.3 s to fill the page: no index leads with `meter_id`, so SQLite skip-scans
  `gb_rand` and sorts the survivors in a temp b-tree, and every one of those
  milliseconds is on the one event loop. Sixteen client-side
  `/api/poems?meter=&sort=fame` calls are affordable ONCE (45 ms worst, 192 ms
  total, over `poems_meter`) but are paid again by every reader forever, and
  cannot express the gates this page needs because they are not facets of the
  ديوان. So `/api/buhur` is one narrow query per بحر — **25 ms worst, 97 ms
  total cold** — memoised on the DB HANDLE in a WeakMap (`slugMaps` /
  `facets.ts` / `anthology.ts`'s shape) and pre-warmed by `warmBuhur`, whose
  worst single turn is under `warmFacets`' documented 69 ms. After the warm the
  page costs the corpus nothing at all. This is §Backlog's rule (c) answered the
  way that rule says to answer it: a route that can run long needs an index, a
  narrow-subquery sort, or a memo BEFORE it ships.
  The three gates on the example are about TEACHING, not fame: no
  `meter_variant` (a مجزوء does not scan against the تفعيلات the card prints
  under it), `has_tashkeel` (you cannot hear مُتَفاعِلُنْ unvoweled), and 5–40
  أبيات (a fragment is not a قصيدة, and neither is a ديوان scraped as one poem).
  `textIsClean` then walks the window, as بيت اليوم does. A بحر the corpus
  cannot answer is still an ITEM with a null بيت — its card still has its مفتاح.
- **`shared/arabic.ts` is the only normalizer.** FTS index, chain-letter
  derivation, client live letter indicator, search highlighter and `dedup_key`
  all call the same functions. A second copy of "strip tashkeel" is a bug.
- **`poets.letter`, `poets.sort_key` and `poets.name_key` are DERIVED at
  ingest** — by `sortName()`/`shuhraLetter()` in `shared/arabic.ts` and by
  `canonicalNameKey()` in `shared/poetAliases.ts`. Editing either of those three
  functions without re-ingesting desyncs the artefact from the code: the letter
  rail groups on the stored `letter` while the client computes its live
  indicator from the function, and they silently disagree. `test/fixtureDb.ts`
  lists both files among the fixture's staleness inputs for the same reason.
- **Never read the `poem description` column.** It is a 5-level nested DOM
  struct and roughly half the parquet. `readRecords` column-projects the 11
  flat columns; adding the 12th turns a 3-second pass into an OOM.
- `server/index.ts` binds 127.0.0.1 **and ::1** — cloudflared resolves
  "localhost" to ::1 first, and dropping the twin bind 502s the tunnel.
- CSP includes `font-src 'self' data:` — vite inlines small font subsets as
  data: URIs and the smoke test fails on the violation without it.
- The database is a **build artefact**: opened `readOnly` + `query_only=1`,
  never written at runtime. A missing `data/qarid.db` is tolerated at boot
  (`openDbIfPresent` → null); `/healthz` and the static client still serve and
  `/api/*` answers 503, so systemd never crash-loops on a fresh box.
- **`data/qarid-users.db` (`USERS_DB_PATH`) is the ONE writable database** —
  accounts, sessions, the opt-in ترسانة snapshot, v2 §5's `rooms` /
  `match_turns`, at migration 8 `albums` / `album_baits`, at 9
  `saved_albums` (+ `user_reports.target_album_id`), at 10 `rooms.album_id`
  (ON DELETE SET NULL — deleting a ديوان must not delete the مساجلات played in
  it) and at 11 `album_entries` (a ديوان as a playlist — `poem` and `bait`
  entries on one list; `album_baits` dropped with its rows carried over, and
  `migrate(raw, upTo)` exists so a test can seed the old table and run the
  step), all created by
  `server/users.ts`'s `PRAGMA user_version` migrations (WAL,
  `foreign_keys = ON`). It fails the same tolerant way the
  corpus does: `openUsersDbIfWritable` returns null on a read-only `data/` and
  `/api/auth/*` answers 503 rather than crashing the boot — and it PROBES with
  a `BEGIN IMMEDIATE`, because a file that opens and reads fine in a directory
  the process cannot write to only fails at the first INSERT, in front of a
  reader who just typed a password. `/api/auth/*` and `/api/profile/*` are the
  two prefixes exempt from the corpus 503 gate in `app.ts` (they need no
  corpus) and the two that are `private, no-store` (they are per-cookie).
  Passwords are scrypt + `timingSafeEqual`; the sessions table stores only the
  SHA-256 of the cookie's token. There is no email and therefore no reset —
  the owner edits a row (README §Accounts). One trap when you SMOKE a
  signed-in flow: the cookie carries `Secure` whenever `PUBLIC_ORIGIN` is https
  (the default), and a browser silently drops a `Secure` cookie from
  `http://127.0.0.1` — so a screenshot run that has to log in must pass
  `PUBLIC_ORIGIN=http://127.0.0.1:<port>` alongside `USERS_DB_PATH`.
- **A مساجلة room is decided ENTIRELY server-side, and every message is the
  whole room** (v2.md §5, `server/rooms.ts`). The clock is a column
  (`rooms.turn_deadline_at`), the turn order is derived from the rows in
  `match_turns` and never from a counter, the exclusions are read back off
  those rows on every turn, and an answer goes through the same `verifyAnswer`
  the solo duel calls. Three things fall out of that and are not features:
  a reconnect is just another `state` event (nothing to merge); the polling
  fallback `GET /api/room/:code/state` is the same snapshot the socket pushes,
  so there is ONE code path; and a dropped socket forfeits nothing, because the
  only thing that can end a turn unanswered is a timestamp in the database.
  A fourth thing the snapshot carries, and it is presence rather than truth:
  **`atDoor` says somebody has the room OPEN and has not entered it**, on the
  host's snapshot only and while the room is `waiting` only. It is read off the
  socket hub, not off a row — a keyed guest holds a socket from the moment his
  lobby paints — because the KEYED link, the normal way into a room, used to be
  the silent one: he saw «ادخل حين تكون مستعدًّا» while the host still read
  «تبدأ المساجلة لحظة دخوله», which stopped being true when entering became a
  button, and both sides waited for the other. The socket's `onOpen` therefore
  broadcasts for a non-seated arrival too, but ONLY on a waiting room — the
  N(N+1)/2 fanout the socket caps guard against is a LIVE room with spectators,
  and a waiting room has two people on it.
  That last one has a sharp edge: `POST /:code/turn` is the ONE async handler,
  so a row loaded before `await parseBody` is a row a concurrent turn can have
  moved underneath it — judging the stale `turn_deadline_at` ended matches on a
  timeout that never happened. `resolveExpiry` re-reads the row by id now; a
  caller's snapshot says WHICH room, never what is in it.
  Two rules inside that: `match_turns` holds the host's `opening` بيت, accepted
  `ok` أبيات and the two strike tags (`wrong_letter`/`not_found`), and only the
  first two are part of the CHAIN — so a strike does not pass the turn — while
  every other rejection the verifier can produce is feedback to the player who
  typed it, never persisted and never broadcast (a near-miss is a hint about
  what the other side almost knows). The room's `Cache-Control` lives in
  `cachePolicy` with the rest, `private, no-store`: `you.canPlay` is in the
  payload.
- **`SameSite=Lax` is not a CSRF defence HERE, because this box is a suite.**
  SameSite is computed on the REGISTRABLE DOMAIN, so meme., alchemy., vestige.,
  alexandria. and leyline.example.com are all *same-site* with
  qarid.example.com and their pages' requests carry `qarid_sess`. Measured
  before it was closed: a `text/plain` POST from a sibling renamed a signed-in
  reader's account, and `/api/room/:code/resign` threw their live مساجلة.
  `server/origin.ts` is the guard — `Sec-Fetch-Site` must be `same-origin` or
  `none`, and `Origin`, when present, must be `PUBLIC_ORIGIN` or the request's
  own `Host` — and it covers every non-GET plus the `/ws` upgrade. The second
  lock is `readJsonBody`: a body MUST declare `application/json`, the one
  content type a browser will not send cross-origin without a preflight, so the
  `<form enctype="text/plain">` shape does not exist. A request with NO `Origin`
  at all (curl, a test, a native client) is allowed — it carries nobody's cookie
  by accident.
- **A room CODE is a name; `rooms.join_key` is the credential.** Six speakable
  letters are 14³×5³ = 343,000 values, and `joinRoom` used to seat whoever
  arrived first — so a scan (measured at 6,412 `/state` probes a second before
  the limiter) could snipe every waiting room and read every live transcript,
  and the profile page published the codes to unauthenticated readers outright.
  The share link is `#/room/<CODE>?k=<24 chars>`; `POST /:code/join` and a
  non-player's `/state` or socket require it, a رجعة's named guest never does
  (his id is on the seat), and `snapshot()` sends `joinKey` and the keyed
  `shareUrl` to the two players only. Every `/api/room/*` path is under
  `ROOM_READ_LIMIT` (60/10 s/IP) on top of the duel's own bucket, and the
  WebSocket spends `SOCKET_FRAME_LIMIT` per USER — a per-socket counter is
  defeated by opening a second socket.
- **`/ws/room/:code` is cookie-authenticated on the UPGRADE**, which is the
  only authentication a WebSocket can have — a browser cannot set a header on
  one, but it sends `qarid_sess` with a same-origin upgrade like any other GET.
  The upgrade is where auth STARTS, not where it ends: the session is re-read
  on every inbound command (a deleted session row — README §Accounts' only
  remediation — must reach a live socket), the hub caps sockets per user and
  per room, and `onOpen` broadcasts only for a seated player (a spectator's
  arrival is what made attaching N sockets cost N(N+1)/2 full snapshots).
  So the socket URL is always same-origin (`client/store/roomStore.ts`
  `socketUrl`), `createApp` returns an `injectWebSocket` that `server/index.ts`
  must hand EVERY server it opens (127.0.0.1 *and* ::1), and `vite.config.ts`
  proxies `/ws` with `ws: true` — without that flag vite answers the upgrade
  itself and dev silently falls back to the poller while production works.
- **`fullPage: true` breaks mobile emulation in a screenshot.** Playwright
  re-emulates the device metrics to capture past the viewport and drops
  `hasTouch` while it does, so `(pointer: coarse)` stops matching and every
  `.keys-only` affordance a phone cannot use reappears in the shot (measured:
  the same element is `display:none` before the call and `display:block`
  during it). A phone pass takes VIEWPORT shots off a tall viewport;
  `tools/screenshot.mjs` already does. The same call is also why a sticky
  masthead appears again halfway down a long desktop shot.
- Derived accent vars live on `body`, NOT `:root` — the `[data-app]` override
  must compute first (family pitfall).
- Never `ORDER BY RANDOM()` on 2M+ rows; sample by the precomputed `bucket`
  column with a wrap-around window.
- `document.body.dataset.appReady = '1'` after first render — `tools/screenshot.mjs`
  waits on `body[data-app-ready="1"]`.
- localStorage keys are namespaced `qarid:v1:*`; the 255K-poem corpus never
  goes near localStorage (in-memory LRU only). **The `v1` in those keys is part
  of the NAME, not the schema version** — `PERSIST_VERSION` is 2 and lives in
  the `{v, data}` envelope. Renaming the keys to match would orphan every
  session on disk; bumping the version means adding a `MIGRATIONS[n]` step, and
  that step is run over EVERY slice sitting at version n, so it must recognise
  its own shape and hand the others back untouched.
- Never letter-space or italicise Arabic; logical properties only.
- **Western digits, and two traps that come with them** (amendments §25). The
  Amiri we ship is the `arabic` subset and carries NO Latin figures, so any
  number set in `--font-verse` falls through to whatever serif the OS has —
  `.bayt-num` is `--font-mono` for that reason. And a NEUTRAL character glued
  to a number flips to the wrong side under RTL: «×2», «1200 × 630» and «2–3»
  each need their own LTR run (`dir="ltr"`), while a leading LRM is what keeps
  «+152» / «−40» correct (rule W7 turns the digits L). The أطوال القصائد bin
  captions are derived by `histogramLabel()` from `min`/`max`, NOT read from
  `meta.stats_json`, because the artefact still holds «٢–٣» from before the
  decision and re-deriving them costs no re-ingest.
- **Anything that spawns `server/index.ts` MUST pass `USERS_DB_PATH`.** The
  server opens that path and MIGRATES it, and its default is the LIVE
  `data/qarid-users.db` — so a test or a tool that boots the real server
  without it runs the working tree's migrations on the production database
  while the deployed build is still serving it. Measured on 2026-09-12: the
  «booting with no corpus» test in `server/routes/facets.test.ts` pushed the
  live file to `user_version` 11 (dropping `album_baits`) under the v10
  server, and every `/api/albums/*` on the site answered a SQL error until the
  new build was deployed. `tools/screenshot.mjs` uses `data/smoke-users.db`
  and that test now uses a per-PID scratch file; a new spawn copies one of
  them. `migrate()` refuses to run BACKWARDS by design, so there is no undo —
  only a snapshot taken beforehand (`VACUUM INTO`).
- **The smoke walk is SIGNED OUT, so no owner-only surface is ever shot.** The
  ديوان's whole editing rail — reorder, remove, «احذفه» — exists only for
  `isOwner` and has never appeared in `screenshots/`. Read those with an
  account before believing a ديوان change is verified; the clarity defects the
  first shape had (an unlabelled ✕ reported as MISSING rather than as unclear)
  sat there through two releases because every screenshot of that page was a
  visitor's. The standing (not hover) danger tint on `.diwan-move--drop` and
  `.diwan-head__danger` under `(hover: none)` is what that walk taught.
- **The نِيب is drawn in FIVE places and generated into a sixth — change it in
  all of them.** The motif carried a "slit": `M6 21 12.2 14.8`, an ink stroke at
  55% meant to be the slot down a pen nib's spine. But the nib body is a curved
  crescent ~2.5 units thick and that line is straight, so most of it fell
  outside the gold and what showed was a dark nick clipped onto the tip — read
  by a reader, correctly, as "a dark slanted bar on the logo". It cannot be
  redrawn either: a 1.1-wide stroke inside a 2.5-wide crescent is an edge
  shadow, not a slit, and at the 13–22px the ornament actually renders at it is
  a smudge whatever its geometry. It is gone. The copies live in
  `client/components/Ornaments.tsx` (`Nib`), `tools/gen-icons.mjs`,
  `tools/gen-banner.mjs`, `docs/media/banner.svg` and
  `client/public/offline.html`.
- **The Android launcher icons are GENERATED, by `node tools/gen-icons.mjs`.**
  They were hand-made once and nothing regenerated them, so when the نِيب lost
  its slit in every source copy the launcher kept it — the one place the motif
  appears that no build step touched, and the one a reader sees every day. The
  script now writes `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`
  (legacy tile), `_round.png` (circle-clipped) and `_foreground.png` (the
  adaptive layer — TRANSPARENT, since `mipmap-anydpi-v26` pairs it with
  `@color/ic_launcher_background` #07080c, and at the maskable fraction so the
  نِيب stays inside the OS mask's safe circle). Re-run it whenever the motif
  moves, and commit what it writes.
- **A shallow gradient on a near-black ground MUST be dithered.** The
  illumination bloom and the vignette are both ~8% over #07080c, which is six
  sRGB levels across 900px — and eight-bit colour cannot draw that as a ramp. It
  draws PLATEAUS: measured runs of 456/159/135/124/120px of one identical value,
  separated by single-level steps, and on a good dark screen those step edges
  are visible as faint slanted bars (slanted because the bloom's washes sit at
  22%/14% and 78%/86%). It was reported as "a dark slanted bar in the logo",
  which is only where the eye happens to be — the wordmark draws nothing but its
  word and its hairline. `body::after` carries a 140px `feTurbulence` tile at
  3.5% as a data URI, and the same measurement then reads 9px. It goes on the
  STATIC layer, never the drifting bloom, or the grain crawls; and any new
  large, shallow, dark gradient needs the same treatment or it will band too.
- **`.gitignore` anchors `/data/`.** Unanchored, it also swallows
  `client/data/` — buhur tables, flavour أبيات, the keymap — and four source
  files sat outside the repo for three commits. Anchor every ignore rule that
  names a common directory — and ignore the DIRECTORY, not a glob inside it:
  `screenshots/*.png` matched only the top level, so every `--out
  screenshots/<name>` a smoke run wrote was staged by the next `git add -A`.
  It is `/screenshots/` now.
- **A FILLED transform animation is a containing block, so a modal must be a
  PORTAL.** `position: fixed` is measured against the viewport only while no
  ancestor is transformed, and motion.css gives `.route-swap` — the wrapper
  App.tsx puts around EVERY view — `animation: qr-rise … both`. `both` keeps the
  animation filling its `to` keyframe forever, that keyframe says
  `transform: none`, and Chromium resolves it to the IDENTITY matrix, not to
  `none`. So the wrapper is a containing block for the life of the page, and a
  fixed overlay opened from inside a view is laid out against the VIEW's box:
  measured on #/browse, `inset: 0` put the scrim at y = −647 and the sheet
  1,199px down an 844px screen — the page dimmed and nothing came up.
  `client/components/Sheet.tsx` and `PhoneSearch` both `createPortal` onto
  `document.body`, which is where a modal belongs anyway and is immune to
  whatever a future ancestor does. **And so does every `.overlay`**, through
  `client/components/Overlay.tsx` — there is no remaining case and no exception
  to remember. Five of the eight WERE inside a view and all five were broken:
  measured on #/duel at 390, the walkthrough's scrim sat at y = −1,237 with its
  «التالي» row 902–1,006px down an 844px screen, and the delete-account
  confirm's scrim ended 312px above the bottom edge, so `elementFromPoint` at
  the tab bar returned the tab's own svg and a reader could tap «التصفح» out of
  an irreversible confirmation. The three App.tsx mounts go through the same
  component even though they were never at risk, because a rule with an
  exception is a rule that drifts when a dialog moves.
- **`overscroll-behavior` needs a scroll container to hold.** A fixed box merely
  COVERING the page is not one, so a touch on it still scrolls the document
  underneath. `.sheet-scrim` carries `overflow: hidden` beside its `contain` for
  exactly that reason, and `body[data-sheet="1"] { overflow: hidden }` freezes
  the page under a sheet (the viewport takes its overflow from `body` because
  `html` declares none — the same route base.css's `overflow-x` already uses).
- **`body[data-immersive]` is a LAYOUT effect, and even that is not early
  enough for a child's passive effect.** Every rule in phone.css hangs off the
  attribute, so writing it after paint shows a frame of the scrolling web
  layout. But React flushes a child's PASSIVE effect before the commit that a
  parent's layout effect scheduled — so `ExchangeLog`'s «follow the newest بيت»
  asked the log whether it was a scroller and was told no. It takes a `docked`
  prop from the view (which knows) and retries on the next frame. The WEB path
  is left alone down to the call, because App.tsx's «a new page starts at its
  top» effect runs after it and a second pass there moved the desktop duel 468px
  down its own page.
  Two more rules the SECOND whole-screen (وضع القراءة) added to that attribute.
  It carries a VALUE — `game` or `read` — and every selector in phone.css and
  reader.css names it, because the docked game screen's `.main`/`.view` measures
  applied to a reading (or the reading's to a duel) is one attribute doing two
  jobs; `styles.test.ts` fails on a bare `[data-immersive]` in either sheet. And
  the قصيدة page's scroll offset is captured at the PRESS (`rememberEntry` in
  `openReader`), never in the reader's own effect: by the time the reading is
  mounted the page has handed its DOM over, the document is one viewport tall
  and the browser has already clamped `scrollY` to 0. It is read back exactly
  once (`takeEntry`), so a stale offset cannot be applied to a later
  navigation. What comes back is the بيت, not the pixel — Chromium's scroll
  anchoring adjusts by however much the `content-visibility` rows differ from
  their intrinsic size as they materialise (measured: 1,400 → 1,477).
- **In the docked composer, only the rejection card may shrink** — and it can
  only shrink because it is `overflow-y: auto`: a scroll container's automatic
  minimum is 0, which is what lets an `auto` grid track go below its content.
  All four dock rows are therefore explicit; auto-flow cannot be told which of
  five possible children is the flexible one. Without it a «لم أجد بيتك» card
  with three «هل تقصد؟» suggestions took the whole dock and, with the keyboard
  up, the answer field was not on the screen at all.
- **`--app-height` is the phone's real viewport, and `--kb-inset` is what the
  keyboard covers of the LAYOUT one** (`client/hooks/useAppHeight.ts`). The two
  exist because the platforms disagree: Chrome on Android (and therefore the
  Capacitor WebView) resizes the layout viewport, so `innerHeight` shrinks and
  `--kb-inset` stays 0; iOS resizes nothing and only `visualViewport.height`
  moves. A bottom-docked composer needs the first; a `position: fixed` bottom
  edge needs the second. Both fall back (`100dvh`, `0px`) so no stylesheet
  depends on the hook having run.
- **A grid item's automatic minimum is its min-content width.** `minmax(0,1fr)`
  on the TRACK is not enough: `.letter-well` also needs `min-inline-size: 0`,
  or the 28 circular روي wells overflow the 15.5rem browse rail and the
  neighbouring circle silently swallows the click. The grid asks a
  `container-type: inline-size` shell how many columns it can afford — seven
  where there is room, four in the rail. Same family, two more shapes: a
  **flex** item's automatic minimum is min-content too, so `.masthead__nav`
  needs `min-inline-size: 0` or its `overflow-x: auto` never engages and a
  seventh navlink drags the whole DOCUMENT 100px wider than the phone; and an
  element sized in `em` (the drill's ruled blank) feeds that minimum, while the
  same width as a **percentage** does not — which is why `blankWidth()` returns
  one. And a fourth shape, from the phone's full-screen search: a `position:
  fixed` box with `inset: 0` is 390px wide, but its implicit grid COLUMN is
  sized by its items' min-content, and a بيت of Amiri is wide — the column came
  out 453px and, under RTL, pushed the whole screen 63px off the inline-end edge
  («إلغاء» at x = −47, simply not there). `.fsearch` names
  `grid-template-columns: minmax(0, 1fr)` for that reason.
- **A windowed row CLIPS the card inside it.** `.vlist__row` / `.prow-slot` /
  `.pcard-row` are `overflow: hidden` so nothing can break the fixed height —
  which also eats the four pixels a `.pcard` lifts by on hover, and with them
  the gold hairline that sweeps its top edge. The poets grid therefore sets
  `overflow: visible` on its own row (the card is exactly 100% of it, so only
  the lift and its shadow can ever spill). The other half of that geometry:
  a letter heading inside the list is a WHOLE row of `--row-poet`, and the
  FIRST heading is lifted out of the list and rendered above it — 188px of
  heading directly under the toolbar would push the first شاعر below the fold.
- **`block-size: 100%` inside a stretched grid item resolves against the whole
  column.** `.letter-head` carries its row height as an inline style; adding a
  percentage height "for the rows that have one" made the lead heading 6,392px
  tall and the شعراء index looked empty.
- **`.letter-well` is TWO elements, and the stylesheet ORDER decides which one
  wins.** views.css's 28-cell روي grid and duel.css's 4.25rem required-letter
  disc share the class, and `client/main.tsx` loads duel.css last — so the
  disc's un-scoped rules reached every grid cell and each one became a 68px
  gold circle overlapping its neighbours inside the 15.5rem rail, counts
  clipped, clicks landing on the wrong letter. Every rule in that cluster is
  scoped under `.letter-ind` now and `client/styles/styles.test.ts` fails if one
  is not. The general rule: a stylesheet that loads AFTER views.css may not name
  a bare class views.css already owns.
- **`.view__title` is a PROMISE that the app bar repeats the name — and the app
  bar only repeats it once the reader has SCROLLED.** chrome.css puts every
  `.view__title` in `.sr-only` on a phone and hides outright a `.view__head`
  whose only direct child is one (an empty box carrying the view's 24px gap).
  Both are right for a head that is furniture and wrong for a head that IS the
  object: measured at 390 on `#/diwan/<CODE>` with no وصف, the whole head went —
  the shelf's name, its curator, its count, and every button the page has
  (حرّر · احذفه · أضِفه إلى مكتبتك · أبلغ · انسخ الرابط · شارِكه) — leaving an app
  bar reading «ديوان» over a list of أبيات. A named object's heading is its own
  class, never `.view__title`: `.poem-title` on a قصيدة, `.diwan-head__title` on
  a ديوان. The `<h1>` stays an `<h1>` either way; what changes is whether the
  chrome is allowed to take it away.
- **A single-class view modifier in views.css is DEAD.** app.css loads after it
  and sets `.view { gap: var(--sp-5) }`, so `.home`, `.search-view`,
  `.fav-view`, `.rules-view` and `.stats-view` were each declaring a rhythm the
  browser never applied — five views rendering at a gap their CSS did not name.
  They are `.view.home`, `.view.search-view`, … now, and the same trap is why
  `.browse-head` (a `.view__head`) must say `.view__head.browse-head` to be a
  flex row at all. Files that load after app.css — poets.css is NOT one of them,
  duel.css and training.css are — do not need the second class.
- **Every list row is TWO declared `--meta-band` bands, and every chip in a meta
  band is exactly that tall.** A `.prow` lives in a fixed-height slot with
  `overflow: hidden`; left to content, its heading band was 32px under an Amiri
  مطلع and 26px under a UI-face عنوان, and its meta band 21px bare but 34px the
  moment the قصيدة kept its قافية — 32 + 8 + 34 does not fit in 76px, so the
  قافية well was clipped top and bottom and the list visibly staggered. The
  three meta bands in the app (`.prow__meta`, `.bcard__meta`,
  `.bayt-plate__meta`) all take `--meta-band`, chips included.
- **`BaytPlate` already owns j/k/c/f/s on a focused بيت row.** A view that adds
  its own window-level handler for those keys gets them fired TWICE (add, then
  remove). What a view may add is the way *in* — j/k when nothing is focused —
  and page-level keys no row can own, like `t`.
- **The chain letter is a property of the بيت, not of what was typed.** A fuzzy
  match may forgive a misremembered word but never a different opening letter:
  «وقِفا نبكِ» matches «قِفا نبكِ», which starts on ق, so it is refused on a و
  turn. Verify checks the typed text first and the MATCHED بيت second.
- Anything a view renders through `BaytPlate` with a ♥ must write to
  `useCollections` (`qarid:v1:favorites`). Component-local favourite state looks
  identical and persists nothing — that bug shipped once.
- **`qarid:v1:training` has TWO writers.** `duelStore.recordProfile` writes
  `arsenal[letter].used` at every summary — that is how a مساجلة feeds the
  ترسانة — while `trainingStore` owns the cards. So every train view calls
  `reload()` on mount, and every training write merges against what is on disk,
  taking the larger `used` (it only counts up, so the merge is monotone).
  `mastered` is NOT merged: it is derived from the cards by `withMastery()` on
  every write, so a lapse takes محفوظ away again.
- **العدد والمعدود live in `shared/format.ts`, never at the call site.** Five
  functions, and which one you need is decided by what is already on screen:
  `countedNoun` when the phrase is text («4 نتائج», «بيت واحد», «بيتان»);
  `countedUnit` when the DIGITS are already rendered in their own element and
  only the word is missing (a stat tile's caption, `.setup-pool__n`) — it can
  only ever return `few` or `many`, which is exactly why `countedNoun` is wrong
  there; `countedNounGenitive` after a preposition, where المثنى is مجرور
  («سلسلة من بيتين», not «بيتان» — that one shipped, in the share text that
  leaves the app); and `countedNounWithAdjective` when a نعت or حال follows,
  because it has to agree too («10 أبيات محفوظة» / «12 بيتًا محفوظًا», and
  `formatPlayableBaits` — «24 بيتًا صالحًا للمساجلة» — is that function on the
  ديوان's play door); and
  `countedNounAccusative` after a TRANSITIVE VERB, where the معدود is مفعول به
  («لقيتَ شاعرًا واحدًا», not «لقيتَ شاعر واحد» — the summary's «الشعراء الذين
  لقيتهم», i.e. the first and second summary every new player sees). The
  test that catches a regression is `shared/format.test.ts`; the shapes that
  were wrong at v1.1 were 3–10 (جمع القلة) and the dual, i.e. exactly the
  numbers a real session produces.
  **And the rule reaches a CONSTANT and a VERB, not only a variable.** The
  الدواوين census found both. A cap printed into a message — «(300 بيتًا)»,
  «(100 ديوانًا)», «ستين حرفًا» — is a number glued to a hand-written noun that
  happens to agree TODAY and reads «(3 بيتًا)» the day the cap moves, so
  `ALBUM_LIMITS` goes through `formatBaits`/`formatAlbums`/`countedNoun` like
  anything else and `ALBUM_LIMITS.titleChars` is the one place 60 is spelled
  (`AlbumTitleSchema` reads it too). A نعت or a VERB standing next to the
  معدود has to agree with it as well: «{n} ليست في الديوان اليوم» is right at
  3–10 and 11+ and wrong at one and two (`formatMissingBaits` now), and a verb
  placed BEFORE the معدود takes its gender from a thing that moves — «تُضاف
  بيتان» wants يُضاف — so the picker says «يأخذ الديوان الذي تختاره …», where
  the verb agrees with الديوان and the معدود is a مفعول به through
  `countedNounAccusative`. When neither is available, a شبه جملة agrees with
  nothing and is true for every count (`importedMessage`'s «عندك من قبل»).
  **`shared/format.ts` also owns the CALENDAR and the لام.** `MONTHS_AR` /
  `arabicDay` / `arabicDate` are the app's one calendar — Levantine («24 آب
  2026»), because five surfaces write a date and the profile used to keep a
  second, transliterated table, so «انضمّ في 24 أغسطس» sat one tab away from
  «تحدّي 24 آب». And `lamPrefix(name)` elides the لام into ال («للأرجاني», never
  «لـالأرجاني»): a bare tatweel glued to a name is the typing crutch, and most
  of this corpus's شعراء begin with ال.
- **A new page starts at its top; a new PAGE of one is where the reader left
  it — and on a PHONE a tab root is where you left it too.** `pageKey(route)`
  in `client/router.ts` says which is which, and the one effect in `App.tsx`
  scrolls on it. The phone adds exactly one exception, gated on
  `useNativeChrome()` so the web rule is unamended: pressing «التصفح» after
  wandering into a قصيدة is a RETURN, so `scrollTargetFor` (client/chrome.ts)
  hands back the offset that tab was left at. The offset is recorded by a
  passive scroll listener, never read at navigation time — by then React has
  committed the new page and the browser may have clamped the old offset to a
  shorter document — and the restore is retried twice as a windowed list fills,
  abandoning the moment the reader scrolls themselves. A hash router changes no document, so
  without this the window keeps the previous page's offset: leaving a scrolled
  #/poets for #/browse landed the reader inside a list they had not seen, with
  the «المزيد» sentinel already on screen — measured `?p=4` and 300 rows in
  300 ms. `pageKey` therefore drops `?p=`, the browse facets and `?bayt=` (the
  anchor scrolls itself, after the قصيدة loads).
- **The شعراء search ranks by NAME hit, then `fame`, then bm25** — not by bm25
  alone (`rankedPoetRefs` in `server/search.ts`). `poets_fts` is
  `(norm_name, norm_desc)` and bm25 normalises by the whole row's length, so a
  شاعر is penalised for HAVING a ترجمة: «المتنبي» lost to «المشوق الشامي صديق
  المتنبي» (6 قصائد, no bio) and «البحتري» to «يحيى ابن البحتري». The extra
  MATCH is FTS5's own column filter over a 6,941-row index (< 1 ms).

## Spike results

Phase 0, run 2026-08-23 on Node v26.7.0. All three answers are **go** — no
pivot to better-sqlite3 and no Python escape hatch needed.

**(a) `node:sqlite` has FTS5 — yes.** SQLite 3.53.4, compile options include
`ENABLE_FTS5`. Verified end to end and asserted in `server/db.test.ts`:
`CREATE VIRTUAL TABLE … USING fts5(norm, tokenize='unicode61')`, insert with
explicit rowid, `MATCH` on a quoted term, `MATCH` on a quoted *phrase*,
`bm25()` ranking, `snippet(t,0,'»','«','…',8)` (returns `»العزم«` around the
Arabic hit), and `INSERT INTO t(t) VALUES('optimize')`. FTS5 also survives a
read-only reopen, which is how the server will use it. `better-sqlite3` is
**not** a dependency and should stay that way.

**(b) hyparquet streams the shards column-projected — yes.** Each shard is 128
row groups of 1,000 rows. `parquetReadObjects({file, metadata, compressors,
columns: RAW_COLUMNS, rowStart, rowEnd, rowFormat:'object'})` one row group at
a time yields the 11 flat columns and nothing else — `'poem description'` is
absent from the returned objects and its column chunks are never fetched.
`poem verses` comes back as a plain `string[]`. Both shards, 254,630 rows, in
**2.3 s at ~300 MB RSS**. `scripts/ingest/parquet_to_jsonl.py` was therefore
**not written**; the JSONL path in `readRecords` exists for fixtures and the
2,000-row sample only. Pass `file` as an `AsyncBuffer` from
`asyncBufferFromFile`, never a path string (hyparquet fails with an opaque
`DataView` TypeError otherwise).

**(c) corpus profile** — `data/profile.json` + `data/sample-2000.jsonl` (2,000
evenly spaced full records, raw column names, re-readable by `readRecords`).
Headline numbers, all confirming design-server.md §0:

| fact | measured |
|---|---|
| rows | **254,630** (shard 0: 127,315 · shard 1: 127,315) |
| hemistichs | 7,714,858 → ~3,857,429 أبيات · mean 30.3 verses/poem |
| verse counts | zero-verse poems **1** · odd counts **24,378** (→ `is_partial` أبيات) · max **11,608** · 12,324 blank-string hemistichs to drop |
| `poem meter` | **101** distinct non-null + **101,277** null (39.8%); 65 of 101 prefixed `بحر `; exactly one carries a trailing space: `"بحر مجزوء الرمل "` |
| `poem theme` | **18** distinct + 187,110 null; the two biggest are the buckets `قصيدة قصيره` (25,911) and `قصيدة عامه` (20,611) |
| `poet era` | **14** distinct + 107,209 null → 12 after the merges (§4) |
| `poet location` | **22** distinct + 190,602 null; note `سورية` (4,499) and `سوريا` (2,060) are the same country under two spellings |
| `poem language type` | `فصيح` 153,722 · null 71,223 · `فصحى` 20,852 · `عامي` 8,503 · `شعبي` 298 · `-` 32 |
| poets | **7,167** distinct names · 5,357 distinct poet URLs · only **791** carry a description |

Three findings that contradict or extend the design doc — read before writing
`transform.ts`:

1. **The corpus is not just aldiwan.net.** `poem url` spans 8 hosts:
   poetry.dctabudhabi.ae 91,716 · poetsgate.com 70,681 · **aldiwan.net 69,103**
   · adab.com 20,969 · aldiwanalarabi.com 1,875 · diwany.org 245 · 3 stragglers
   · 38 null. So `aldiwan_id` is derivable for only **27%** of poems and
   `public_id` falls back to `q<id>` for the other 73% — plan on that being the
   common case, not the exception.
2. **`poet url` is null for 91,936 rows** (poetsgate + adab entries have no
   poet URL at all), so `poets.slug` cannot come from the URL alone; it needs a
   deterministic fallback slug derived from `name_key`, still UNIQUE.
3. **772 poet names map to more than one `poet url`** (the same شاعر indexed by
   both aldiwan and dctabudhabi), while **no URL is shared by two names**. Since
   `name_key` is the poet identity, slug selection must pick one candidate
   deterministically (prefer the aldiwan.net URL, else lowest-sorting) or the
   `poets.slug` UNIQUE index will fight the `name_key` UNIQUE index.

Not yet spiked: design-server.md §11(c), the `rawiyyOf` agreement check over
200 real عجز — it needs `shared/arabic.ts`, which does not exist yet. Run it
against `data/sample-2000.jsonl` as soon as that file lands.

## The artefact, measured

`npm run ingest` on 2026-08-26, Node v26.7.0 — the dedup-rank rebuild, built to
the side path `data/qarid.build.db` and awaiting the owner's swap into
`data/qarid.db` (a running server holds the old inode; see §Commands):

| fact | measured |
|---|---|
| build | **169 s** (3 passes), peak RSS **711 MB**, deterministic (`build_id d1a38337`) |
| size | **1,593,376,768 B** (1.48 GiB) at `page_size = 8192` |
| rows read | 254,630 → **238,733 poems** (15,891 duplicate قصائد, 6 verse-less) |
| أبيات | **3,369,701** · شعراء **6,941** · `game_baits` **1,713,459** |
| lookups | 12 عصور · 32 meters (16 بحور + التفعيلة/الموشح/النثر/الفولكلور) · 18 أغراض |
| `combo_counts` | 19,639 rows · unmapped meters **0** |
| poet aliases | **56** folded (`shared/poetAliases.ts`), 6,997 → 6,941 شاعر |

Against `build_id bbe2f944` (the 2026-08-24 artefact it replaces): the same
238,733 قصائد and 6,941 شعراء, **442** of them a different copy — −1,709 أبيات
and **+3,566 playable** ones. `public_id` moved for the 73% of قصائد that fall
back to `q<row id>`, as it does on every rebuild.

**Dedup is a pass, not a key.** `dedup_key` is `nameKey|مطلع` — no title, no
length — and `build.ts`'s **pass 0** reads the sources once to decide WHICH copy
of each key survives (`pickDedupWinner` in `transform.ts`, read over the whole
GROUP: compilation suspects last, then most hemistichs, **then a named بحر**,
then tashkeel density, then aldiwan.net). With the title in the key, 6,264
duplicate قصائد survived and landed adjacent on the first screen of التصفح
(«جدارية» / «جدارية..محمود درويش» / «جدارية محمود درويش»); with the title out but
first-wins in charge, 21,110 أبيات went with the truncated copies it happened to
keep. After pass 0, `SELECT poet_id, مطلع GROUP BY … HAVING COUNT(*) > 1` is
**empty**.

**A COMPILATION SUSPECT is a whole ديوان indexed as one poem, and it used to win
on length alone.** dctabudhabi holds all of المتنبي under «على قدر أهل العزم
تأتي العزائم» — 1,810 hemistichs, no metre, no title — so the artefact kept it
as a 905-بيت «بلا عنوان», and `game_baits`' `m.kind='bahr'` gate then made every
بيت in it unservable: the most famous ع-بيت in the language was invisible to the
duel opponent, to وضع التدريب's assist rail and to the pool counts, while the
copy being dropped was the real 46-بيت طويل قصيدة from aldiwan.net. A candidate
with **no `kind:'bahr'` metre**, in a group that HAS one, **> 5×** that copy's
length, **> 240** hemistichs AND holding **< 0.9** of one روي now ranks below
every other copy. All three thresholds are load-bearing and the corpus set them
(`node scripts/ingest/dedupAudit.ts data/raw/*.parquet` replays pass 0 old vs new
and prints every flip that shrinks a قصيدة, ~35 s): ratio alone would truncate
ابن الفارض's التائية الكبرى (3.9×) and سعيد بن خلفان's 221-بيت سلوك (17.0×, one
روي throughout), and the absolute floor is what spares علي محمود طه's «ميلاد
شاعر», a real poem in sections. At 5× / 240 / 0.9 the rule fires on **three**
groups in the whole corpus and every one is a blob. Measured old vs new over all
254,630 raw rows: **442** flips, **218** of them GAINING a named بحر (3,591
أبيات made playable), none losing one, and the entire −3,420-hemistich delta is
those three blobs. The بحر also moved ABOVE tashkeel in the tie-break, because
one decides whether a بيت can be played at all and the other only how it is
set.

Tier pools (`game_baits`, the «العدد المتاح» the setup screen shows):
مبتدئ 95,387 · شاعر 743,939 · فحل 1,169,286 · سيف 1,713,459. Both middle tiers
carry a **position cap** (`TIER_PREDICATES` in `scripts/ingest/ddl.ts`, mirrored
in `TIERS` in `server/game.ts`): مبتدئ `fame = 3 AND position <= 2`, شاعر
`fame >= 2 AND position <= 12`. Fame is a property of the شاعر
(`shared/famousPoets.ts`), never of the line, so without a cap the tier that
promises «أبيات مشهورة» recites بيت ٣٠٠ of a 500-بيت ديوان. ≤ 2 is the closest
thing the artefact has to a per-line popularity signal; it still leaves ≥ 208
أبيات on the thinnest letter (ظ), and `pickBait` relaxes one tier when a
combination is dry.

### Latency on the real corpus (p50, warm, over HTTP)

`/api/anthologies` 0.03 warm (167 ms cold, pre-warmed at boot) · `/api/buhur`
0.02 warm (97 ms cold, 25 ms worst بحر, pre-warmed at boot) · `/api/meta` 0.7 · `/api/stats` 3.0 · `/api/search` 1.3–20 · `/api/poems`
filtered 5.1 · `/api/poets` 6.9 · `/api/baits` بيت-mode 22–38 · `/api/baits`
unfiltered any page 13–18 · `/api/baits/daily` 2.8 · `/api/train/candidates` 15
· `/api/game/start` 1.3 · `/api/game/reply` 1.4–6 (all 28 letters × 4 tiers
< 20 ms) · `/api/game/verify` 2.0 exact / 11.0 not-found. Budget is 150 ms.

**`/api/facets` is 0.7 ms warm and up to 230 ms COLD.** The unfiltered payload
comes from `meta.facets_json`; every filtered combination is six GROUP BYs over
238K قصائد — `?first=ا` 102 ms, `?rhyme=ر&first=ا` 149 ms, `?lang=فصيح` 232 ms —
and is then memoised for the life of the process (the artefact is immutable, so
the answer is a pure function of the query). The rail's own letters are the
expensive ones; ظ/ذ/غ are single digits cold.

**The 62 single-facet combinations are PRE-WARMED at boot** — `warmFacets(db)`
in `server/routes/facets.ts`, fired and dropped by `server/index.ts` after
`serve()`. One عصر, one بحر or one غرض is what a `#/browse` reader reaches in
one click, and warming all 62 costs 646 ms with a 69 ms worst loop stall
(they ride `poems_filter`, so they are far cheaper than the `?first=`/`?lang=`
shapes above, which are deliberately NOT warmed). Measured on a fresh boot:
`?era=abbasi` and `?meter=tawil` answer in **0.9 ms on their first request**,
while an unwarmed `?first=ا` still costs 94 ms. Two rules keep it harmless — it
runs only `if (db)` (a corpus-less box must still boot; `server/routes/
facets.test.ts` spawns a real `PORT=0` server to prove it), and it awaits a
`setImmediate` before every combination, so the socket is accepting from the
first millisecond and no single turn is longer than one un-warmed request. The
memo and the unfiltered payload live in WeakMaps keyed on the DB HANDLE, not in
the route closure — that is what lets a caller with no `Hono` fill them.

Five indexes past design-server.md §5 bought the rest, each documented where it
is declared (`scripts/ingest/ddl.ts`): `gb_chain` (the روي side of بيت-mode
browse: 107 → 22 ms), `gb_poem` (شاعر-filtered `/api/game/reply`: p90 32 → 4 ms),
`gb_bias` (amendment 5's tail bias: و on سيف 149 → < 20 ms), `gb_fame`
(unfiltered `/api/baits`, which sorted 1.7M rows into a temp b-tree: page 10,000
836 → 18 ms), `gb_train` (`/api/train/candidates`: 153 → 15 ms, together with
sorting a narrow subquery instead of the joined rows).

**Every SQLite call is synchronous on the one event loop.** `node:sqlite`'s
`StatementSync` blocks, and `server/index.ts` is one process with no worker, so
latency is additive across concurrent clients: eight concurrent deep
`/api/baits` pages used to make `/healthz` take 6.6 s (now 114 ms, re-measured
2026-08-24), one used to make it take 833 ms (now 0.2 ms). The fixes are
containment, not a cure — see the architecture note in §Backlog for why the
worker thread stays unbuilt and what would change that.

### Serving rules the wire enforces

- **`/api/*` carries `Cache-Control`** (`cachePolicy` in `server/app.ts`):
  meta/stats/facets an hour + `stale-while-revalidate`, other reads a minute,
  `/api/baits/random` and the duel `no-store`. Set it in the OUTERMOST
  middleware or not at all — see the invariant below.
- **A missing `/assets/<hash>` is a 404**, never the SPA shell: `notFound`
  returning index.html at 200 under a hashed JS URL is a blank page for any tab
  still holding a pre-deploy index.html, cached `immutable` for a year.
- **`compress()` is mounted on `*`**, not just `/api/*` — the bundle is the
  biggest thing this server sends (index.js 496 KB → 149 KB).
- **`/api/game/*` bodies are capped at 64 KB** (`MAX_GAME_BODY`), counted off
  the stream and not just the `Content-Length` header. Six concurrent 67 MB
  bodies used to add 577 MB of RSS before the schema could reject them.
- **A starred term's floor is measured on the token the star EXPANDS, and at
  most `STAR_TERM_CAP` (2) stars are honoured per query.** FTS5 applies `*` to
  the last token only, so counting `PREFIX_MIN_LENGTH` over a whole phrase let
  `"يا ا"*` scan the one-letter prefix «ا»: **19,799 ms** on one anonymous
  `GET /api/search`, now 3 ms. And the floor bounds ONE star, not how many — a
  71-character query of twelve legal four-letter starred words cost 594 ms, now
  126 ms. `/api/search` also carries `SEARCH_RATE_LIMIT` (60/10 s/IP), the only
  bucket on a read route, because v2 is what gave it the prefix operator.
- **The rate limiter keys on `CF-Connecting-IP`, then `X-Real-IP`, then the
  RIGHT-most `X-Forwarded-For` hop.** Cloudflare APPENDS the true client to a
  client-supplied XFF, so the left-most entry is attacker text: keyed on it,
  60 requests got 59 tokens instead of 12. Its sweep must REFILL before it
  judges: `tokens` is written lazily, so an idle bucket carries the count from
  its last request (≤ capacity − 1) and `tokens >= capacity` was unsatisfiable —
  200,000 one-shot IPs retained 200,000 buckets and 208 MB while a full O(n)
  scan ran on every new key. It sweeps at most once per window now.

### Corpus quirks to know before you "fix" them

- **The شاعر alias merge is curated, and deliberately small.**
  `shared/poetAliases.ts` folds 56 alias `name_key`s onto their canonical row at
  ingest — «أبو الطيب المتنبي» → «المتنبي» (482 → **364** قصيدة: the two rows
  shared 118 copies of the same قصيدة), «بشارة الخوري» → «الأخطل الصغير»,
  «مصطفى وهبي التل» and «مصطفى التل عرار» → «مصطفى التل». Candidates are
  DETECTED by token-superset + compatible عصر (149 pairs) and then read by hand,
  because two thirds of that query is traps: a son is a superset of his father
  («يحيى ابن البحتري», «رؤبة بن العجاج», «خليل ناصيف اليازجي»), so is a
  transmitter («الناجم راوية ابن الرومي») or a friend («المشوق الشامي صديق
  المتنبي»), and a shared نسبة carries four unrelated «التهامي». «متنبي المغرب»
  is a superset of «المتنبي» and a different شاعر. A wrong merge welds two
  دواوين together with nothing downstream able to tell them apart, so a doubtful
  pair stays out. The hop happens in `transformPoem`, on `name_key` AND on
  `dedup_key`, before `poems.poet_id` exists: fame is the MAX of the pair
  (`PoetAcc.sourceKeys`), description the longest, and the slug the canonical's
  (`aliasUrlSlugs` is a fallback set, never the winner) — «المتنبي» stays
  `mutanabi`. A شاعر the corpus spells ONLY the alias way takes his display
  name, letter and sort key from `CANONICAL_POET_NAMES`.
- Some مطالع carry the scraper's own damage («لَمء» for «لَمْ»); some قصائد are
  labelled `عمودية`, which is a form, not a بحر, and shows as a chip. Both are
  the source's, not the pipeline's. One shape of that damage IS gated: بيت اليوم
  refuses a hemistich that begins with an orphaned letter («… معاهده الغر» /
  «ر ويروى …», a word cut at a line break), because it is the one بيت every
  visitor sees — `textIsClean` in `server/routes/baits.ts`.
- **The same صدر can carry a different روي under a different شاعر** — 21,739
  groups, 69,139 أبيات. A صدر-only answer is therefore resolved by
  `po.fame DESC, b.position ASC, b.id ASC` (never rowid), re-ranked on the عجز
  when the player supplied one, and routed to `ambiguous` when the copies fame
  cannot separate would chain on different letters (`exactCopies`/`chainClash`
  in `server/game.ts`). «قفا نبك من ذكرى حبيب ومنزل» used to resolve to أبو
  العباس الجراوي and demand ب.
- 39.8% of قصائد have no بحر at all — every بحر facet count is a count of the
  60% that do.
## Deploy

The server binds loopback only (127.0.0.1 **and** ::1) and serves the built
client itself, so a deployment is: build, run, and put something in front of it
for TLS — a reverse proxy or a tunnel, your choice. `deploy/qarid.service` is a
systemd **user** unit for exactly that; adjust `WorkingDirectory` and symlink it
into `~/.config/systemd/user/`.

Configuration is `.env` in the checkout (see `.env.example`): `HOST`, `PORT`,
`PUBLIC_ORIGIN`, `DB_PATH`, `USERS_DB_PATH`. `PUBLIC_ORIGIN` is the one that
matters beyond the box — it is what the share links and the Digital Asset Links
statement are built on, and it has no useful default.

Two rules a deploy has to respect, both learned the hard way:

- **After changing client code: build, THEN restart.** The server reads
  `dist/index.html` once at boot, so a restart-less deploy serves the previous
  bundle's asset hashes and every hashed asset 404s.
- **After a re-ingest: build to a side path and `mv`.** A running server holds
  the old artefact's inode open, so replacing it underneath is not enough —
  `node scripts/ingest/index.ts build data/raw/*.parquet data/qarid.build.db &&
  mv -f data/qarid.build.db data/qarid.db`, then restart.

Done bar, all four green before any commit that ships:

```
npm run typecheck && npm test && npm run build && npm run smoke
```

plus, after deploy, `curl http://127.0.0.1:$PORT/healthz` **and**
`curl "http://[::1]:$PORT/healthz"` (both `ok`) and
`curl http://127.0.0.1:$PORT/api/meta` (counts, not `meta_unavailable`).
## Backlog

Known and deliberate, in rough order of what a next pass should take:

- ~~**The v1.1 verification pass.**~~ **DONE** — a whole-app human walk at 1440
  and at 390 (`hasTouch`) over the built bundle and the real artefact found five
  things and all five are fixed: (1) العدد والمعدود was hard-coded at fourteen
  call sites, so a real session read «4 نتيجة», «10 بطاقة في ترسانتك», «أصبتَ 5
  من 5 كلمة», «مجموعة «س» — 1 بيتًا» and, in the text that LEAVES the app,
  «سلسلة من بيتان» — now `shared/format.ts`'s four counted-noun functions
  everywhere (see §Invariants); (2) the شعراء search ranked an obscure namesake
  above the شاعر you typed; (3) a hash change never reset the scroll, so leaving
  a scrolled page landed the reader inside the next one and #/browse autoloaded
  to `?p=4` unread; (4) the شاعر page's own signature بيت was the one بيت with
  no ♥ / نسخ / بطاقة / ساجِلني rail; (5) `.gitignore` ignored only
  `screenshots/*.png`, so a smoke run's subfolders were waiting for the next
  `git add -A`. Everything else on the walk — duel at مبتدئ and فحل (hints,
  wrong-letter precheck, near-miss, already-used, timeout, `incomplete_bait` as
  a soft rejection, abandon, the PoetCard grid, share card and text, مرة أخرى,
  and a hard refresh mid-duel that resumes without spending a life), تحفيظ
  (typed answers, the word diff, the heatmap, «تدرّب» on a weak letter), التصفح,
  البحث, التجوال, المختارات + المجموعات, بيت اليوم, الإحصاءات, the keymap and
  every empty/404 state — behaved, with no console error, no failed request and
  no horizontal overflow at 390 anywhere.
- ~~**Poet alias merge.**~~ **DONE** (`build_id bbe2f944`) — `shared/poetAliases.ts`,
  **56** curated alias → canonical `name_key` pairs applied in `transformPoem`
  before poet insertion, so poems, أبيات, `game_baits`, `combo_counts` and fame
  all land on the canonical row. 6,997 → 6,941 شعراء. See §Corpus quirks for the
  detection query and the traps it returns. Residue, on purpose: the map is
  curated, so pairs the detector suggested but a human could not confirm
  («تميم بن أبي» / «تميم بن أبي بن مقبل», «محمد بن عبد الله المعولي», the four
  «الكوكباني») are still two rows, and a pair whose names share no token at all
  («أ.د/ مصطفى الشليح» / «مصطفى بن عبد الرحمن الشليح») the detector never sees.
- ~~**Poet honorifics break the شعراء index.**~~ **DONE** — `stripHonorifics()`
  in `shared/arabic.ts` runs inside `sortName()`, so `poets.letter` and
  `poets.sort_key` are derived from the same strip and the rebuild synced them:
  «أ.د/ مصطفى الشليح» files under الميم, «أ.عبدالله بن يحي علي البت» under
  العين, 55 شاعر moved in all. The card still shows the source's spelling. Two
  guards, both load-bearing: a WORD honorific (الدكتور/الشيخ/القاضي/السيد/…) is
  stripped only when **two or more** name tokens survive it, so «القاضي
  الفاضل» (685 قصيدة), «القاضي عياض» and «السيد الحميري» keep the title that IS
  their شهرة; and nothing is ever stripped to a string with no Arabic letter.
- **ARCHITECTURE NOTE, not a task: the SQLite worker thread stays unbuilt.**
  `node:sqlite` is synchronous, so every query blocks the one event loop and
  latency is additive across concurrent clients. The structural answer is a
  worker thread holding the handle with `server/dto.ts`'s callers turned async
  — which means async-ing every route, every helper and every test that drives
  `app.request()`, plus a message hop on the hot path that a 0.4 ms `/api/meta`
  would feel. **Assessed 2026-08-24 and deliberately deferred.** What the wire
  actually says: every route is ≤ 23 ms warm on the real corpus, the cold cliff
  that remains (`?first=`/`?lang=` facets, 94–232 ms) is memoised on first
  touch, the rail's own 62 combinations are pre-warmed at boot, and the
  pathological case — eight concurrent deep `/api/baits` pages — costs
  `/healthz` 114 ms. This is a single-reader site behind one Cloudflare tunnel;
  a queue that never has two things in it does not need a second thread. The
  containment is real work already done (five indexes, narrow-subquery sorts,
  the facet memo + pre-warm), and it is what keeps this true.
  **Re-measured 2026-08-25 for the public Play launch** (`tools/loadtest.mjs`,
  full sweep in `docs/load-test.md`): the multi-reader ceiling is graceful, not a
  cliff — throughput is flat at ~150–200 rps (the one-loop ceiling), `/healthz`
  holds its 150 ms budget through ~10–15 concurrent corpus readers and first
  breaches around 20–25, and a 200-way flood gives zero errors, no crash and RSS
  that rises ~85 MB then goes FLAT. No death spiral, so no valve was shipped: a
  bounded in-flight gate was built and measured INERT here (a synchronous query
  serializes requests below userland, so the in-flight counter peaked at exactly
  1 under an 80-way burst), and an event-loop-lag valve over-shed legitimate load
  (97 % at concurrency 10) without pulling `/healthz` back under budget. A valve
  that can't fire or that harms the normal case is over-engineering; the
  containment above is the right launch-scale posture.
  **Build it when any ONE of these becomes true**, and not before:
  (a) the site's LIVE traffic regularly sustains ~20+ simultaneous readers on the
  expensive query paths — re-run `tools/loadtest.mjs` on the real corpus to
  confirm the budget is actually breached at the concurrency the site sees, not
  merely that traffic became public (the launch itself does not fire this: at its
  realistic niche concurrency the budget holds);
  (b) any route measures **> 200 ms p95** on the real corpus, or `/healthz`
  under real sustained load leaves the 150 ms budget;
  (c) a NEW route lands that can run long by construction — an unmemoisable
  scan, a user-supplied `LIKE '%…%'`, a per-request aggregate over `game_baits`.
  Until then the rule to hold is the narrow one: any new route that can run
  long is a route that can stall every other visitor, so it needs an index, a
  narrow-subquery sort, or a memo BEFORE it ships.
- ~~**Filtered `/api/facets` is 100–230 ms on its first call per combination.**~~
  **DONE** — `warmFacets(db)` pre-warms the 62 single-facet combinations at
  boot (646 ms, 69 ms worst stall, skipped without a corpus); see §Latency.
  The `?first=`/`?lang=` shapes are still cold-then-memoised on purpose.
- ~~**`usedPoemIds` is a no-op for 27% of قصائد.**~~ **DONE** — `PoemRef` now
  carries BOTH ids (`id` public, `poemId` = `poems.id`), `BAIT_CONTEXT_COLS`
  selects `p.id`, and `withUsed` reads the internal one instead of parsing the
  public one. `internalPoemId()` is gone. An aldiwan-keyed قصيدة now excludes
  itself from the opponent's replies like any other.
- ~~**`incomplete_bait` still costs a life.**~~ **DONE** — it is a SOFT
  rejection: out of `COSTS_LIFE`, `softReject` in the machine, and four seconds
  on screen (`SOFT_REJECT_SLOW`) because the card shows the mutilated ديوان
  entry. The بيت is real and the player remembered it; the corpus is short a
  شطر, and charging for the scrape's damage was the bug.
- ~~**Two additive server fields the client does not read.**~~ **DONE** — an
  opponent's exchange persists `relaxed` (`ExchangeSchema`, default false) and
  the card says «خرج عن القيود» once the شاعر is revealed; `poolIsThin()` in
  DuelSetupView warns off `effectiveTotal ?? total`.
- ~~**«الشعراء الذين لقيتهم» is chips, not the PoetCard grid.**~~ **DONE** —
  `GET /api/poets?slugs=a,b,c` (≤ `MAX_POET_SLUGS` = 30, in the order asked,
  unknown slugs simply absent, the index's own filters ignored) answers the
  summary's one batch request, and it renders the real `PoetCard` with the gold
  نِيب on the cell. A failed request falls back to the name-only chip, so an
  offline summary still names every شاعر.
- ~~**A duel summary that survived a reload degrades its headline.**~~ **DONE**
  — `outcome`/`endedAt` are persisted at **`PERSIST_VERSION` 2** with
  `MIGRATIONS[1]` for the v1 payloads already on disk. That step recovers only
  what a v1 ending honestly carries (no lives → «انقضت الأرواح»; ten أبيات in
  المبارزة → «انتهت المبارزة»; `endedAt` from the last بيت) and leaves
  «انسحبتَ»/«أفحمتَ الخصم» null rather than guessing between them.
- ~~**`dist` ships 445 KB of `.woff`.**~~ **DONE** — `dropWoffFallbacks()` in
  `vite.config.ts` strips the `, url(…woff) format('woff')` half of every
  fontsource `src` in a `enforce: "pre"` **transform**, so the file is never
  referenced and never emitted. It is not a `generateBundle` filter on purpose:
  by then the stylesheet's content hash is fixed, and the rewritten CSS would
  ship under its old hash, `immutable` for a year. `dist` is 1.5 MB → 1.1 MB.
- ~~**`tools/screenshot.mjs --mobile` sets only a 390 viewport.**~~ **DONE** —
  the mobile context is `{viewport, hasTouch: true, isMobile: true}`, so
  `@media (hover:none),(pointer:coarse)` matches and the mobile shots lost the
  `/` badge and the «Shift+Enter» hint (`.keys-only`, base.css) a phone cannot
  use.
- ~~**Cosmetic**: omnibox placeholder truncation, `.train-arsenal-card__body`
  slack.~~ **DONE** — `OMNIBOX_PLACEHOLDER_NARROW` swaps in under `useNarrow()`
  (a placeholder is the one string CSS cannot shorten: it clips mid-word, and
  a `<textarea>` cannot even ellipsise it — which is why the duel's docked
  answer field has `ANSWER_PLACEHOLDER_NARROW` too), and
  the ترسانة card is now `26rem | 1fr | 18rem` with the coverage ring pinned
  `justify-self: start` beside the map it describes, so the slack sits in one
  middle gap instead of at the far end. `__side` is `display: contents` at wide
  widths and a real box again below 861px.
- **الدواوين have no FEED, and that is a decision.** A wall of strangers'
  دواوين is a moderation queue, and Track 3 already has one. Two of the three
  doors that do not open it are now built and are the shape any further one
  should take: an account's PUBLIC دواوين on its own `#/u/<name>` page (its owner
  PUBLISHED them, and the page already carries his name), and «من مكتبتك» on
  `#/diwans` — shelves a reader kept, held as an edge so the curator can still
  close them (see the invariant). What is still open and still cheap: «انسخ
  الأبيات» on a shelf, which is `formatBayt` over what is already on the screen.
  What it should NOT add is a feed — and the moderation surface a feed would
  need is the reason: a reported ديوان today reaches the owner's existing queue
  with two narrow actions on it (unlist, clear the وصف), which is a queue sized
  for links passed between readers, not for a public wall.
- **The المختارات المنظومة canon is a HAND-CURATED table and it should grow.**
  Ten معلقات and a hundred أبيات سائرة, every one verified against
  `build_id d1a38337` before it shipped. What is deliberately not there, and why:
  «ولقد ذكرتك والرماح نواهل» (the corpus files عنترة's own بيت under هدى السعدي
  alone), «إذا بلغ الفطام لنا صبي» (عمرو بن كلثوم's, filed under عنترة), «إن
  الشباب والفراغ والجدة» and «ولولا المشقة ساد الناس كلهم» (no copy the anchor
  can reach). A new shelf is a new entry in `ANTHOLOGIES` and nothing else —
  the route, the strip, the index and the shelf page are all driven by the
  table. Verify a new entry the way the existing ones were: the corpus half of
  `server/routes/anthology.test.ts` resolves the whole canon against
  `data/qarid.db` and fails on the entry, naming it.
- **«الأحدث» browse sort does not exist and cannot** — the corpus carries no
  date on a قصيدة. Struck from design-ux.md §3 (amendment 20).
- The drill's «هذا في ترسانتي» can double-count a بيت also answered with in a
  duel. Deliberate: `used` is a claim count, not a distinct-أبيات count, and it
  is monotone.
