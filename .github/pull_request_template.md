**What this changes, and why**

**The done bar** — all four, please:

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run smoke` (desktop **and** `--mobile` if the change is visual)

**Invariants** (see `CLAUDE.md`)

- [ ] No second normalizer — Arabic text still folds through `shared/arabic.ts`
- [ ] Any number a reader sees goes through `shared/format.ts`, agreement and all
- [ ] Nothing in a request path writes to the corpus artefact

**If it is visual**, attach the before/after from `screenshots/`.

**If it touches the ingest**, give the row counts before and after.
