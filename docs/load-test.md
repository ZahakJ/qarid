# Load test

`tools/loadtest.mjs` sweeps closed-loop concurrency over a mix of reads (meta,
stats, facets, browse, a poem, search, deep `/api/baits` pages, training
candidates) and probes `/healthz` alongside. `/healthz` touches no database, so
its latency is the queueing cost of the single synchronous event loop.

```sh
BASE=http://127.0.0.1:6760 node tools/loadtest.mjs     # a server on the real corpus, not production
LEVELS=1,5,10,25,50,100 DUR=4000 node tools/loadtest.mjs
```

Node 26.7, full corpus (`build_id bbe2f944`):

| concurrency | throughput | `/healthz` p50 / p95 / max (ms) |
|---|---|---|
| 1   | 119 rps | 7 / 20 / 22 |
| 5   | 159 rps | 17 / 40 / 60 |
| 10  | 157 rps | 32 / 75 / 88 |
| 25  | 175 rps | 109 / 178 / 236 |
| 50  | 178 rps | 184 / 1240 / 1240 |
| 100 | 199 rps | 353 / 600 / 600 |

Throughput is flat at the one-loop ceiling; extra concurrency becomes queue.
A 200-way flood of the heaviest route produced no errors and memory levelled
off at ~283 MB.

Moving SQLite to a worker thread is the fix if `/healthz` p95 passes 150 ms at
real traffic, or a route passes 200 ms p95 on the real corpus.
