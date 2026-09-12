/**
 * Where a restored قصيدة goes back to.
 *
 * «أعِد القصيدة كاملة» adds the أبيات a curator had removed, and the add
 * endpoint appends: the شعر comes back, but scattered — the two survivors at
 * rows 3 and 4, the nine restored ones at the end of a shelf that may hold
 * twenty other قصائد. That is not the قصيدة restored, it is its pieces returned.
 *
 * So the block is re-seated: the قصيدة's أبيات are gathered in the قصيدة's OWN
 * order and put back at the place its earliest بيت already occupied, and every
 * other row keeps its arrangement and its relative order. The curator loses
 * nothing he arranged; he gets back the one قصيدة he asked for, whole and in
 * sequence, where it already sat.
 *
 * Pure, and separate from the view, because the shelf's order is the one thing
 * in a ديوان the reader made by hand — it is worth a test that says so.
 */

/**
 * @param order the shelf's anchors, in its current order (already including
 *              whatever the add appended)
 * @param group that قصيدة's anchors, in the قصيدة's order — anything not
 *              actually on the shelf is ignored rather than invented
 */
export function regroupPoem(order: readonly string[], group: readonly string[]): string[] {
  const onShelf = new Set(order)
  const block = group.filter((a) => onShelf.has(a))
  if (block.length === 0) return [...order]

  const inBlock = new Set(block)
  const rest = order.filter((a) => !inBlock.has(a))

  // The seat is the قصيدة's earliest بيت, counted among the rows that are NOT
  // the قصيدة's — those are the rows the block is being inserted between, and
  // an index into `order` would be wrong by however many of its own rows came
  // before it.
  let seat = rest.length
  let passed = 0
  for (const anchor of order) {
    if (inBlock.has(anchor)) {
      seat = passed
      break
    }
    passed += 1
  }

  return [...rest.slice(0, seat), ...block, ...rest.slice(seat)]
}

/** Whether re-seating would actually change anything worth a request. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}


/**
 * The anchors one قصيدة holds on a shelf, in the SHELF's order.
 *
 * Both قصيدة-level acts are built on this, and both are destructive in one
 * direction or the other, so the rule they share is worth stating once: a
 * قصيدة is identified by `bait.poem.id` and nothing else. An entry whose بيت
 * the artefact no longer resolves (`bait === null`) belongs to no قصيدة this
 * function can name, and is therefore never swept up by an act aimed at one.
 */
export function poemAnchors(
  entries: readonly { hFull: string; bait?: { poem: { id: string } } | null }[],
  poemId: string,
): string[] {
  return entries.filter((e) => e.bait?.poem.id === poemId).map((e) => e.hFull)
}
