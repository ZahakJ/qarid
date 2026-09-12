/**
 * The three states of «من يرى هذا الديوان», written once.
 *
 * Three surfaces say it — the badge on a card, the owner's radio row on the
 * shelf page, and the picker's row — and a visibility whose words differ
 * between them is a visibility the reader has to re-learn on each screen.
 *
 * The wording carries the actual rule, not a euphemism. «بالرابط» is the honest
 * name for unlisted: the CODE is the capability here, there is no second secret
 * and no knock (server/routes/albums.ts), so whoever has the link is in. Saying
 * «خاص» about it would be a promise the design does not make.
 */
import type { AlbumVisibility } from "../../shared/schema.ts"

export type VisibilityCopy = { label: string; note: string }

export const VISIBILITY: Record<AlbumVisibility, VisibilityCopy> = {
  private: { label: "لك وحدك", note: "لا يراه أحد سواك" },
  unlisted: { label: "بالرابط", note: "يفتحه من تُعطيه الرابط، ولا يُعرض في مكان" },
  // «مفتوح» is the PUBLISH state and the wording says the part that is easy to
  // miss: it does not merely open the link, it puts the ديوان on the curator's
  // own page for anyone who visits it.
  public: { label: "مفتوح", note: "يُعرض في صفحتك، ويفتحه كل من وصله رابطه" },
}

/** The order the owner's control offers them: the closed door first. */
export const VISIBILITY_ORDER: readonly AlbumVisibility[] = ["private", "unlisted", "public"]
