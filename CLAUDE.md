# قريض (Qarid)

Arabic classical poetry corpus browser **and** مساجلة duel at
**qarid.avicenna.space** — قَرِيض, the old word for verse itself. **239,411
poems / 3,393,887 أبيات / 6,997 شعراء** in the built artefact (254,630 rows
read; 15,213 duplicate قصائد and 6 verse-less poems dropped) from `arbml/ashaar`,
of which **1,712,395 أبيات are game-playable**. Ingested into one read-only
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

## Commands

- `npm run dev:server` + `npm run dev` — dev pair (vite 5751 proxies `/api`, `/healthz` → 127.0.0.1:5750)
- `npm run typecheck` / `npm test` / `npm run build` / `npm run smoke` — the done bar
- `npm run ingest` — build `data/qarid.db` from `data/raw/*.parquet`. **Measured: 156 s, peak RSS 617 MB, 1.62 GB out** (§5 estimated 15–30 min; hyparquet made it two and a half minutes). Stop any server on the artefact first — it is replaced, not updated.
- `npm run ingest:fixture` — same `build.ts` over `test/fixtures/ashaar-sample.jsonl` → `data/fixture.db` (tests use the real ingest path)
- `node scripts/ingest/profile.ts` — re-run the corpus profiler → `data/profile.json` + `data/sample-2000.jsonl` (~3 s)
- `npm start` — prod server (reads `.env`, defaults PORT 8010)
- `node tools/screenshot.mjs [--no-build] [--mobile] [--port N] [--db PATH] [--routes …]`
  — the smoke walk. It starts the REAL server itself and kills only that PID;
  never `pkill -f server/index.ts`, the suite shares that path. The server reads
  `dist/index.html` ONCE at boot, so after `npm run build` a long-lived server
  must be restarted or it serves the previous bundle's asset hashes.

## Architecture

- `shared/` is the contract layer: `arabic.ts` (the ONLY normalizer),
  `meters.ts`, `eras.ts`, `themes.ts`, `letters.ts`, `schema.ts` (zod, single
  source of truth for every DTO and every persisted shape), `rng.ts` (seeded
  sfc32 — no `Math.random` anywhere deterministic).
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
  `/poets`, `/poets/:slug` (poet + signature بيت + first ديوان page + قافية/بحر/غرض
  chips), `/poets/:slug/poems` · **poems** `/poems`, `/poems/:publicId` (أبيات
  paired, first 200), `/poems/:publicId/baits` (offset/limit ≤ 300),
  `/poems/:publicId/similar` (amendment 9) · **baits** `/baits`,
  `/baits/random` (era/meter/**poet**/rhyme/first/fame/seed — the three
  #/wander doors), `/baits/daily`, `/baits/:id` (prev/next) · **facets**
  `/facets` · **train** `/train/candidates` · plus the `search` and `game`
  sub-apps other agents own.
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
- `client/training/` is تحفيظ's brain, all pure and all tested: `schedule.ts`
  (SM-2-lite + `buildQueue`), `grade.ts` (normalized Levenshtein + the word
  diff), `arsenal.ts` (supply / demand / weakness). The views hold no
  arithmetic. `client/store/trainingStore.ts` owns the slice.
- Client route map — `#/` home · `#/poets` · `#/poet/<slug>` ·
  `#/poem/<publicId>?bayt=N` · `#/browse?era&meter&theme&rawiyy&letter&sort&p` ·
  `#/search?q&p` · `#/duel` `#/duel/play` `#/duel/summary` · `#/daily` ·
  `#/favorites?collection` · `#/rules` · `#/stats` · `#/wander` ·
  `#/train` `#/train/drill?letter=<L>` `#/train/arsenal`. All of them render a
  real view now; «التحفيظ» is in the masthead nav and `#/wander` is reached by
  `g w` (the arsenal's «تدرّب» is what carries the `?letter`).
  The switch is the `Body` function in `client/App.tsx`: add a `case`, touch
  nothing else. The keymap is `useKeyboard` in `App.tsx` **and**
  `client/data/shortcuts.ts` (HelpOverlay renders the latter) — add to both or
  to neither, and make the label say what the key does.

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
- Derived accent vars live on `body`, NOT `:root` — the `[data-app]` override
  must compute first (family pitfall).
- Never `ORDER BY RANDOM()` on 2M+ rows; sample by the precomputed `bucket`
  column with a wrap-around window.
- `document.body.dataset.appReady = '1'` after first render — `tools/screenshot.mjs`
  waits on `body[data-app-ready="1"]`.
- localStorage keys are namespaced `qarid:v1:*`; the 255K-poem corpus never
  goes near localStorage (in-memory LRU only).
- Never letter-space or italicise Arabic; logical properties only.
- **`.gitignore` anchors `/data/`.** Unanchored, it also swallows
  `client/data/` — buhur tables, flavour أبيات, the keymap — and four source
  files sat outside the repo for three commits. Anchor every ignore rule that
  names a common directory.
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
| build | **162 s** (3 passes), peak RSS **739 MB**, deterministic (`build_id 6780a4c8`) |
| size | **1,602,347,008 B** (1.49 GiB) at `page_size = 8192` |
| rows read | 254,630 → **239,411 poems** (15,213 duplicate قصائد, 6 verse-less) |
| أبيات | **3,393,887** · شعراء **6,997** · `game_baits` **1,712,395** |
| lookups | 12 عصور · 32 meters (16 بحور + التفعيلة/الموشح/النثر/الفولكلور) · 18 أغراض |
| `combo_counts` | 19,682 rows · unmapped meters **0** |

**Dedup is a pass, not a key.** `dedup_key` is `nameKey|مطلع` — no title, no
length — and `build.ts`'s **pass 0** reads the sources once to decide WHICH copy
of each key survives (`dedupRank`: most hemistichs, then tashkeel, then a named
بحر, then aldiwan.net). With the title in the key, 6,264 duplicate قصائد
survived and landed adjacent on the first screen of التصفح («جدارية» /
«جدارية..محمود درويش» / «جدارية محمود درويش»); with the title out but first-wins
in charge, 21,110 أبيات went with the truncated copies it happened to keep.
After pass 0, `SELECT poet_id, مطلع GROUP BY … HAVING COUNT(*) > 1` is **empty**.

Tier pools (`game_baits`, the «العدد المتاح» the setup screen shows):
مبتدئ 95,094 · شاعر 742,384 · فحل 1,170,353 · سيف 1,712,395. Both middle tiers
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
245K قصائد — `?first=ا` 102 ms, `?rhyme=ر&first=ا` 149 ms, `?lang=فصيح` 232 ms —
and is then memoised for the life of the process (the artefact is immutable, so
the answer is a pure function of the query). The rail's own letters are the
expensive ones; ظ/ذ/غ are single digits cold.

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
`/api/baits` pages used to make `/healthz` take 6.6 s (now 105 ms), one used to
make it take 833 ms (now 0.9 ms). The fixes above are containment; the
structural answer — a worker thread holding the handle, `server/dto.ts` callers
async — is still unbuilt, so any NEW route that can run long is a route that can
stall every other visitor.

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

- «المتنبي» (slug `mutanabi`, 519 قصائد) and «أبو الطيب المتنبي» are two
  `poets` rows: `name_key` is identity and the two names normalize apart. Same
  for a long tail of شعراء the sources index twice. Merging needs an alias table
  in ingest, not a patch in a view.
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

systemd user unit will live in `deploy/qarid.service` (mirrors
`mimema/deploy/meme.service`: `PartOf=avicenna-suite.target`,
`WorkingDirectory=%h/Documents/side/qarid`,
`ExecStart=/usr/bin/node --env-file-if-exists=.env server/index.ts`,
`Restart=always`, `NODE_ENV=production`), symlinked from
`~/.config/systemd/user/` + `avicenna-suite.target.wants/`. Cloudflared block
`cf-qarid` (network_mode host, token `${TOKEN_QARID}`) in
`~/containers/tunnels/docker-compose.yml`; CF-dashboard ingress →
localhost:8010 is the user's job. After changing client code:
`npm run build && systemctl --user restart qarid.service`.

Done bar: `npm run typecheck && npm test && npm run build && npm run smoke`
all green, plus `curl http://127.0.0.1:8010/healthz` **and**
`curl http://[::1]:8010/healthz` after deploy.
