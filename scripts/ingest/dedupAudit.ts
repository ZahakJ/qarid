/**
 * dedupAudit — what changing the dedup rank does to the artefact, BEFORE a
 * 162-second re-ingest is spent finding out.
 *
 * It runs `build.ts` pass 0's grouping over the raw sources twice: once with
 * the OLD single-number rank (kept below, verbatim, as the only copy left in
 * the tree) and once with `transform.ts`'s `pickDedupWinner`, and reports how
 * many groups change winner, how much text the artefact gains or loses, how
 * many flips gain a named بحر (i.e. gain playability), and — the number that
 * gates the change — how many flips SHRINK a قصيدة, worst first, with enough
 * of each one printed to read it.
 *
 *   node scripts/ingest/dedupAudit.ts data/raw/*.parquet [--ratio 3] [--floor 240]
 *
 * ~3 s per scan; two scans, the second only for the groups it prints.
 */
import { readRecords, type RawPoem } from "./readers.ts"
import { dedupCandidateOf, dedupKeyOfRaw, pickDedupWinner, type DedupCandidate } from "./transform.ts"

/**
 * The rank this change replaces, exactly as it stood: hemistichs, then
 * tashkeel (a boolean on the مطلع), then ANY non-empty metre string, then
 * aldiwan.net — packed into one comparable number, highest wins, ties keep the
 * first row. It lives here so the audit can measure the delta, and nowhere
 * else.
 */
function oldRank(raw: RawPoem): number {
  const tashkeel = /[ً-ْٰ]/.test(raw.verses[0] ?? "") ? 4 : 0
  const meter = (raw.meter ?? "").trim() !== "" ? 2 : 0
  const aldiwan = (raw.poemUrl ?? "").includes("aldiwan.net") ? 1 : 0
  return raw.verses.length * 8 + tashkeel + meter + aldiwan
}

interface Row {
  at: number
  old: number
  cand: DedupCandidate
}

function fmt(n: number): string {
  return n.toLocaleString("en")
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const sources: string[] = []
  let ratio = 3
  let floor = 240
  let share = 0.5
  let print = 15
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--ratio") ratio = Number(argv[++i])
    else if (a === "--floor") floor = Number(argv[++i])
    else if (a === "--share") share = Number(argv[++i])
    else if (a === "--print") print = Number(argv[++i])
    else sources.push(a)
  }
  if (sources.length === 0) {
    console.error("usage: node scripts/ingest/dedupAudit.ts data/raw/*.parquet [--ratio N] [--floor N] [--print N]")
    process.exit(2)
  }
  console.log(`thresholds: ratio ${ratio}× · floor ${floor} hemistichs · rhyme share < ${share}`)

  const groups = new Map<string, Row[]>()
  let ordinal = -1
  const t0 = Date.now()
  for (const src of sources) {
    for await (const raw of readRecords(src)) {
      ordinal++
      const key = dedupKeyOfRaw(raw)
      if (key === null) continue
      const row: Row = { at: ordinal, old: oldRank(raw), cand: dedupCandidateOf(raw, ordinal) }
      const held = groups.get(key)
      if (held === undefined) groups.set(key, [row])
      else held.push(row)
    }
  }
  console.log(
    `scanned ${fmt(ordinal + 1)} rows → ${fmt(groups.size)} distinct قصائد in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  )

  let multi = 0
  let flips = 0
  let hemiDelta = 0
  let gainBahr = 0
  let loseBahr = 0
  let suspectsDemoted = 0
  const shrinks: { key: string; oldAt: number; newAt: number; oldN: number; newN: number; drop: number }[] = []

  for (const [key, rows] of groups) {
    if (rows.length === 1) continue
    multi++
    // OLD: highest packed rank, ties keep the first row.
    let oldWin = rows[0]!
    for (const r of rows) if (r.old > oldWin.old) oldWin = r
    const newAt = pickDedupWinner(
      rows.map((r) => r.cand),
      { ratio, floor, rhymeShare: share },
    )
    if (newAt === oldWin.at) continue
    const newWin = rows.find((r) => r.at === newAt)!
    flips++
    hemiDelta += newWin.cand.hemistichs - oldWin.cand.hemistichs
    if (newWin.cand.bahr && !oldWin.cand.bahr) gainBahr++
    if (!newWin.cand.bahr && oldWin.cand.bahr) loseBahr++
    // Was the old winner demoted BECAUSE it is a compilation suspect?
    let labelled = -1
    for (const r of rows) if (r.cand.bahr && r.cand.hemistichs > labelled) labelled = r.cand.hemistichs
    if (
      !oldWin.cand.bahr &&
      labelled >= 0 &&
      oldWin.cand.hemistichs > ratio * labelled &&
      oldWin.cand.hemistichs > floor &&
      oldWin.cand.rhymeShare < share
    ) {
      suspectsDemoted++
    }
    const drop = 1 - newWin.cand.hemistichs / oldWin.cand.hemistichs
    if (drop > 0.3) {
      shrinks.push({
        key,
        oldAt: oldWin.at,
        newAt: newWin.at,
        oldN: oldWin.cand.hemistichs,
        newN: newWin.cand.hemistichs,
        drop,
      })
    }
  }

  console.log("")
  console.log(`groups with >1 copy      ${fmt(multi)}`)
  console.log(`winner FLIPS             ${fmt(flips)}`)
  console.log(`hemistich delta          ${hemiDelta > 0 ? "+" : ""}${fmt(hemiDelta)} (≈ ${fmt(Math.round(hemiDelta / 2))} أبيات)`)
  console.log(`flips GAINING a بحر      ${fmt(gainBahr)}  (→ playable)`)
  console.log(`flips LOSING a بحر       ${fmt(loseBahr)}`)
  console.log(`old winners demoted as compilation suspects  ${fmt(suspectsDemoted)}`)
  console.log(`flips shrinking >30%     ${fmt(shrinks.length)}`)

  shrinks.sort((a, b) => b.oldN - b.newN - (a.oldN - a.newN))
  const worst = shrinks.slice(0, print)
  if (worst.length > 0) {
    const wanted = new Map<number, { key: string; role: "old" | "new" }>()
    for (const s of worst) {
      wanted.set(s.oldAt, { key: s.key, role: "old" })
      wanted.set(s.newAt, { key: s.key, role: "new" })
    }
    const seen = new Map<string, { old?: RawPoem; new?: RawPoem }>()
    let o = -1
    for (const src of sources) {
      for await (const raw of readRecords(src)) {
        o++
        const w = wanted.get(o)
        if (w === undefined) continue
        const slot = seen.get(w.key) ?? {}
        slot[w.role] = raw
        seen.set(w.key, slot)
      }
    }
    console.log("")
    console.log(`── the ${worst.length} biggest shrinks ──────────────────────────────────`)
    for (const s of worst) {
      const pair = seen.get(s.key)!
      console.log("")
      console.log(`${s.oldN} → ${s.newN} hemistichs  (−${Math.round(s.drop * 100)}%)   key: ${s.key.slice(0, 70)}`)
      for (const role of ["old", "new"] as const) {
        const r = pair[role]
        if (r === undefined) continue
        console.log(
          `  ${role.toUpperCase().padEnd(3)} «${(r.title ?? "").trim().slice(0, 40)}» meter=${(r.meter ?? "∅").trim()} ` +
            `verses=${r.verses.length} rhymeShare=${dedupCandidateOf(r, 0).rhymeShare.toFixed(2)} ` +
            `${(r.poemUrl ?? "∅").replace(/^https?:\/\/(www\.)?/, "")}`,
        )
        console.log(`      ${(r.verses[0] ?? "").trim()} / ${(r.verses[1] ?? "").trim()}`)
        const tail = r.verses.length - 2
        if (tail > 0) console.log(`      … ${tail} more: ${(r.verses.at(-2) ?? "").trim()} / ${(r.verses.at(-1) ?? "").trim()}`)
      }
    }
  }
}

await main()
