/**
 * The pieces every list view of قريض shares: how a قصيدة is titled, whether its
 * قافية may be claimed, and the two row shapes — PoemRow and PoetCard.
 *
 * Both rows are FIXED height on purpose: the poets index, a poet's ديوان and
 * the browse results are windowed (design-ux.md §6), and `useWindowedList` is a
 * pure function of a row height. The numbers here and the `--row-*` custom
 * properties in client/styles/views.css are the same contract written twice;
 * change one and the other must follow.
 */
import type { BaitDto, MetaResponse, PoemSummary, PoetSummary } from "../../shared/schema.ts"
import { formatBaits, formatCount, formatPoems } from "../../shared/format.ts"
import { BaytPlate, type BaytSize } from "../bayt/BaytPlate.tsx"
import { Chip } from "../components/Chip.tsx"
import { routeHash } from "../router.ts"

/** «بلا عنوان» is what the ingest writes when the source had no title. */
export const UNTITLED = "بلا عنوان"

/** Row heights in px — desktop / ≤860px. Mirrored in views.css. */
export const ROW_POEM = 84
export const ROW_POEM_NARROW = 100
export const ROW_POET = 156
export const ROW_POET_NARROW = 176

export type Heading = { text: string; isMatla: boolean }

/**
 * The heading of a قصيدة: a real عنوان, or its مطلع standing in for one. Titles
 * are missing across most of the corpus, so this is the common path, not the
 * fallback — which is why an untitled قصيدة is set in the verse face and marked
 * with an ellipsis rather than apologised for.
 */
export function headingOf(poem: Pick<PoemSummary, "title" | "previewSadr">): Heading {
  const title = poem.title.trim()
  if (title && title !== UNTITLED) return { text: title, isMatla: false }
  const matla = poem.previewSadr?.trim()
  if (matla) return { text: `${matla} …`, isMatla: true }
  return { text: UNTITLED, isMatla: false }
}

/**
 * The غرض a row may display, as one string — or null.
 *
 * `قصيدة قصيره` and `قصيدة عامه` are BUCKETS, not أغراض (amendments.md §11):
 * they are two ways the source said "uncategorised", they carry a quarter of
 * the corpus between them, and a chip claiming a قصيدة's غرض is «عامه» tells
 * the reader nothing while looking like it told them something. They stay
 * reachable by URL and countable in the إحصاءات; they never become a chip.
 */
export function themeLabel(
  meta: Pick<MetaResponse, "themes"> | null,
  theme: PoemSummary["theme"],
): string | null {
  if (!theme) return null
  const info = meta?.themes.find((t) => t.slug === theme.slug)
  if (info?.kind === "bucket") return null
  return info?.display ?? theme.display
}

/**
 * The قافية chip is a claim about the WHOLE قصيدة, so it is only made when the
 * قصيدة keeps it: `rhymeShare` below 0.6 is a مقطوعة with a mixed tail and the
 * chip would be a lie (poems.rhyme_share, shared/schema.ts).
 */
export function showsRhyme(poem: Pick<PoemSummary, "rhyme" | "rhymeShare">): boolean {
  if (!poem.rhyme) return false
  return poem.rhymeShare === null || poem.rhymeShare >= 0.6
}

/**
 * One قصيدة in a list. Two lines: the عنوان (or مطلع), then the شاعر and the
 * badges. The whole row is the link — a row where only the title is clickable
 * makes the reader aim.
 */
export function PoemRow({
  poem,
  showPoet = true,
  theme,
}: {
  poem: PoemSummary
  showPoet?: boolean
  /** display form of the غرض, resolved through /api/meta; a bucket passes null */
  theme?: string | null
}) {
  const h = headingOf(poem)
  return (
    <a className="prow" href={routeHash({ view: "poem", id: poem.id })}>
      <span className={h.isMatla ? "prow__title prow__title--matla" : "prow__title"}>
        <bdi>{h.text}</bdi>
      </span>
      <span className="prow__meta">
        {showPoet ? (
          <span className="prow__poet">
            <bdi>{poem.poet.name}</bdi>
          </span>
        ) : null}
        {poem.meter ? <Chip variant="bahr" slug={poem.meter.slug} label={poem.meter.name} /> : null}
        {theme ? <Chip variant="gharad" label={theme} /> : null}
        {showsRhyme(poem) && poem.rhyme ? <Chip variant="rawiyy" label={poem.rhyme} title={`القافية: ${poem.rhyme}`} /> : null}
        <span className="prow__n">{formatBaits(poem.baitCount)}</span>
      </span>
    </a>
  )
}

/**
 * One شاعر in the index grid: name, عصر, ديوان size, and a two-line ترجمة.
 *
 * Every card renders all three rows even when the corpus has neither an عصر
 * (`era` is null for 107,209 rows) nor a ترجمة (only 791 شعراء carry one), so
 * the grid's fixed-height cells hold the same shape whatever the source knew.
 * The عصر slot falls back to the ديوان's size, which is always true.
 */
export function PoetCard({ poet }: { poet: PoetSummary }) {
  return (
    <a className="pcard" href={routeHash({ view: "poet", slug: poet.slug })}>
      <span className="pcard__name">
        <bdi>{poet.name}</bdi>
      </span>
      <span className="pcard__meta">
        {poet.era ? <Chip variant="asr" label={poet.era.name} /> : null}
        <span className="pcard__n">{formatPoems(poet.poemCount)}</span>
      </span>
      {poet.description ? (
        <span className="pcard__bio">{poet.description}</span>
      ) : (
        <span className="pcard__bio pcard__bio--none">{formatBaits(poet.baitCount)} في الديوان</span>
      )}
    </a>
  )
}

/**
 * «المزيد» + the autoload sentinel. The button is always rendered next to the
 * sentinel: an IntersectionObserver a browser extension has switched off must
 * not be the only way to reach page two.
 */
export function MoreBar({
  onMore,
  loading,
  remaining,
  sentinelRef,
  noun = "قصيدة",
}: {
  onMore: () => void
  loading: boolean
  remaining: number
  sentinelRef: React.RefObject<HTMLDivElement | null>
  noun?: string
}) {
  return (
    <div className="more-bar" ref={sentinelRef}>
      {loading ? (
        <span className="more-bar__busy">…يُجلب المزيد</span>
      ) : (
        <button type="button" className="btn" onClick={onMore}>
          المزيد — بقي {formatCount(remaining)} {noun}
        </button>
      )}
    </div>
  )
}

/** A short row of skeleton bars sized like the list it stands in for. */
export function RowSkeleton({ rows = 6, height = ROW_POEM }: { rows?: number; height?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="row-skeleton" key={i} style={{ blockSize: `${height}px` }}>
          <span className="skeleton" style={{ inlineSize: `${52 + ((i * 13) % 30)}%`, blockSize: "1.1rem" }} />
          <span className="skeleton" style={{ inlineSize: `${26 + ((i * 7) % 18)}%`, blockSize: "0.8rem" }} />
        </div>
      ))}
    </div>
  )
}

/**
 * A بيت standing on its own in a LIST — a search hit, or a بيت-mode browse
 * row. `BaytPlate` is still the only renderer; what this adds is the line of
 * provenance underneath, because a بيت pulled out of its قصيدة with no شاعر
 * against it is a fortune cookie.
 *
 * `variant="row"` ignores `meta` (that slot belongs to the framed plate), which
 * is exactly why the context line lives here and not in a prop.
 */
export function BaytCard({
  bait,
  size,
  tashkeel,
  showRawiyy,
  highlight,
  favorite,
  onFavorite,
  onCopied,
}: {
  bait: BaitDto
  size: BaytSize
  tashkeel: boolean
  showRawiyy: boolean
  /** »« terms already extracted from a search snippet */
  highlight?: readonly string[] | null
  favorite?: boolean
  onFavorite?: () => void
  onCopied?: (text: string) => void
}) {
  const poemHref = routeHash({ view: "poem", id: bait.poem.id, bayt: bait.position })
  const heading = headingOf({ title: bait.poem.title, previewSadr: null })
  const title = heading.text === UNTITLED ? null : heading.text
  return (
    <article className="bcard">
      <BaytPlate
        variant="row"
        size={size}
        sadr={bait.sadr}
        ajuz={bait.ajuz}
        rawiyy={bait.rawiyy}
        number={bait.position}
        tashkeel={tashkeel}
        showRawiyy={showRawiyy}
        highlight={highlight}
        label={`بيت ${bait.poet.name}`}
        favorite={favorite}
        onFavorite={onFavorite}
        onCopied={onCopied}
        duelHref={routeHash({ view: "duel" })}
      />
      <div className="bcard__meta">
        <a className="bcard__poet" href={routeHash({ view: "poet", slug: bait.poet.slug })}>
          <bdi>{bait.poet.name}</bdi>
        </a>
        {bait.meter ? <Chip variant="bahr" slug={bait.meter.slug} label={bait.meter.name} /> : null}
        {bait.era ? <Chip variant="asr" label={bait.era.name} /> : null}
        {/* Most قصائد are untitled, and printing «بلا عنوان» after every بيت
            says nothing four times a screen — the «القصيدة ←» link already
            says where the line came from. */}
        {/* the شاعر and the عنوان used to run together into one phrase —
            «محمود درويش أيقونات من بلور المكان» — at the same size and colour.
            A middot, and one step down in colour, separates them for nothing. */}
        {title ? (
          <>
            <span className="bcard__dot" aria-hidden="true">
              ·
            </span>
            <a className="bcard__poem" href={poemHref}>
              <bdi>{title}</bdi>
            </a>
          </>
        ) : null}
        <a className="bcard__go" href={poemHref}>
          القصيدة ←
        </a>
      </div>
    </article>
  )
}
