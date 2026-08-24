<div dir="rtl">

# قَريض

**ديوانُ الشِّعرِ العربيِّ ومُساجَلتُه** — <https://qarid.avicenna.space>

قَريضٌ اسمٌ قديمٌ للشِّعرِ نفسِه. هذا الموقعُ شيئان في واحد:

- **ديوانٌ يُتصفَّح**: 238,733 قصيدةً و3,371,410 بيتًا لـ6,941 شاعرًا، مرتَّبةً
  بالعصرِ والبحرِ والغرضِ والرَّوِيِّ، مع بحثٍ في المتنِ كلِّه.
- **مُساجَلة**: يُنشِدُ الخصمُ بيتًا، وعليك أن تُجيبَه ببيتٍ يبدأُ برَوِيِّه.
  أربعُ مراتب — مُبتدئ، شاعر، فحل، سيف — وساعةٌ ونفَسٌ وترسانةٌ تُبنى ممّا
  تحفَظ.

وفيه أيضًا **بيتُ اليوم**، و**التَّحفيظ** (تكرارٌ متباعدٌ لما تُريدُ حفظَه)،
و**التَّجوال** بين الأبياتِ على غيرِ هُدًى، و**بطاقاتٌ** تُشارَك.

المتنُ من `arbml/ashaar`، بعِلَلِه وتصحيفاتِه؛ ما فيه من خطأٍ فمن المصدر،
وما فيه من صوابٍ فمن الشُّعراء.

</div>

---

## Dev notes (English)

A single npm package: **Vite 7 + React 19** client, **Hono 4** server run
directly by **Node 26** (TS type-stripping — there is no server build step),
reading one **read-only SQLite artefact** through `node:sqlite`.

### Commands

| command | what it does |
|---|---|
| `npm run dev:server` | API on **5750** (`--watch`, reads `.env`) |
| `npm run dev` | Vite on **5751**, proxies `/api` + `/healthz` → 5750 |
| `npm run typecheck` | `tsc -p tsconfig.json` |
| `npm test` | vitest, 857 tests over `data/fixture.db` |
| `npm run build` | `tsc` + `vite build` → `dist/` |
| `npm run smoke` | `tools/screenshot.mjs` — starts the real server, walks every route in headless Chromium, fails on any console error |
| `npm start` | production server (reads `.env`, defaults to **8010**) |

`node tools/screenshot.mjs [--no-build] [--mobile] [--full] [--port N] [--db PATH] [--routes home,browse,…]`
is the smoke walk. It kills **only** the child it spawned — never
`pkill -f server/index.ts`, the whole suite shares that path.

### The corpus artefact

`data/qarid.db` is **gitignored and rebuildable**, not a source file. Build it:

```sh
node scripts/ingest/index.ts fetch     # verify data/raw/*.parquet (pinned sha256)
npm run ingest                         # ~162 s, peak RSS 739 MB → 1.49 GiB
npm run ingest:fixture                 # data/fixture.db for the test suite
```

Ingest is Node, not Python, so it imports the same `shared/arabic.ts` the
server does — there is exactly one normalizer and it cannot drift. Three
passes: pass 0 decides which copy of each duplicate قصيدة survives, then the
rows land, then the derived tables (`game_baits`, `combo_counts`, the FTS
index, and the precomputed `meta_json` / `stats_json` blobs).

**Rebuild to a side path when a server has the file open**, or SQLite will
hand you `database is locked` half way through and leave a truncated artefact:

```sh
node scripts/ingest/index.ts build data/raw/*.parquet data/qarid.build.db \
  && mv -f data/qarid.build.db data/qarid.db \
  && systemctl --user restart qarid.service
```

A missing artefact is tolerated at boot: `/healthz` and the static client still
serve, `/api/*` answers 503. systemd never crash-loops on a fresh box.

### Layout

```
shared/     the contract layer — arabic.ts (the ONLY normalizer), schema.ts
            (zod; every DTO and every persisted shape), meters/eras/themes/
            letters, rng.ts (seeded sfc32)
scripts/    ingest: readers → transform (pure, tested) → build (3 passes)
server/     Hono. app.ts is listen-free so tests drive app.request();
            routes/ are mounted at the one marked block; dto.ts is the only
            place a column name is spelled
client/     React, hash-routed, RTL. BaytPlate is the only بيت renderer;
            training/ holds all of التحفيظ's arithmetic; share/renderCard.ts
            is the only share-card renderer
docs/       design-server.md, design-ux.md, amendments.md (amendments win)
tools/      screenshot.mjs (the smoke walk) + smoke-seed.json
```

Read `CLAUDE.md` before changing anything — it carries the invariants that
were expensive to learn (header ordering under `compress()`, grid automatic
minimums, the two writers of `qarid:v1:training`, why `ORDER BY RANDOM()` is
banned).

### Deploy

Ports: dev API **5750** · dev Vite **5751** · preview/smoke **6750** · prod
**8010**. 8010 is what the Cloudflare tunnel's ingress points at, so moving it
means editing the CF dashboard too.

```sh
cp .env.example .env          # HOST/PORT/PUBLIC_ORIGIN/DB_PATH
ln -s "$PWD/deploy/qarid.service" ~/.config/systemd/user/qarid.service
ln -s "$PWD/deploy/qarid.service" \
      ~/.config/systemd/user/avicenna-suite.target.wants/qarid.service
systemctl --user daemon-reload && systemctl --user enable --now qarid.service
curl http://127.0.0.1:8010/healthz && curl http://[::1]:8010/healthz
```

The server binds **both** `127.0.0.1` and `::1` — cloudflared resolves
"localhost" to `::1` first and dropping the twin bind 502s the tunnel.

Cloudflare: the `cf-qarid` service in `~/containers/tunnels/docker-compose.yml`
(host networking, `${TOKEN_QARID}`). The tunnel itself and its public hostname
(`qarid.avicenna.space` → `http://localhost:8010`) are created by hand in the
Zero Trust dashboard.

**After changing client code**: `npm run build && systemctl --user restart
qarid.service`. The server reads `dist/index.html` exactly once, at boot — skip
the restart and every hashed asset 404s.

### Accounts (v2 §4)

Everything the ديوان does is readable without an account; an account exists for
1v1 مساجلة and for a page with your name on it (`#/u/<username>`). It lives in
a **second, writable** database — `data/qarid-users.db`, `USERS_DB_PATH` — while
the corpus artefact stays `readOnly` + `query_only=1`. If that file cannot be
created (a read-only `data/`), the server logs one line, keeps serving the whole
site, and answers `/api/auth/*` with 503.

Registration is **open by default**. `REQUIRE_INVITE=1` closes it and
`INVITE_CODES=a,b,c` reopens it to those codes (with no codes set, to nobody).

**There is no email, so there is no password reset.** To remove or rename an
account, edit the row:

```sh
sqlite3 data/qarid-users.db "DELETE FROM users WHERE username = 'labid';"
# sessions, the arsenal snapshot and match rows go with it (ON DELETE CASCADE)
```

Passwords are `node:crypto` scrypt (N=16384, per-user salt, `timingSafeEqual`);
the session cookie `qarid_sess` is HttpOnly + SameSite=Lax + Secure whenever
`PUBLIC_ORIGIN` is https, 90 days, rolling, and the table stores only the
SHA-256 of the token it carries.

### License

Code is the author's. The corpus is `arbml/ashaar`'s and the poems are, as
they have been for fourteen centuries, everyone's.
