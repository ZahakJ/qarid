/**
 * Read-only view of `qarid:v1:training.arsenal` — the 28 letters you have
 * actually played, for the home screen's coverage ring («تغطية 21 من 28 حرفًا»,
 * design-ux.md §5).
 *
 * It reads the persisted slice rather than the training store because the
 * training store is Phase 4 and does not exist yet; the slice's SHAPE, on the
 * other hand, is already fixed in shared/schema.ts, so this reads correctly the
 * moment Phase 4 starts writing it and reads as an empty ترسانة until then.
 * `persist.loadSlice` backs up and discards anything that is not the right
 * shape, so a hand-edited payload cannot break the home screen.
 */
import { useEffect, useState } from "react"
import { TrainingSliceSchema, type Arsenal } from "../../shared/schema.ts"
import { HIJAI_LETTERS } from "../../shared/letters.ts"
import { loadSlice } from "../persist.ts"

export type ArsenalSummary = {
  arsenal: Arsenal
  /** letters with at least one played بيت */
  covered: number
  total: number
  /** 0..1 — what the ring fills to */
  ratio: number
}

const EMPTY: ArsenalSummary = { arsenal: {}, covered: 0, total: HIJAI_LETTERS.length, ratio: 0 }

export function summarizeArsenal(arsenal: Arsenal): ArsenalSummary {
  let covered = 0
  for (const letter of HIJAI_LETTERS) {
    const cell = arsenal[letter]
    if (cell && (cell.used > 0 || cell.mastered > 0)) covered++
  }
  const total: number = HIJAI_LETTERS.length
  return { arsenal, covered, total, ratio: total === 0 ? 0 : covered / total }
}

export function useArsenal(): ArsenalSummary {
  const [summary, setSummary] = useState<ArsenalSummary>(EMPTY)
  useEffect(() => {
    const slice = loadSlice("training", TrainingSliceSchema, TrainingSliceSchema.parse({}))
    setSummary(summarizeArsenal(slice.arsenal))
  }, [])
  return summary
}
