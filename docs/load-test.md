# Load test — the concurrency ceiling of the single-loop, synchronous design

Run 2026-08-25 on Node v26.7.0, the real `data/qarid.db` (`build_id bbe2f944`,
238,733 قصائد / 3,371,410 أبيات / 1,709,893 `game_baits`), a server the tester
owns on port 6760 with a scratch `USERS_DB_PATH`, `NODE_ENV=production`. The
harness is `tools/loadtest.mjs` — re-run it to re-check the trigger below.

This is the measurement that a **public Play-Store launch** asked for: the launch
is what trips trigger (a) of the §Backlog architecture note (the site stops being
single-reader), so before it, the actual multi-reader ceiling of the current
design had to be measured rather than guessed. The headline: **the design
degrades gracefully far past any realistic niche concurrency, there is no cliff
to remove, and the lightest hardening — a load-shed valve — was built twice and
measured to be either inert or actively harmful on this architecture.** The
right-sized launch posture is the containment that already exists; the concrete
signal that changes that is written at the end.

## Method

`tools/loadtest.mjs` sweeps offered concurrency (1, 5, 10, 25, 50, 100 closed-loop
workers) over a realistic route mix — mostly cheap/cached reads (`/api/meta`,
`/api/stats`, `/api/facets`, browse, a poem, `/api/search`), with the occasional
deep/expensive corpus query (`/api/baits` deep pages and بيت-mode, `/api/train/
candidates`). Alongside the load it runs a dedicated **`/healthz` prober**: the
liveness route touches no database, so its latency under load is the pure
head-of-line-blocking cost the synchronous single-loop imposes. Budget is 150 ms.

## Result — the ceiling

| offered conc | throughput | `/healthz` p50 / p95 / max (ms) | budget |
|---|---|---|---|
| 1   | 119 rps | 7 / 20 / 22    | ok |
| 5   | 159 rps | 17 / 40 / 60   | ok |
| 10  | 157 rps | 32 / 75 / 88   | ok |
| 25  | 175 rps | 109 / 178 / 236 | **over** |
| 50  | 178 rps | 184 / 1240 / 1240 | **over** |
| 100 | 199 rps | 353 / 600 / 600 | **over** |

Read across, three facts:

1. **`/healthz` holds its 150 ms budget through ~10–15 concurrent corpus
   readers, and first breaches it around 20–25.** Realistic launch concurrency
   for a niche Arabic-poetry app is single digits, and there the probe is
   comfortable (p95 ≤ 75 ms at 10). The breach appears only at a sustained
   simultaneous load — 25 readers all hammering a mix that includes the deep
   query paths — that is already an unrealistic peak for this audience.

2. **Throughput is flat at ~150–200 rps regardless of offered concurrency.**
   `node:sqlite` is synchronous on one event loop, so the loop serves ~150
   corpus-query requests a second and offered concurrency past that does not add
   throughput — it adds queue. Every request (the 0.7 ms `/api/meta` included)
   stacks behind the backlog, which is why even the cheap routes climb with the
   deep ones under load.

3. **It degrades gracefully — there is no death spiral.** Across the sweep and a
   separate 8-second 200-way flood of the heaviest route: **zero errors, no
   crash, throughput held**, and RSS went 198 MB idle → 258 MB mid-flood → 283 MB
   and then FLAT. The backlog is bounded, not runaway; the loop drains it and
   memory settles. Nothing here spirals.

## Why the load-shed valve was rejected (both designs measured)

The lightest structural hardening for a public launch would be a safety valve:
bound the expensive-query backlog and shed the surplus with a fast 503 +
`Retry-After` so one burst cannot starve `/healthz`. It was built and measured,
and **neither form works on this architecture** — the measurements overrode the
prior:

- **A bounded in-flight counter cannot fire.** A synchronous query blocks the
  loop so completely that a request runs its whole middleware chain, query and
  response as ONE uninterrupted unit (its awaited continuations are microtasks,
  and microtasks drain before the loop services the next socket). Requests are
  therefore serialized BELOW userland, in the OS/Node accept queue; they never
  reach the middleware two-at-a-time. Instrumented under an 80-way simultaneous
  burst, the in-flight counter **peaked at exactly 1**. A gate that never sees
  concurrency can never shed it.

- **An event-loop-lag valve over-sheds legitimate load and never restores the
  budget.** The backlog is invisible to a counter but visible as loop lag, so the
  second design shed corpus requests when `monitorEventLoopDelay` climbed past a
  threshold. On a serialized loop, though, the loop is either idle (one reader,
  ~0–2 ms lag) or saturated (many readers, tens of ms) with little in between —
  lag cannot tell "10 legitimate readers" (fine) from "100 flood" (bad). Measured:
  at a 40 ms threshold it shed **97 % of traffic at concurrency 10**, which is
  within budget and should never shed; raising the threshold to 150–250 ms left
  moderate load alone but then shed 67–90 % at higher load **without pulling
  `/healthz` back under 150 ms** — at 250 ms, concurrency-50 `/healthz` p95 got
  *worse* (1423 ms) from the shed/accept oscillation. A valve that harms the
  legitimate case and fails the overload case is over-engineering, which the
  task named as its own failure.

The structural cure for head-of-line blocking is the SQLite worker thread, and it
stays deferred for the documented reasons (a message hop on every 0.4 ms
`/api/meta`, async-ing every route/helper/test). Until its trigger fires, the
containment already in place — five indexes, narrow-subquery sorts, the facet
memo + boot pre-warm, the game-body cap, the search prefix-floor, the per-IP
limiters — is what keeps the degradation graceful, and that is the correct
launch-scale posture.

## Audit — no new route added since the latency table scans

The routes that landed after the §Latency table (avatars, moderation/report,
recovery) all live on the tiny writable users db, not the corpus, and hit an
index on their hot lookup: recovery is keyed by `user_id` (PK), the avatar serve
reads bytes by `user_id` (PK), `findUserByUsername` uses the `UNIQUE COLLATE
NOCASE` index, blocks are the `(blocker_id, blocked_id)` PK, the report queue
rides `user_reports_status`. The one unindexed path is the admin `status=all`
report archive — an owner-only, allowlisted, rate-limited, low-cardinality tool,
capped at 200 rows — which is acceptable and not a launch hazard.

## Revisit trigger — build the worker thread when

The §Backlog note's triggers, now measured and dated: build the SQLite worker
thread (and not before) when re-running `tools/loadtest.mjs` on the real corpus
shows **`/healthz` p95 leaving its 150 ms budget at a concurrency the live site
actually sustains** — i.e. real traffic regularly puts ~20+ simultaneous readers
on the expensive query paths — OR any single route measures **> 200 ms p95** on
the real corpus, OR a NEW route lands that can run long by construction (an
unmemoisable scan, a user-supplied `LIKE '%…%'`, a per-request aggregate over
`game_baits`). The launch itself does not fire this: at its realistic
concurrency the budget holds, and the flood case degrades gracefully rather than
falling over.
