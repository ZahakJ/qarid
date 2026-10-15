/**
 * Seat secrets and invite keys for the account-less مساجلة.
 *
 * Both are drawn from `randomBytes` over a 32-symbol alphabet (a byte mod 32 is
 * exact, so there is no bias), handed to the client once, and stored only as a
 * SHA-256 hex digest. A database dump therefore holds nothing a player could
 * present. Comparison is of the digests, in constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { MATCH_KEY_LENGTH, MATCH_SECRET_ALPHABET, MATCH_SECRET_LENGTH } from "../../shared/match.ts"

function draw(length: number): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += MATCH_SECRET_ALPHABET[bytes[i]! % MATCH_SECRET_ALPHABET.length]
  return out
}

/** A seat: 130 bits. */
export function newSeatSecret(): string {
  return draw(MATCH_SECRET_LENGTH)
}

/** The invite in the share link: 120 bits. */
export function newJoinKey(): string {
  return draw(MATCH_KEY_LENGTH)
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

/** Constant-time digest equality. A null on either side matches nothing. */
export function hashesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

/** Hash what a client offered and compare it to the stored digest. */
export function secretMatches(storedHash: string | null | undefined, offered: string | null | undefined): boolean {
  if (!storedHash || !offered || offered.length > 128) return false
  return hashesEqual(storedHash, hashSecret(offered))
}
