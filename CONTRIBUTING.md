# Contributing

Two things first: the project's opinions are written down, and the done bar is
not negotiable.

## The done bar

Every change, however small, goes through all four:

```sh
npm run typecheck && npm test && npm run build && npm run smoke
```

`npm run smoke` starts the real server against a real artefact and walks 29
routes at desktop **and** phone widths in headless Chromium, failing on any
console error. If you have no corpus built, `npm run ingest:fixture` gives you
one in seconds and `--db data/fixture.db` points the walk at it.

## Read `CLAUDE.md` first

It is long and it is the point. It holds the invariants this codebase has
already paid for — each one with the measurement or the bug that earned it.
A patch that violates one will be asked to change, so it is cheaper to skim it
first. The ones that catch newcomers most often:

- **`shared/arabic.ts` is the only normalizer.** The FTS index, the chain
  letter, the ديوان anchors and the search query all fold text the same way.
  A second normalizer is a silent corpus bug.
- **العدد والمعدود live in `shared/format.ts`, never at the call site.** Arabic
  agreement is not decoration: «12 بيت» is wrong, «بيتان» is not «2 بيت», and a
  نعت beside a معدود has to agree too. Five functions, and which you need
  depends on the grammar of the sentence you are writing.
- **Western digits everywhere a reader sees a number** — `0-9`, and never glued
  to a hand-written noun.
- **The corpus artefact is opened read-only.** Nothing in a request path may
  write to it.

## Shape of a change

- **Arabic for every user-facing string, English for code and comments.** The
  interface has no English in it.
- **Comments say why, not what.** The house style explains the decision and the
  thing that went wrong before it — see any file for the register.
- **Tests where there is real logic.** Pure functions get unit tests; routes get
  driven through `app.request()` in-process. A test that would have caught the
  bug you are fixing is worth more than three that would not.
- **No new runtime dependency without a reason in the PR description.** The
  server runs on three packages and Node's own sqlite, deliberately.

## Corpus changes

The ingest is the only thing that writes the artefact, and it is reproducible:
two builds of the same input must be byte-identical. If you change
`scripts/ingest/`, say in the PR what the row counts were before and after.

## Reporting things

Bugs and features: open an issue. Security: **do not** open an issue — see
[SECURITY.md](SECURITY.md).
