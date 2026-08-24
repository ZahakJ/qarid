# قريض (Qarid)

Arabic classical poetry corpus browser **and** مساجلة duel at
**qarid.avicenna.space** — قَرِيض, the old word for verse itself. 254,630 poems
/ ~3.86M أبيات / 7,167 شعراء from `arbml/ashaar`, ingested into one read-only
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
- `npm run ingest` — build `data/qarid.db` from `data/raw/*.parquet` (expect 15–30 min, ~1 GB RSS)
- `npm run ingest:fixture` — same `build.ts` over `test/fixtures/ashaar-sample.jsonl` → `data/fixture.db` (tests use the real ingest path)
- `node scripts/ingest/profile.ts` — re-run the corpus profiler → `data/profile.json` + `data/sample-2000.jsonl` (~3 s)
- `npm start` — prod server (reads `.env`, defaults PORT 8010)

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
- `client/` React, hash-routed, `<html lang="ar" dir="rtl">`,
  `<body data-app="qarid">`; `BaytPlate` is the only بيت renderer,
  `renderCard.ts` the only share-card renderer. Layout in design-ux.md.

### Invariants (hard-won)

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
