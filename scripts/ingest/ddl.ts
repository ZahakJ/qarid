/**
 * The artefact's DDL — design-server.md §5 verbatim, plus the three additions
 * the amendments require. Kept in its own module so `build.ts` reads as a
 * pipeline and so `build.test.ts` can assert the shipped shape against one
 * source of truth.
 *
 * Additions to §5, each with the amendment that forces it:
 *   · `combo_counts` (amendment 2) — the materialised eligible-pool counter.
 *   · `game_baits.opens_conj` (amendment 5) — the tailBias ranking hint.
 *   · `game_baits.rand` (amendment 4) — a wide deterministic tiebreak, derived
 *     from the same (dedup_key, position) hash as `bucket`.
 * Nothing in §5 was removed or renamed.
 */

/** `PRAGMA page_size` must run on the empty file, BEFORE the first table. */
export const BUILD_PRAGMAS = [
  "PRAGMA page_size = 8192",
  "PRAGMA journal_mode = OFF",
  "PRAGMA synchronous = OFF",
  "PRAGMA temp_store = MEMORY",
  "PRAGMA cache_size = -262144",
] as const

export const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE eras   (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, display TEXT NOT NULL, sort INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE meters (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, tafila TEXT, sort INTEGER NOT NULL,
                     kind TEXT NOT NULL CHECK (kind IN ('bahr','free','prose','muwashah','folk','unknown')));

CREATE TABLE poets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  letter TEXT NOT NULL, sort_key TEXT NOT NULL, era_id INTEGER REFERENCES eras(id), location TEXT, description TEXT,
  fame INTEGER NOT NULL DEFAULT 0, poem_count INTEGER NOT NULL DEFAULT 0, bait_count INTEGER NOT NULL DEFAULT 0, source_url TEXT);

CREATE TABLE poems (id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, aldiwan_id INTEGER UNIQUE, poet_id INTEGER NOT NULL REFERENCES poets(id),
  title TEXT NOT NULL, title_key TEXT NOT NULL, meter_id INTEGER REFERENCES meters(id), meter_variant TEXT, theme_id INTEGER REFERENCES themes(id),
  era_id INTEGER REFERENCES eras(id), lang_type TEXT, bait_count INTEGER NOT NULL, rhyme TEXT, rhyme_share REAL, first_letter TEXT, has_tashkeel INTEGER NOT NULL DEFAULT 0,
  preview_sadr TEXT, preview_ajuz TEXT, dedup_key TEXT NOT NULL UNIQUE, url TEXT);

CREATE TABLE baits (id INTEGER PRIMARY KEY, poem_id INTEGER NOT NULL REFERENCES poems(id), position INTEGER NOT NULL, sadr TEXT NOT NULL, ajuz TEXT,
  first_letter TEXT, rawiyy TEXT, last_letter TEXT, h_full INTEGER, h_sadr INTEGER, is_partial INTEGER NOT NULL DEFAULT 0);

CREATE VIRTUAL TABLE baits_fts USING fts5(norm, tokenize='unicode61');
CREATE VIRTUAL TABLE poems_fts USING fts5(norm_title, norm_poet, tokenize='unicode61');
CREATE VIRTUAL TABLE poets_fts USING fts5(norm_name, norm_desc, tokenize='unicode61');

CREATE TABLE game_baits (bait_id INTEGER PRIMARY KEY REFERENCES baits(id), first_letter TEXT NOT NULL, rawiyy TEXT NOT NULL, poem_id INTEGER NOT NULL,
  era_id INTEGER, meter_id INTEGER, fame INTEGER NOT NULL, position INTEGER NOT NULL, bucket INTEGER NOT NULL,
  rand INTEGER NOT NULL, opens_conj INTEGER NOT NULL DEFAULT 0);

CREATE TABLE combo_counts (first_letter TEXT NOT NULL, era_id INTEGER NOT NULL, meter_id INTEGER NOT NULL, tier TEXT NOT NULL,
  n INTEGER NOT NULL, PRIMARY KEY (first_letter, era_id, meter_id, tier)) WITHOUT ROWID;
`

/**
 * Every index in one place, created AFTER the bulk load: building a b-tree once
 * over sorted-ish data is several times cheaper than maintaining eleven of them
 * across 3.86M inserts.
 */
export const INDEXES = `
CREATE INDEX poets_letter ON poets(letter, sort_key);
CREATE INDEX poets_era ON poets(era_id, fame DESC, poem_count DESC);
CREATE INDEX poets_fame ON poets(fame DESC, poem_count DESC);

CREATE INDEX poems_poet ON poems(poet_id, id);
CREATE INDEX poems_filter ON poems(era_id, meter_id, theme_id, rhyme, id);
CREATE INDEX poems_meter ON poems(meter_id, bait_count, id);
CREATE INDEX poems_rhyme ON poems(rhyme, id);
CREATE INDEX poems_theme ON poems(theme_id, id);
CREATE INDEX poems_first ON poems(first_letter, id);

CREATE UNIQUE INDEX baits_poem_pos ON baits(poem_id, position);
CREATE INDEX baits_hfull ON baits(h_full);
CREATE INDEX baits_hsadr ON baits(h_sadr);

CREATE INDEX gb_pick ON game_baits(first_letter, fame, bucket);
CREATE INDEX gb_facet ON game_baits(first_letter, era_id, meter_id, bucket);
CREATE INDEX gb_rand ON game_baits(bucket, meter_id);
CREATE INDEX gb_chain ON game_baits(rawiyy, era_id, meter_id, first_letter, fame, bait_id);
CREATE INDEX gb_poem ON game_baits(poem_id);
CREATE INDEX gb_bias ON game_baits(first_letter, fame, opens_conj, bucket);
`

/* Two indexes §5 does not list, both measured on the 1.76M-row artefact:
 *
 * `gb_chain` — the روي side of بيت-mode browse. §5 indexes `first_letter` three
 *   ways and `rawiyy` none, so `/api/baits?rhyme=ر` (the قوافي door, and every
 *   «قافية راء» chip) had to SCAN the whole table: 107 ms for the list and
 *   144 ms once an عصر was added, against a 150 ms budget. Leading on `rawiyy`
 *   and carrying `era_id, meter_id` next makes every browse combination a
 *   prefix, and `fame, bait_id` at the tail makes the page's ORDER BY
 *   index-only. ≈45 MB.
 *
 * `gb_poem` — `/api/game/reply` with a شاعر filter joins `poems` on
 *   `gb.poem_id`, which had no index at all (p50 11 ms, p90 32 ms). It also
 *   gives SQLite a narrow b-tree for the unfiltered `COUNT(*)`. ≈20 MB.
 *
 * `gb_bias` — amendment 5's tail bias. `gb_pick` cannot see `opens_conj`, so
 *   the «فحل»/«سيف» passes («rare», then «no_conj») walked the WHOLE letter
 *   filtering it out. On و that is 474,345 rows of which 1,038 have
 *   `opens_conj = 0` and 26 are also on a rare روي: 78 ms per leg, ~150 ms per
 *   reply, against a 150 ms budget. With `opens_conj` in the index the pass
 *   reads the 1,038-row slice and stops. ≈32 MB.
 */

/**
 * Pass 1 writes the amendment-3 verdict and the amendment-4 sampling keys here;
 * Pass 2 joins it to build `game_baits` and then drops it, so the predicate
 * lives in exactly one place (`transform.ts`) and the shipped schema stays §5's.
 */
export const SCRATCH_DDL = `
CREATE TABLE _playable (bait_id INTEGER PRIMARY KEY, bucket INTEGER NOT NULL, rand INTEGER NOT NULL, opens_conj INTEGER NOT NULL);
`

/** The four difficulty tiers of design-server.md §8, as `combo_counts.tier`. */
export const TIER_PREDICATES: ReadonlyArray<readonly [tier: string, sql: string]> = [
  ["easy", "gb.fame = 3 AND gb.position <= 6"],
  // The position cap is what makes «شاعر» playable. `fame >= 2` alone admits
  // بيت 300 of a 500-بيت ديوان — a line nobody has ever quoted — and measured
  // play on the real corpus filled the tier with them. ≤ 12 keeps the مطلع and
  // the شاهد, still leaves 769,337 أبيات (44% of the pool) and never fewer than
  // 1,612 on the thinnest letter, ظ.
  ["normal", "gb.fame >= 2 AND gb.position <= 12"],
  ["hard", "gb.fame <= 2"],
  ["brutal", "1 = 1"],
]

/** `combo_counts` sentinels: 0 = "no era on this بيت", -1 = "any / unfiltered". */
export const COMBO_NONE = 0
export const COMBO_ANY = -1
