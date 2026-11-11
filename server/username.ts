/**
 * The one comparison key for usernames.
 *
 * `users.username` is `UNIQUE COLLATE NOCASE`, and SQLite's NOCASE folds ASCII
 * only — while JavaScript's `toLowerCase()` folds every script. Comparing names
 * one way in SQL and another way in code let two DIFFERENT accounts look like
 * one name: U+212A KELVIN SIGN is a letter that lowercases to ASCII «k», so
 * «zahaK» (Kelvin) was a separate account from «zahak» yet matched it in the
 * admin allowlist. Every name comparison now goes through this key, and the
 * key is stored (`users.username_key`, UNIQUE), so the database and the code
 * agree on what «the same name» means.
 *
 * NFKC first (it maps compatibility characters such as the Kelvin and Ångström
 * signs, full-width letters and ligatures to their ordinary forms), then
 * lowercase, then NFKC again because lowercasing can leave a sequence that is
 * not normalised (İ → i + combining dot).
 */
export function usernameKey(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase().normalize("NFKC")
}

/**
 * A new username must already be in NFKC form: «zahaK» with a Kelvin sign is
 * refused at registration rather than stored as a look-alike. Existing
 * accounts are never refused at login for this.
 */
export function isCanonicalUsername(name: string): boolean {
  return name === name.normalize("NFKC")
}
