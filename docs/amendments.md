# Amendments — merged from a second independent design pass (these override design-server.md / design-ux.md where they conflict)

1. **Two chain modes stored per bait, one displayed.** Store `rawiyy` (peeled الروي, classical) AND `last_letter` (literal final letter, "street rules"). Game setting `mode: 'rhyme' | 'literal'` (default 'rhyme'). In 'rhyme' mode verify accepts either letter (leniency); in 'literal' mode only last_letter. UI always shows the required letter explicitly with its provenance word underlined in lapis.
2. **`combo_counts(first_letter, era_id, meter_id, tier, n)` WITHOUT ROWID** materialized at ingest → setup screen shows live eligible-pool counts instantly and `/api/game/reply` can short-circuit an exhausted combination without a scan.
3. **Playability predicate** for game_baits (stricter than length≥8): both halves 12–80 chars after stripping, length ratio 0.5–2.0 (catches tadwir splits), letters resolve, no ASCII/digits/placeholder runs, lang ≠ عامي.
4. **Deterministic rebuilds**: per-bait `bucket`/`rand` derived from a hash of (poem dedup_key, position), not of autoincrement id, so a rebuild yields the same daily bayt.
5. **`tailBias`** on `/api/game/reply`: `'easy'|'none'|'hard'` — the real difficulty lever. easy avoids replies whose rawiyy ∈ rare {ظ ذ غ ز ث ض ص ط خ}; hard prefers them and prefers `opens_conj=0` baits (store `opens_conj` = sadr starts with bare و/ف).
6. **Daily opponent is seeded**: reply seed = `${dailySeed}:${turn}` so everyone faces the same chain on `#/daily`.
7. **near_miss tier** in verify: FTS score band 0.35–0.60 → `reason:'near_miss'` with one `suggestion` bait and an «اقبل هذا البيت» button costing −25 pts (distinct from `not_found` which only shows «هل تقصد؟» list). Fairness: time spent in verifying/rejected is added back to the deadline; timers wall-clock anchored.
8. Extra hint «بدّل الحرف» −150 + streak reset (server picks a new required letter from a random famous bait) — a mercy option so a duel never dead-ends on ظ.
9. `GET /api/poems/:id/similar` (same poet+meter+rhyme, then same meter+rhyme) — cheap, powers «قصائد على الوزن والقافية» on the poem page.
10. `/api/meta` includes per-letter `{startsWith, endsWith}` corpus counts → arsenal "weakness = endsWith-demand × (1 − supply/8)" and browse letter-grid counts without a facets call.
11. Themes: قصيرة/عامة are *buckets* (kind:'bucket'), hidden from the theme filter chips but still browsable via URL. Eras carry `kind: 'period'|'region'` (الأندلس والمغرب is a region).
12. Poem page for >300 abyat: `content-visibility:auto` per bait row instead of virtualization (keeps Ctrl+F, anchors, selection). `?bayt=n` deep links.
13. Client pre-check on wrong letter = no server call (instant feedback); server remains authority on accept.
14. Search highlight: parse »« into `<mark>` styled as lapis **underline**, not background fill.
15. `<bdi>` around every interpolated data string in mixed-direction contexts; `←` = next, `→` = previous in RTL.
16. Scoring: `base × streakMult + timeBonus + obscurityBonus(log poet poem_count)`; stuck opponent («أفحمتَ الخصم») = +500.
17. Idempotency test: ingest the fixture twice → byte-identical row sets.
