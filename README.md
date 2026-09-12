<p align="center">
  <img src="docs/media/banner.png" alt="قريض — an Arabic poetry diwan, and a duel on the rhyme. 238,733 poems, 3,369,701 verses, 6,941 poets." width="820">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-d6ad60" alt="Licence: AGPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/tests-1%2C583-d6ad60" alt="1,583 tests">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-d6ad60" alt="Node 24 or newer">
  <img src="https://img.shields.io/badge/server%20deps-3-d6ad60" alt="Three server dependencies">
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/security-report%20privately-d6ad60" alt="Security policy"></a>
</p>

<p align="center">
  <a href="https://zahakj.github.io/qarid/"><b>zahakj.github.io/qarid</b></a> — what it is, what it holds, and how to run your own
</p>

**قَريض** — the old Arabic word for verse itself — is a browsable ديوان of the
classical Arabic corpus **and** a strict مساجلة duel played against it.

Three and a third million أبيات by nearly seven thousand شعراء, ingested into a
single read-only SQLite artefact: browsable by عصر, بحر, غرض and روي, searchable
with FTS5, and playable. In a مساجلة the machine recites a بيت and you must
answer with one that **starts on its روي** — the letter its rhyme runs on. It
judges by the same rule the قدماء did, and it does not accept a near miss.

It runs on the web and as an Android app, from one codebase. The whole interface
is in Arabic, right-to-left, set in Amiri and Aref Ruqaa.

![The home page: بيت اليوم, the corpus counts, and the curated anthologies](docs/media/home.png)

> The first screen is one بيت — the same one for everybody, that day — and the
> doors under it. Nothing here asks you to sign in.

| | |
|---|---|
| ![A قصيدة laid out as a printed diwan page, two hemistichs on the outer margins](docs/media/poem.png) | ![The شعراء index, folded by the letter each poet is known by](docs/media/poets.png) |
| *A قصيدة, set as a ديوان page — أبيات on the outer margins, a quiet centre channel* | *6,941 شعراء, folded by the letter each is known by* |
| ![A مساجلة in progress against the corpus](docs/media/duel.png) | ![The sixteen بحور with their تفعيلات and an exemplar بيت each](docs/media/buhur.png) |
| *A مساجلة: answer on the روي, or concede* | *The sixteen بحور, each with its تفعيلات and a شاهد* |
| ![Search results across poems, poets and verses](docs/media/search.png) | ![دواويني — the shelves a reader compiles](docs/media/diwans.png) |
| *FTS5 search over three million أبيات* | *دواوين — shelves a reader compiles, orders and shares* |

<p align="center">
  <img src="docs/media/home-phone.png" alt="The home page on a phone" width="240">
  <img src="docs/media/poem-phone.png" alt="A قصيدة on a phone" width="240">
  <img src="docs/media/duel-phone.png" alt="A مساجلة on a phone" width="240">
</p>

<p align="center"><i>The same app on a phone — a real phone build, not a narrowed window</i></p>

## What it does

**Read.** Browse by عصر, بحر, غرض or روي; search anything with FTS5; open a
شاعر's ديوان; read a قصيدة in a reading mode where every bar stands down and the
أبيات alone run down one measure. تشكيل on or off, three verse sizes, the روي
underlined on request.

**Play.** A مساجلة against the corpus: it recites, you answer on the روي. Scored,
timed, with an arsenal of letters you have proved you can answer on. Or play a
friend in a room over a WebSocket — the whole match is decided server-side, so
neither client can lie about a بيت.

**Keep.** المختارات is a ♥ list held in your browser, no account needed.
دواوين are named, ordered, shareable shelves that live on an account — compile
one, reorder it by hand, and play a مساجلة inside it.

**Learn.** التحفيظ drills a قصيدة until you have it. المختارات المنظومة are
curated shelves — the ten المعلقات, a hundred proverbial أبيات — resolved
against the corpus at runtime rather than copied out of it.

## Run it

Needs **Node 24 or newer** — it runs TypeScript directly, with no server build
step, which needs unflagged type-stripping and `node:sqlite`. Developed and
deployed on Node 26. Budget about 1.6 GB of disk for the artefact.

```sh
git clone https://github.com/ZahakJ/qarid && cd qarid
npm install
cp .env.example .env          # then set PUBLIC_ORIGIN

# Build the corpus. Put arbml/ashaar's parquet files in data/raw/ first.
npm run ingest                # ~3 minutes, ~700 MB peak, 1.6 GB out

npm run dev:server & npm run dev
```

Without the corpus you can still run everything against a fixture:

```sh
npm run ingest:fixture        # seconds, from test/fixtures/
```

In production the server binds loopback only and serves the built client
itself, so put a reverse proxy or a tunnel in front of it for TLS.
`deploy/qarid.service` is a systemd **user** unit for exactly that.

```sh
npm run build && npm start
```

The done bar, all four green:

```sh
npm run typecheck && npm test && npm run build && npm run smoke
```

`npm run smoke` starts the real server and walks 29 routes at desktop and phone
widths in headless Chromium, failing on any console error.

## How it is built

One npm package. The server runs on **three** — `hono` and its two Node
adapters — plus Node's own `node:sqlite`; the client adds React, zustand and
zod. No ORM, no query builder, no bundler on the server.

- **`shared/`** is the contract layer both halves import: one Arabic normalizer,
  one number formatter, one seeded RNG, and zod schemas that are the single
  source of truth for every DTO on the wire.
- **`scripts/ingest/`** streams `arbml/ashaar` → a read-only SQLite artefact in
  two passes. It is Node rather than Python precisely so it imports the same
  normalizer the server does, and the two can never drift.
- **`server/`** is Hono on Node's own `node:sqlite`, opened **read-only** so a
  stray write throws instead of corrupting the corpus. `app.ts` is listen-free,
  so the tests drive it in-process.
- **`client/`** is Vite + React, hash-routed, RTL. One بيت renderer, one share
  card renderer, one formatter.

The corpus artefact is immutable at runtime. The only writable database is the
accounts one, and it is a separate file.

Design notes live in [`docs/`](docs/) and the working invariants — the
hard-won ones, with the measurements that earned them — in
[`CLAUDE.md`](CLAUDE.md).

## The corpus

The verses come from [**arbml/ashaar**](https://huggingface.co/datasets/arbml/ashaar),
a dataset of classical and modern Arabic poetry. قريض ingests it, normalizes it
and indexes it; it does not redistribute it — `data/` is not in this repository
and you build the artefact yourself.

254,630 rows are read; 15,891 duplicate قصائد and 6 verse-less poems are dropped,
leaving 238,733. Of the 3,369,701 أبيات, **1,713,459 are game-playable** — a بيت
needs both halves and a resolvable روي before a مساجلة can ask you to answer it.

The corpus is scraped, and it shows: some titles are the مطلع with the تشكيل
stripped, 39.8% of قصائد carry no بحر, and a few أبيات lost a hemistich on the
way in. قريض works around these rather than pretending they are not there —
[`CLAUDE.md`](CLAUDE.md) names the ones worth knowing before you "fix" them.

## Licence

[AGPL-3.0-or-later](LICENSE). If you run a modified قريض as a network service,
that licence asks you to offer your users its source.

The corpus is the dataset's, under its own terms. The fonts are
[Amiri](https://github.com/alif-type/amiri) (OFL),
[Aref Ruqaa](https://github.com/aliftype/aref-ruqaa) (OFL) and
IBM Plex Sans Arabic / Mono (OFL).
