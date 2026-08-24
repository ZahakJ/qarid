# قريض (Qarid)

Arabic classical poetry corpus browser **and** مساجلة duel at
**qarid.avicenna.space** — قَرِيض, the old word for verse itself. **238,733
poems / 3,371,410 أبيات / 6,941 شعراء** in the built artefact (254,630 rows
read; 15,891 duplicate قصائد and 6 verse-less poems dropped) from `arbml/ashaar`,
of which **1,709,893 أبيات are game-playable**. Ingested into one read-only
SQLite artefact, browsed by era/بحر/غرض/روي, searched with FTS5, and played:
the machine recites a بيت, you must answer with one that starts on its روي.
Single npm package (mimema/leyline shape): Vite 7 + React 19 client, Hono 4
server run directly by Node 26 (TS type-stripping, **no server build**),
`node:sqlite` over a gitignored `data/qarid.db`.

Ports: dev API **5750**, dev Vite **5751**, smoke/preview **6750**, prod
**8010** (Cloudflare tunnel `cf-qarid` ingress points at 8010, managed in the
CF dashboard — keep 8010 or you must edit the dashboard). Never other ports.
Accent: illumination gold `--accent-rgb: 214, 173, 96` (#d6ad60) on blue-black
ink, with a single second ink, lapis `--lapis-rgb: 92, 124, 200`, reserved for
exactly three things (opponent's بيت card, روي underline, search »« markers).
Verse font **Amiri**, display **Aref Ruqaa**, UI **IBM Plex Sans Arabic**,
numerals/timers **IBM Plex Mono**. All UI strings Arabic; code English.
**Numerals are WESTERN 0-9 everywhere** — owner's decision, 2026-08-24
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
- `npm run ingest` — build `data/qarid.db` from `data/raw/*.parquet`. **Measured: 155 s (3 passes), peak RSS 836 MB, 1.48 GiB out** (§5 estimated 15–30 min; hyparquet made it two and a half minutes). Stop any server on the artefact first — it is replaced, not updated. If one is running anyway (another agent, the prod unit), build to a side path and `mv`: `node scripts/ingest/index.ts build data/raw/*.parquet data/qarid.build.db && mv -f data/qarid.build.db data/qarid.db`, then restart the server — a live process keeps the old, deleted inode open.
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
  that sets `fame`, and the 56 alias → canonical `name_key` merges).
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
  #/wander doors), `/baits/daily`, `/baits/:id` (prev/next) · **facets**
  `/facets` · **train** `/train/candidates` · **auth** `/auth/register`,
  `/auth/login`, `/auth/logout`, `/auth/me` (the only routes that take a cookie;
  `/auth/me` is ALWAYS 200, `user: null` means nobody) · **profile**
  `/profile/:username`, `/profile/update`, `/profile/arsenal` · plus the
  `search` and `game` sub-apps other agents own.
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
- **Stylesheets, in cascade order** (`client/main.tsx`): tokens · base ·
  components · bayt · views · **poets** · app · duel · training · palette ·
  **motion**. `poets.css` owns #/poets and #/poet whole — `.poets-*`,
  `.pcard*`, `.letter-rail*`, `.letter-head*`, `.medallion*`, `.era-*`,
  `.poet-*` — and the `--row-poet` half of the row-height contract.
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
- Client route map — `#/` home · `#/poets` · `#/poet/<slug>` ·
  `#/poem/<publicId>?bayt=N` · `#/browse?era&meter&theme&rawiyy&letter&sort&p` ·
  `#/search?q&p` · `#/duel` `#/duel/play` `#/duel/summary` · `#/daily` ·
  `#/favorites?collection` · `#/rules` · `#/stats` · `#/wander` ·
  `#/train` `#/train/drill?letter=<L>` `#/train/arsenal` · `#/u/<username>`.
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
  accounts, sessions, the opt-in ترسانة snapshot and v2 §5's `rooms` /
  `match_turns`, all created by `server/users.ts`'s `PRAGMA user_version`
  migrations (WAL, `foreign_keys = ON`). It fails the same tolerant way the
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
- **`.gitignore` anchors `/data/`.** Unanchored, it also swallows
  `client/data/` — buhur tables, flavour أبيات, the keymap — and four source
  files sat outside the repo for three commits. Anchor every ignore rule that
  names a common directory — and ignore the DIRECTORY, not a glob inside it:
  `screenshots/*.png` matched only the top level, so every `--out
  screenshots/<name>` a smoke run wrote was staged by the next `git add -A`.
  It is `/screenshots/` now.
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
  one.
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
- **العدد والمعدود live in `shared/format.ts`, never at the call site.** Four
  functions, and which one you need is decided by what is already on screen:
  `countedNoun` when the phrase is text («4 نتائج», «بيت واحد», «بيتان»);
  `countedUnit` when the DIGITS are already rendered in their own element and
  only the word is missing (a stat tile's caption, `.setup-pool__n`) — it can
  only ever return `few` or `many`, which is exactly why `countedNoun` is wrong
  there; `countedNounGenitive` after a preposition, where المثنى is مجرور
  («سلسلة من بيتين», not «بيتان» — that one shipped, in the share text that
  leaves the app); and `countedNounWithAdjective` when a نعت or حال follows,
  because it has to agree too («10 أبيات محفوظة» / «12 بيتًا محفوظًا»). The
  test that catches a regression is `shared/format.test.ts`; the shapes that
  were wrong at v1.1 were 3–10 (جمع القلة) and the dual, i.e. exactly the
  numbers a real session produces.
- **A new page starts at its top; a new PAGE of one is where the reader left
  it.** `pageKey(route)` in `client/router.ts` says which is which, and the one
  effect in `App.tsx` scrolls on it. A hash router changes no document, so
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

`data/qarid.db` as built by `npm run ingest` on 2026-08-24, Node v26.7.0:

| fact | measured |
|---|---|
| build | **155 s** (3 passes), peak RSS **836 MB**, deterministic (`build_id bbe2f944`) |
| size | **1,593,352,192 B** (1.48 GiB) at `page_size = 8192` |
| rows read | 254,630 → **238,733 poems** (15,891 duplicate قصائد, 6 verse-less) |
| أبيات | **3,371,410** · شعراء **6,941** · `game_baits` **1,709,893** |
| lookups | 12 عصور · 32 meters (16 بحور + التفعيلة/الموشح/النثر/الفولكلور) · 18 أغراض |
| `combo_counts` | 19,609 rows · unmapped meters **0** |
| poet aliases | **56** folded (`shared/poetAliases.ts`), 6,997 → 6,941 شاعر |

**Dedup is a pass, not a key.** `dedup_key` is `nameKey|مطلع` — no title, no
length — and `build.ts`'s **pass 0** reads the sources once to decide WHICH copy
of each key survives (`dedupRank`: most hemistichs, then tashkeel, then a named
بحر, then aldiwan.net). With the title in the key, 6,264 duplicate قصائد
survived and landed adjacent on the first screen of التصفح («جدارية» /
«جدارية..محمود درويش» / «جدارية محمود درويش»); with the title out but first-wins
in charge, 21,110 أبيات went with the truncated copies it happened to keep.
After pass 0, `SELECT poet_id, مطلع GROUP BY … HAVING COUNT(*) > 1` is **empty**.

Tier pools (`game_baits`, the «العدد المتاح» the setup screen shows):
مبتدئ 95,065 · شاعر 741,893 · فحل 1,168,620 · سيف 1,709,893. Both middle tiers
carry a **position cap** (`TIER_PREDICATES` in `scripts/ingest/ddl.ts`, mirrored
in `TIERS` in `server/game.ts`): مبتدئ `fame = 3 AND position <= 2`, شاعر
`fame >= 2 AND position <= 12`. Fame is a property of the شاعر
(`shared/famousPoets.ts`), never of the line, so without a cap the tier that
promises «أبيات مشهورة» recites بيت ٣٠٠ of a 500-بيت ديوان. ≤ 2 is the closest
thing the artefact has to a per-line popularity signal; it still leaves ≥ 208
أبيات on the thinnest letter (ظ), and `pickBait` relaxes one tier when a
combination is dry.

### Latency on the real corpus (p50, warm, over HTTP)

`/api/meta` 0.7 · `/api/stats` 3.0 · `/api/search` 1.3–20 · `/api/poems`
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
- **The rate limiter keys on `CF-Connecting-IP`, then `X-Real-IP`, then the
  RIGHT-most `X-Forwarded-For` hop.** Cloudflare APPENDS the true client to a
  client-supplied XFF, so the left-most entry is attacker text: keyed on it,
  60 requests got 59 tokens instead of 12.

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

**Live since 2026-08-24.** systemd user unit `deploy/qarid.service` (mirrors
`mimema/deploy/meme.service`: `PartOf=avicenna-suite.target`,
`WorkingDirectory=%h/Documents/side/qarid`,
`ExecStart=/usr/bin/node --env-file-if-exists=.env server/index.ts`,
`Restart=always`, `RestartSec=5`, `NODE_ENV=production`, `WantedBy=default.target`),
symlinked into `~/.config/systemd/user/qarid.service` **and**
`~/.config/systemd/user/avicenna-suite.target.wants/qarid.service` (enabling it
also linked `default.target.wants/`). `.env` is gitignored and carries
`HOST=127.0.0.1`, `PORT=8010`, `PUBLIC_ORIGIN=https://qarid.avicenna.space`,
`DB_PATH=/home/avicenna/Documents/side/qarid/data/qarid.db`.

Cloudflared block `cf-qarid` (network_mode host, token `${TOKEN_QARID}`) is in
`~/containers/tunnels/docker-compose.yml` and `docker compose config` accepts
it. **`TOKEN_QARID` is still a commented placeholder in that directory's
`.env`** — the tunnel and its public hostname (`qarid.avicenna.space` →
`http://localhost:8010`) are created by hand in the CF Zero Trust dashboard,
then the token is pasted in and `docker compose up -d cf-qarid` starts it. Until
that happens the site answers on localhost only, and a blanket
`docker compose up -d` in that directory would start `cf-qarid` with an empty
token and crash-loop it — bring it up by name.

Operating it:

- After changing client code: `npm run build && systemctl --user restart
  qarid.service`. The server reads `dist/index.html` ONCE at boot; skip the
  restart and every hashed asset 404s.
- After a re-ingest: build to a side path and `mv` (a running server holds the
  old inode), then restart the unit. See the ingest note in §Commands.
- `journalctl --user -u qarid.service -f` — a healthy boot is exactly two
  lines, `listening on http://127.0.0.1:8010` and `listening on http://[::1]:8010`.

Done bar, all four green before any commit that ships:

```
npm run typecheck && npm test && npm run build && npm run smoke
```

plus, after deploy, `curl http://127.0.0.1:8010/healthz` **and**
`curl 'http://[::1]:8010/healthz'` (both `ok`) and `curl
http://127.0.0.1:8010/api/meta` (counts, not `meta_unavailable`). Verified at
v1.1: 916 tests / 41 files, 17 smoke routes desktop AND `--mobile`, both healthz, `/api/meta` at
238,733 · 3,371,410 · 6,941 · 1,709,893 (`build_id bbe2f944`), `/` serving the built index.html with
the current asset hash, `/assets/<stale-hash>` a 404, `Cache-Control` intact
under `Accept-Encoding: gzip` (the compress invariant, checked on the wire).

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
  **Build it when any ONE of these becomes true**, and not before:
  (a) the site stops being single-reader — public traffic, a shared link that
  actually lands, or anything that puts two concurrent readers on it regularly;
  (b) any route measures **> 200 ms p95** on the real corpus, or `/healthz`
  under load leaves the 150 ms budget;
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
  (a placeholder is the one string CSS cannot shorten: it clips mid-word), and
  the ترسانة card is now `26rem | 1fr | 18rem` with the coverage ring pinned
  `justify-self: start` beside the map it describes, so the slack sits in one
  middle gap instead of at the far end. `__side` is `display: contents` at wide
  widths and a real box again below 861px.
- **«الأحدث» browse sort does not exist and cannot** — the corpus carries no
  date on a قصيدة. Struck from design-ux.md §3 (amendment 20).
- The drill's «هذا في ترسانتي» can double-count a بيت also answered with in a
  duel. Deliberate: `used` is a claim count, not a distinct-أبيات count, and it
  is monotone.
