/**
 * Deterministic, seedable PRNG (sfc32) — copied verbatim from daedalus, which
 * is the point: two projects that need the same بيت on the same day must not
 * be running two subtly different mixers.
 *
 * `Math.random` is banned anywhere the result has to be reproducible. The daily
 * chain (`rngFrom(`daily:${YYYY-MM-DD}`)`, design-ux.md §5), the seeded browse
 * sort, the duel session seed and the opponent's reply all draw from here, so a
 * rebuild of `data/qarid.db` and a reload of the page both hand the reader the
 * same poem — the whole «تحدّي اليوم» share mechanic depends on it.
 */


export type Rng = () => number;

/** Hash a string to four 32-bit seeds (MurmurHash3-style finalizer mix). */
export function hashSeed(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** sfc32: fast, high-quality 32-bit PRNG. Returns uniform [0, 1). */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Seeded RNG from any string. */
export function rngFrom(seed: string): Rng {
  const [a, b, c, d] = hashSeed(seed);
  return sfc32(a, b, c, d);
}

/** Standard normal via Box-Muller. */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Exponentially distributed sample with the given rate (mean 1/rate). */
export function expovariate(rng: Rng, rate: number): number {
  let u = 0;
  while (u === 0) u = rng();
  return -Math.log(u) / rate;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from empty array');
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!;
}

/** Uniform in [min, max). */
export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Fisher–Yates, non-mutating. Same seed → same order, every time. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

/** Uniform integer in [min, max], inclusive. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
