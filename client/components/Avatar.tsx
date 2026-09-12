/**
 * The one place the avatar fallback lives (owner's request — profile pictures).
 *
 * A user either has an uploaded picture — a versioned URL the server hands us on
 * the AuthUser / RoomPlayer DTO — or they do not, and then the app draws the
 * gold نِيب disc with their initial, exactly as it always has. This component
 * holds THAT decision, and the one graceful degradation that matters: if the
 * image URL 404s or fails to load (a picture deleted between the DTO and the
 * `<img>`, an offline tab), it silently falls back to the initial rather than
 * showing a broken-image glyph.
 *
 * It renders NO chrome of its own — no wrapper. The caller's own disc element
 * (`masthead__disc`, `profile-hero__disc`, `seat__disc`) is the ring and the
 * sizing; this drops either an `<img class="avatar__img">` that fills it or the
 * fallback initial into it. So every site keeps its exact ring, and the seal and
 * any other ornament stay siblings on the caller's side.
 */
import { useEffect, useState } from "react"

import { resolveApiUrl } from "../platform/native.ts"
import { initialOf } from "../store/authStore.ts"

export function Avatar({
  name,
  src,
  initialClassName,
}: {
  /** the display name — its first glyph is the fallback */
  name: string
  /** the versioned avatar URL, or null/undefined → the نِيب fallback */
  src: string | null | undefined
  /** the class for the initial glyph in the fallback state */
  initialClassName?: string
}) {
  const [failed, setFailed] = useState(false)
  // A new picture (new `?v=` URL) is a fresh attempt — clear a prior failure.
  useEffect(() => setFailed(false), [src])

  if (src && !failed) {
    return (
      <img
        className="avatar__img"
        // `resolveApiUrl` prefixes the deployment origin in the native shell
        // and is a no-op on the web — the same rule every API call follows.
        src={resolveApiUrl(src)}
        alt=""
        onError={() => setFailed(true)}
        loading="lazy"
        decoding="async"
      />
    )
  }
  return <span className={initialClassName}>{initialOf(name)}</span>
}
