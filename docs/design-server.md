# قريض — Data pipeline, schema, API, deploy (authoritative)

## 0. Verified dataset facts (arbml/ashaar, revision 9b5e723df1c5b13b9e4428caff758fe2f3c737f6)
| fact | value |
|---|---|
| poems | 254,630 · baits ~3,857,429 (~7.7M hemistichs) · poets 7,167 |
| files | `data/train-00000-of-00002.parquet` (126,379,298 B, sha256 75cffe4e2fb5a44855eba3ed695fbdd8931b6d9e36f22f413466ff5574d6a467), `data/train-00001-of-00002.parquet` (150,989,177 B, sha256 6a5ff88137ce13653ef042d09a108b1ea6f7dfa5e221c9ec3abe92b6bd5cc04c) — ALREADY DOWNLOADED to `data/raw/` |
| `poem verses` length | mean 30.3, median 14, min 0, max 11608 |
| `poem meter` | 101 distinct, 101,277 null (40%); ~half prefixed `بحر `; modifiers مجزوء/مشطور/منهوك/مخلع/أحذ/مربع/المقطوع/تفعيلة |
| `poem theme` | 18 distinct, 187,110 null |
| `poet era` | own column, 14 distinct, 107,209 null → backfill per poet (modal non-null era) |
| `poet location` | 22 distinct (bonus facet) |
| `poem language type` | فصيح / فصحى / عامي / شعبي / `-` |
| `poet description` | 840 distinct, mostly null — a notability signal |
| `poet url` | `https://www.aldiwan.net/cat-poet-<slug>` → poets.slug verbatim |
| `poem url` | `.../poem16182.html` → aldiwan_id = stable PUBLIC poem key |
| `poem description` | 5-level nested DOM struct, ~half the parquet — NEVER read it; column-project the 11 flat columns |

## 1. File tree
```
qarid/
  package.json tsconfig.json vite.config.ts .env.example .gitignore CLAUDE.md README.md
  deploy/qarid.service
  shared/ arabic.ts(+test) meters.ts(+test) eras.ts themes.ts letters.ts famousPoets.ts schema.ts(+test) rng.ts constants.ts
  scripts/ingest/ fetch.ts readers.ts transform.ts(+test) build.ts index.ts
  server/ config.ts db.ts app.ts index.ts dto.ts search.ts game.ts facets.ts routes/{meta,poets,poems,baits,search,game,stats,facets}.ts app.test.ts search.test.ts game.test.ts db.test.ts
  test/fixtures/ashaar-sample.jsonl   (24 hand-picked poems, ~40KB, checked in)
  client/ (see design-ux.md)
  tools/screenshot.mjs
  data/ (gitignored: raw/*.parquet, qarid.db, fixture.db)
```

## 2. `shared/arabic.ts` — exact rules (golden-tested BEFORE anything else)
### cleanText(s) — for displayed text (keeps tashkeel)
1. NFKC (aldiwan carries presentation forms ﻻ etc.) 2. remove `[​-‏‪-‮⁦-⁩﻿]` 3. remove tatweel `ـ` 4. NBSP + whitespace → " ", collapse, trim 5. strip leading/trailing run of chars that are neither Arabic letters nor Arabic punctuation 6. if no char in `[ء-غف-ي]` → "" (caller drops).
### normalizeArabic(s) — kalam port + NFKC
1. NFKC + control strip 2. remove `[ـً-ٰٟۖ-ۭ࣓-ࣿ]` 3. `[آأإٱ]→ا` 4. `ى→ي ة→ه ؤ→و ئ→ي` 5. collapse ws, trim.
### foldLetter(ch) → one of 28: `آأإٱء→ا ى→ي ة→ه ؤ→و ئ→ي`. Alphabet order (shared/letters.ts): `ا ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ ف ق ك ل م ن ه و ي`.
### firstLetterOf(sadr): normalizeArabic → first char in Arabic letter range → foldLetter. Do NOT strip leading ال/و/ف.
### rawiyyOf(ajuz) → {rawiyy, lastLetterRaw}
1. strip tashkeel+tatweel (NO folding yet) 2. trim trailing non-Arabic-letters 3. w = last word; empty → {null,null} 4. lastLetterRaw = foldLetter(last char) 5. PEEL ≤2 iterations, never below 2 letters: (a) ends in ه/ة AND len≥4 AND preceding char ∉ {ا و ي} AND w ∉ HA_ROOT_WORDS {الله, اله, لله, وجه, فقه, شبه, …} → drop; (b) ends in ا/ى/و/ي AND len≥3 → drop; (c) else stop 6. rawiyy = foldLetter(last char).
Golden: العَليمِ→م · المُتَبَلِجِ→ج · اِرتَجي→ج · يَدعو→ع · كِتابُهُ→ب · دَعا→ع · دَعَوا→و · شِفاهُ→ه · اللَّهُ→ه.
**Store both** `baits.rawiyy` (peeled) and `baits.last_letter` (unpeeled). Facets use rawiyy; the game accepts a reply whose first_letter equals EITHER.
### ftsQuery(q, mode) — kalam port
1. extract `"…"`/`«…»` phrases → normalized `"phrase"` 2. remaining bare words: normalize, strip `/[^\p{L}\p{N}]/gu` 3. **wrap every term in double quotes** (AND/OR/NOT/NEAR become literal words) 4. join " " (AND) or " OR ". Empty → return [] without touching SQLite.

## 3. `shared/meters.ts` — normalizeMeter(raw) → {meterSlug|null, variant|null, kind}
1. cleanText; empty/"-" → unknown 2. drop leading "بحر " 3. peel modifiers (leading or trailing) into variant: مجزوء|مشطور|منهوك|مخلع|أحذ|مربع|تفعيلة|المقطوع→مقطوع|المنهوك→منهوك 4. normalizeArabic remainder, prepend ال if absent 5. canonical 16 lookup → kind 'bahr' 6. exceptions 7. else unknown + log (must be 0 at ingest end). Exhaustive test over all 101 raw values.
Canonical 16 (slug/name/tafāʿīl): tawil الطويل فعولن مفاعيلن فعولن مفاعلن · kamil الكامل متفاعلن ×3 · basit البسيط مستفعلن فاعلن مستفعلن فعلن · khafif الخفيف فاعلاتن مستفعلن فاعلاتن · wafir الوافر مفاعلتن مفاعلتن فعولن · rajaz الرجز مستفعلن ×3 · ramal الرمل فاعلاتن ×3 · mutaqarib المتقارب فعولن ×4 · sari السريع مستفعلن مستفعلن فاعلن · munsarih المنسرح مستفعلن مفعولات مستفعلن · mujtath المجتث مستفعلن فاعلاتن فاعلاتن · madid المديد فاعلاتن فاعلن فاعلاتن · hazaj الهزج مفاعيلن مفاعيلن · mudari المضارع مفاعيلن فاعلاتن · muqtadab المقتضب مفعولات مستفعلن · mutadarik المتدارك فاعلن ×4.
Exceptions: الخبب → mutadarik variant خبب kind bahr · التفعيله/شعر التفعيلة/شعر حر → taf3ila kind free · الموشح/موشح (+مجزوء/مخلع) → muwashah kind muwashah · نثريه → nathr kind prose · عموديه → amudi kind unknown · عدة أبحر → muta3addid kind unknown · الدوبيت المواليا الكان كان القوما زجل المسحوب الهجيني اللويحاني الحداء الصخري السلسلة → own rows kind folk · عامي → null/unknown and set poems.lang_type='عامي'.
Non-bahr kinds: excluded from game pool, still browsable.

## 4. Eras (14→12) and themes (18)
Eras sort/slug: 1 العصر الجاهلي jahili (absorbs قبل الإسلام) · 2 المخضرمون mukhadram (absorbs المخضرمين) · 3 العصر الإسلامي islami · 4 العصر الأموي umawi · 5 العصر العباسي abbasi · 6 الأندلس والمغرب andalus (absorbs العصر الأندلسي + المغرب والأندلس) · 7 العصر الفاطمي fatimi · 8 العصر الأيوبي ayyubi · 9 العصر المملوكي mamluki · 10 عصر بين الدولتين baynadawlatayn · 11 العصر العثماني uthmani · 12 العصر الحديث hadith.
Themes: display = raw minus "قصيدة " prefix; slugs ghazal, madh, hija, ritha, romansi, hazin, itab, shawq, firaq, dhamm, wataniya, diniya, siyasiya, itidhar, anashid, muallaqat, qasira, amma (verify against actual 18 values at ingest; unknown → log).

## 5. Schema DDL
`PRAGMA page_size=8192` BEFORE any table. Build-time: journal_mode=OFF, synchronous=OFF; ship with journal_mode=DELETE.
```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- schema_version, build_id, built_at, source_revision, counts, stats_json, facets_json
CREATE TABLE eras   (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL);
CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, display TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE meters (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, tafila TEXT, sort INTEGER NOT NULL,
                     kind TEXT NOT NULL CHECK (kind IN ('bahr','free','prose','muwashah','folk','unknown')));
CREATE TABLE poets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  letter TEXT NOT NULL, sort_key TEXT NOT NULL, era_id INTEGER REFERENCES eras(id), location TEXT, description TEXT,
  fame INTEGER NOT NULL DEFAULT 0, poem_count INTEGER NOT NULL DEFAULT 0, bait_count INTEGER NOT NULL DEFAULT 0, source_url TEXT);
CREATE INDEX poets_letter ON poets(letter, sort_key); CREATE INDEX poets_era ON poets(era_id, fame DESC, poem_count DESC); CREATE INDEX poets_fame ON poets(fame DESC, poem_count DESC);
CREATE TABLE poems (id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, aldiwan_id INTEGER UNIQUE, poet_id INTEGER NOT NULL REFERENCES poets(id),
  title TEXT NOT NULL, title_key TEXT NOT NULL, meter_id INTEGER REFERENCES meters(id), meter_variant TEXT, theme_id INTEGER REFERENCES themes(id),
  era_id INTEGER REFERENCES eras(id), lang_type TEXT, bait_count INTEGER NOT NULL, rhyme TEXT, first_letter TEXT, has_tashkeel INTEGER NOT NULL DEFAULT 0,
  preview_sadr TEXT, preview_ajuz TEXT, dedup_key TEXT NOT NULL UNIQUE, url TEXT);
CREATE INDEX poems_poet ON poems(poet_id, id); CREATE INDEX poems_filter ON poems(era_id, meter_id, theme_id, rhyme, id);
CREATE INDEX poems_meter ON poems(meter_id, bait_count, id); CREATE INDEX poems_rhyme ON poems(rhyme, id); CREATE INDEX poems_theme ON poems(theme_id, id); CREATE INDEX poems_first ON poems(first_letter, id);
CREATE TABLE baits (id INTEGER PRIMARY KEY, poem_id INTEGER NOT NULL REFERENCES poems(id), position INTEGER NOT NULL, sadr TEXT NOT NULL, ajuz TEXT,
  first_letter TEXT, rawiyy TEXT, last_letter TEXT, h_full INTEGER, h_sadr INTEGER, is_partial INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX baits_poem_pos ON baits(poem_id, position); CREATE INDEX baits_hfull ON baits(h_full); CREATE INDEX baits_hsadr ON baits(h_sadr);
CREATE VIRTUAL TABLE baits_fts USING fts5(norm, tokenize='unicode61');           -- rowid == baits.id
CREATE VIRTUAL TABLE poems_fts USING fts5(norm_title, norm_poet, tokenize='unicode61');
CREATE VIRTUAL TABLE poets_fts USING fts5(norm_name, norm_desc, tokenize='unicode61');
CREATE TABLE game_baits (bait_id INTEGER PRIMARY KEY REFERENCES baits(id), first_letter TEXT NOT NULL, rawiyy TEXT NOT NULL, poem_id INTEGER NOT NULL,
  era_id INTEGER, meter_id INTEGER, fame INTEGER NOT NULL, position INTEGER NOT NULL, bucket INTEGER NOT NULL);
CREATE INDEX gb_pick ON game_baits(first_letter, fame, bucket); CREATE INDEX gb_facet ON game_baits(first_letter, era_id, meter_id, bucket); CREATE INDEX gb_rand ON game_baits(bucket, meter_id);
```
- `public_id` = String(aldiwan_id) when present else `q<id>`; routes use public_id.
- `has_tashkeel` = 1 when ≥ 3% of Arabic chars in the poem are tashkeel marks.
- game_baits eligibility: is_partial=0 AND ajuz NOT NULL AND rawiyy NOT NULL AND first_letter NOT NULL AND meters.kind='bahr' AND length(sadr)≥8 AND length(ajuz)≥8 (~2.0–2.4M rows).
- `bucket = fnv1a(bait_id) % 1000`; sampling: `WHERE first_letter=? AND fame>=? AND bucket>=? ORDER BY bucket LIMIT 30`, wrap with `bucket<?` if short. Never ORDER BY RANDOM().
- Size estimate ~1.5 GB (1.3–1.8). If too big: drop gb_facet, then baits_hsadr, then baits_fts content=''. Record measured size/time in CLAUDE.md.

## 6. Ingest (Node + hyparquet; Python escape hatch)
- Node so ingest and server share shared/arabic.ts (no drift). `hyparquet` + `hyparquet-compressors` devDeps only; column-projected, row-group streaming.
- `readers.ts`: `readRecords(src): AsyncIterable<RawPoem>` — `.parquet` → hyparquet; `.jsonl` → line JSON (fixtures + fallback `uv run --with pyarrow scripts/ingest/parquet_to_jsonl.py`).
- `fetch.ts`: pinned revision URLs, sha256-verified, idempotent skip, `.part` + atomic rename. (Files already present in data/raw/ — verify hashes, skip download.)
- `transform.ts` (pure): title=cleanText or "بلا عنوان"; hemis = verses.map(cleanText).filter(nonempty); 0 → null; pair (2i,2i+1), odd → final bait ajuz NULL is_partial=1; per bait first_letter, rawiyyOf, h_full=fnv1a64(normalize(sadr+' '+ajuz)), h_sadr; normalizeMeter; theme/era lookup; lang فصحى|فصيح→فصيح, عامي|شعبي→عامي; poem.rhyme = modal rawiyy (tie → bait 1); poet name minus parenthetical, name_key=normalize(name), slug from poet url; aldiwan_id from poem url; dedup_key = normalize(name)|normalize(title)|normalize(hemis[0]).
- `build.ts` Pass 1: delete db, DDL, seed lookups, tx per 5,000 poems, poets ON CONFLICT(name_key) DO NOTHING (Map cache; accumulate era/location votes, longest description, slug, tallies), poems ON CONFLICT(dedup_key) DO NOTHING (first-wins; skip baits when changes()=0), batched baits, baits_fts(rowid,norm). Pass 2 SQL: poets era/location/description/counts; poems.era_id backfill from poet; preview_sadr/ajuz from position 1; fame = 3 if name_key in famousPoets OR poem_count≥300; 2 if ≥60 OR description; 1 if ≥5; else 0; poems_fts/poets_fts; game_baits; stats_json + facets_json in meta; FTS optimize ×3; ANALYZE; journal_mode=DELETE; VACUUM; asserts (0 unmapped meters, 0 zero-bait poems, every poem has poet). Expect 15–30 min, ~1 GB RSS.
- `npm run ingest:fixture` runs the same build.ts on test/fixtures/ashaar-sample.jsonl → data/fixture.db. Tests use the real ingest path.

## 7. API (Hono; `server/db.ts` opens once: `new DatabaseSync(path,{readOnly:true})`, mmap_size 2GB, cache_size -131072, temp_store MEMORY, query_only 1, prepared-statement Map cache). `hono/compress` on /api. Static dist/ serving + security headers copied from mimema/server/app.ts.
| method | path | params | returns |
|---|---|---|---|
| GET | /healthz | | ok |
| GET | /api/meta | | {buildId, counts, meters[], eras[], themes[], letters[]} |
| GET | /api/poets | letter, era, q, fame, sort=name\|poems\|baits, page, limit≤100 | {items: PoetSummary[], total, page} |
| GET | /api/poets/:slug | | {poet: PoetDetail, signatureBait, poems: PoemSummary[] (first page), rhymes[], meters[], themes[]} |
| GET | /api/poets/:slug/poems | meter, theme, rhyme, sort, page, limit | {items, total} |
| GET | /api/poems | poet, era, meter, theme, rhyme, first, lang, minBaits, maxBaits, sort=title\|length\|poet\|fame\|random(seed), page, limit | {items: PoemSummary[], total} |
| GET | /api/poems/:publicId | | {poem, poet, baits: BaitDto[] (first 200), total, hasTashkeel} |
| GET | /api/poems/:publicId/baits | offset, limit≤300 | {items, total} |
| GET | /api/baits/:id | | {bait, poem, poet, prev, next} |
| GET | /api/baits | era, meter, rhyme, first, fame, page, limit | {items: BaitDto[], total} — bayt-mode browse when rhyme/first active |
| GET | /api/facets | same filters as /api/poems | counts for EVERY value of era/meter/theme/rhyme/first (zeros included) under the current filter |
| GET | /api/search | q, scope=all\|baits\|poems\|poets, era, meter, poet, rhyme, page, limit≤40 | {baits[], poems[], poets[], mode:'and'\|'or', total, ms} |
| GET | /api/baits/random | era, meter, rhyme, first, fame, seed? | BaitDto |
| GET | /api/baits/daily | date? | {bait, poetOfTheDay} (seed = fnv1a32(date in Asia/Riyadh); pool fame≥2 position≤8) |
| GET | /api/stats | | precomputed histograms |
| GET | /api/train/candidates | letter?, famous=1, limit | BaitDto[] (fame 3, position ≤ 6) |
| POST | /api/game/start | {difficulty, filters?, seed?} | {ok, bait, requiredLetter, requiredLetterSource, alsoAccepted[]} |
| POST | /api/game/verify | {text, prevBaitId?, usedBaitIds?, filters?} | see §8 |
| POST | /api/game/reply | {letter, difficulty, excludeBaitIds[], excludePoemIds[], filters?, seed?} | {ok:true, bait, poem, poet, requiredLetter, requiredLetterSource, alsoAccepted[], obscurity} or {ok:false, reason:'no_bait'} |
All bodies/responses are zod schemas in shared/schema.ts; 400 {error, issues} on parse failure. PoemSummary served from poems+poets only (never baits). BaitDto = {id, baytKey, position, sadr, ajuz, rawiyy, firstLetter, poem:{id,title}, poet:{slug,name}, meter, era}. limit clamped. `total` always returned.
Search: bounded inner scan (`hits` CTE LIMIT 400 by bm25, then join + filters), AND→OR fallback with `mode` reported; snippet over normalized column returned as `highlight` ALONGSIDE original sadr/ajuz — client maps »« words back onto original text.
Rate limit: in-memory token bucket 12 req/10s per IP on /api/game/*.

## 8. Game (strict مساجلة; stateless — client holds usedBaitIds/usedPoemIds/score/streak; server clamps excludes to 500)
Difficulty: `easy` (fame=3 AND position≤6) · `normal` (fame≥2) · `hard` (fame≤2, prefer rare terminal rawiyy) · `brutal` (any, prefer rare rawiyy ∈ {ظ ذ غ ز ث ض ص}). UX tiers map مبتدئ→easy, شاعر→normal, فحل→hard, سيف→brutal. `easy` also avoids replying with a bait whose rawiyy ∈ rare set.
verify: 1. cleanText; split sadr/ajuz on separator (`*`, `…`, `***`, `---`, tab, 2+ spaces) else whole. 2. if prevBaitId: accepted = {prev.rawiyy, prev.last_letter}; got = firstLetterOf(text); miss → `{ok:false, reason:'wrong_letter', expected, got}`. 3. match: exact h_full → h_sadr (matchKind 'exact'); fuzzy ftsQuery AND top 5 bm25, accept iff jaccard(tokens)≥0.60 and 0.6≤len ratio≤1.6; retry OR with jaccard≥0.75. If ≥2 candidates pass with near-equal score and different poems → `{ok:false, reason:'ambiguous', candidates: BaitDto[]≤4}`. 4. used → `{ok:false, reason:'already_used', bait}`. 5. is_partial → `incomplete_bait`. 6. none → `{ok:false, reason:'not_found', suggestions: ≤3 BaitDto}`. 7. success → `{ok:true, matchKind, confidence, bait, poem, poet, requiredLetter: bait.rawiyy, requiredLetterSource, alsoAccepted:[bait.last_letter], obscurity}`. `too_short` when < 2 words.
requiredLetterSource = 'rawiyy' when rawiyy===last_letter else 'peeled'. obscurity = clamp(1 - fame/3 + (position>8 ? 0.15 : 0), 0, 1).
reply: fold letter; tier predicate; bucket sampling LIMIT 40 (+wrap); drop excludes (bait AND poem); empty → relax one tier once; still empty → `{ok:false, reason:'no_bait', letter}` (client = «أفحمتَ الخصم» victory). Optional seed for determinism.

## 9. Deploy
`.env.example`: HOST=127.0.0.1, PORT=8010, PUBLIC_ORIGIN=https://qarid.avicenna.space, #DB_PATH. `deploy/qarid.service` mirrors mimema/deploy/meme.service (PartOf=avicenna-suite.target, WorkingDirectory=%h/Documents/side/qarid, ExecStart=/usr/bin/node --env-file-if-exists=.env server/index.ts, Restart=always, NODE_ENV=production). server/index.ts copies mimema's dual 127.0.0.1 + ::1 bind. cloudflared block `cf-qarid` (network_mode host, token ${TOKEN_QARID}) in /home/avicenna/containers/tunnels/docker-compose.yml; ingress in CF dashboard → localhost:8010 (user does dashboard part).
vite.config.ts: server.port 5751 strictPort, proxy /api + /healthz → http://127.0.0.1:5750; preview.port 6750.
Scripts: dev (vite 5751), dev:server (PORT=5750 node --watch), build (tsc && vite build), preview (6750), start, typecheck, test (vitest run), smoke (tools/screenshot.mjs), ingest, ingest:fixture.
Done bar: `npm run typecheck && npm test && npm run build && npm run smoke`; curl /healthz on 127.0.0.1:8010 and [::1]:8010.
screenshot.mjs: mimema structure; server on 6750 with DB = data/qarid.db else data/fixture.db else fail; routes home, poets, poet, poem, browse, search, duel, daily; waits `body[data-app-ready="1"]` (set after first data fetch resolves); fails on console error/pageerror; writes screenshots/<route>.png.

## 10. Tests
shared/arabic.test.ts golden (normalize incl. NFKC + bidi; foldLetter 6 folds; firstLetterOf; rawiyyOf ≥ 9 worked examples + edge cases; ftsQuery phrase/operator injection/empty). shared/meters.test.ts exhaustive 101 values + null/""/"-"/trailing space. eras test (merges, sort). transform.test.ts (pairing, odd, empty, junk-mid, dedup ا/أ, aldiwan_id, slug, tadwir split). db.test.ts (read-only, FTS5 present, write throws). app.test.ts (every route via app.request() on fixture.db built in globalSetup; pagination clamp; 404s; filters). search.test.ts (AND, AND→OR mode, injection 200, empty q, »« snippet, 400 cap). game.test.ts (exact/fuzzy/wrong_letter/already_used/not_found+suggestions/last_letter leniency/ambiguous; reply seed determinism, excludes, no_bait; daily deterministic).
Fixture: 24 poems covering 6 meter kinds, odd hemistich count, empty verses, duplicate pair, two spellings of one poet, null era backfilled, tadwir split, hamza rhyme.

## 11. Phase 0 spike (do first, record in CLAUDE.md)
(a) node:sqlite in Node 26 has FTS5 (`CREATE VIRTUAL TABLE t USING fts5(x)`); else pivot db.ts to better-sqlite3. (b) hyparquet reads shard 0 with the 11 flat columns projected without choking on the nested column. (c) rawiyyOf agreement per poem > ~90% over 200 real ajuz.

## 12. Risks → mitigations
node:sqlite lacks FTS5 → better-sqlite3 isolated in db.ts · hyparquet fails → JSONL fallback via readRecords · DB > 2GB → drop indexes per §5 · rawiyy peel disputes → dual-letter acceptance · 40% null meter → optional facet, excluded from game · duplicates → dedup_key first-wins · filtered FTS degenerates → 400-row inner cap · 11,608-hemistich poem → paginated baits.
