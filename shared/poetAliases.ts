/**
 * أسماء الشعراء المكرّرة — the curated alias table the ingest folds away.
 *
 * The corpus is eight scraped hosts, and they do not agree on what a شاعر is
 * called. `poets.name_key` (= `normalizeArabic(name)`) is the identity, so
 * «المتنبي» and «أبو الطيب المتنبي» normalize APART and land as two rows: two
 * cards in الشعراء, two slugs, two fame verdicts, and the same مطلع showing up
 * twice in البحث under two names. That was CLAUDE.md's first backlog item.
 *
 * The fix is here rather than in a view for the reason the backlog gives: the
 * merge has to happen BEFORE `poems.poet_id` is handed out, so poems, أبيات,
 * `game_baits` and `combo_counts` all point at the canonical row. A view could
 * only hide the duplicate; ingest can actually add the two poem counts up.
 *
 * ── How this list was built ─────────────────────────────────────────────────
 * Candidates were DETECTED against the shipped artefact: every pair of poets
 * where one `name_key`'s tokens are a strict subset of the other's, the two
 * eras agree (or one is null), and the shorter name is a famous one. That query
 * returns 149 pairs; roughly two thirds of them are traps, and every one here
 * was then read by hand.
 *
 * ── What is deliberately NOT merged ─────────────────────────────────────────
 * A token-superset is evidence, never proof. These shapes are the same query's
 * output and all of them are DIFFERENT people:
 *   · kinship — «يحيى ابن البحتري», «مرهف بن أسامة بن منقذ», «عبد الرحمن بن
 *     حسان بن ثابت», «رؤبة بن العجاج», «خليل ناصيف اليازجي», «ابنة لبيد بن
 *     ربيعة العامري», «شكلة أم إبراهيم بن المهدي», «الجعفيّة امرأة عمرو بن معد
 *     يكرب». A son is a superset of his father and is not his father.
 *   · company — «المشوق الشامي صديق المتنبي», «الناجم راوية ابن الرومي»,
 *     «ابن عم صريع الغواني», «أميمة أم تأبط شراً».
 *   · a shared نسبة — «التهامي» carries four unrelated poets, «ابن الدهان»
 *     three, «الكوكباني» three; «الساعاتي» and «ابن الساعاتي» are two men, and
 *     «الأخطل» (أموي) is not «الأخطل الصغير» (حديث).
 * The task's own example, «متنبي المغرب», is exactly this: a superset of
 * «المتنبي» and a different شاعر. It is not in the map and must not be.
 *
 * When a pair is doubtful, the pair stays out. A wrong merge silently welds two
 * دواوين together and there is no view that can tell them apart afterwards; a
 * missed merge leaves the corpus exactly as it already is.
 */

import { normalizeArabic } from "./arabic.ts"

/**
 * `[alias display name, canonical display name]`, written in the corpus's own
 * spelling so the pairs are readable and so `poetAliases.test.ts` can check
 * both halves against the real `poet name` values.
 *
 * The canonical is the row a reader would look under and, where the sources
 * gave one, the row that owns the better slug — «المتنبي» is `mutanabi`, while
 * «أبو الطيب المتنبي» only ever had the fallback slug built from its own name.
 */
export const POET_ALIAS_PAIRS: readonly (readonly [string, string])[] = [
  // ── كُنية ↔ شهرة: the same man under his kunya and under his by-name ──────
  ["أبو الطيب المتنبي", "المتنبي"],
  ["أبو بكر الصنوبري", "الصنوبري"],
  ["أبو حامد الغزالي", "الغزالي"],
  ["أبو الفضل الميكالي", "الميكالي"],
  ["أبو الحسن التهامي", "التهامي"],
  ["الإمام علي بن أبي طالب", "علي بن أبي طالب"],
  ["الأمير شكيب أرسلان", "شكيب أرسلان"],

  // ── نسب كامل ↔ شهرة: full nasab against the name the ديوان is filed under ──
  ["الكميت بن زيد الأسدي", "الكميت بن زيد"],
  ["لَبيد بن ربيعة العامِري", "لبيد بن ربيعة"],
  ["الطرماح بن حكيم الطائي", "الطرماح"],
  ["الشماخ بن ضرار الذبياني", "الشماخ الذبياني"],
  ["الأسود بن يعفر النهشلي", "الأسود النهشلي"],
  ["عدي بن الرقاع العاملي", "عدي بن الرقاع"],
  ["عدي بن ربيعة المهلهل", "عدي بن ربيعة"],
  ["عدي بن ربيعة التغلبي", "عدي بن ربيعة"],
  ["عمرو بن أحمر الباهلي", "عمرو الباهلي"],
  ["الحسين ابن حجاج", "ابن حجاج"],
  ["الحسين بن الضَحّاك الباهلي", "الحسين بن الضحّاك"],
  ["ابن سنان عبد الله الخفاجي", "ابن سنان الخفاجي"],
  ["عبد الصمد بن المعذل العبدي", "عبد الصمد بن المعذل"],
  ["يحيى بن يوسف الصَرصَري", "الصرصري"],
  ["يحيى بن الحكم الغزال", "يحيى الغزال"],
  ["عبد الرحيم البرعي", "البرعي"],
  ["إبراهيم بن قيس الحضرمي", "إبراهيم الحضرمي"],
  ["إبراهيم بن عبد القادر الرِّيَاحي", "إبراهيم الرياحي"],
  ["حيدر بن سليمان الحلي", "حيدر الحلي"],
  ["راشد بن خميس الحبسي", "الحبسي"],
  ["محمود صفوت الساعاتي", "الساعاتي"],
  ["شرف الدين البوصيري", "البوصيري"],
  ["شهاب الدين الشيباني التلعفري", "شهاب الدين التلعفري"],
  ["المؤيد في الدين الفاطمي داعي الدعاة", "المؤيد في الدين"],

  // ── نسبة زائدة: the same man with one more نسبة or بلد on the end ─────────
  ["ابن رشيق القيرواني الأزدي", "ابن رشيق القيرواني"],
  ["ابن الزقاق البلنسي", "ابن الزقاق"],
  ["ابن معتوق الموسوي", "ابن معتوق"],
  ["ابن معصوم المدني", "ابن معصوم"],
  ["ابن معصوم الحسني الحسيني", "ابن معصوم"],
  ["ابن الجَنّان الشاطبي", "ابن الجنان"],
  ["ديكِ الجِنِّ الحِمصي", "ديك الجن"],
  ["جعفر الحلي النجفي", "جعفر الحلي"],
  ["أمين الجندي الحمصي", "أمين الجندي"],
  ["مالك بن المرحل السبتي", "مالك بن المُرحَّل"],
  ["يعقوب الحاج جعفر التبريزي", "يعقوب الحاج جعفر"],
  ["عبد الباقي العمري الفاروقي", "عبد الباقي العمري"],
  ["إسماعيل صبري المصري", "إسماعيل صبري"],
  ["إسماعيل صبري باشا", "إسماعيل صبري"],

  // ── الشهرة والاسم: the pen name and the name on the birth certificate ─────
  ["الأخطل الصغير بشارة الخوري", "الأخطل الصغير"],
  ["بشارة الخوري", "الأخطل الصغير"],
  ["مصطفى وهبي التل", "مصطفى التل"],
  ["مصطفى التل عرار", "مصطفى التل"],
  ["مصطفى لطفي المنفلوطي", "المنفلوطي"],
  ["توفيق أمين زيّاد", "توفيق زياد"],
  ["تميم مريد البرغوثي", "تميم البرغوثي"],
  ["محمد عواض الثبيتي", "محمد الثبيتي"],
  ["عبد الناصر أحمد الجوهري", "عبد الناصر الجوهري"],
  ["محمد الشاذلي خزنة دار", "الشاذلي خزنه دار"],
  ["دكتور المعز عمر بخيت", "المعز عمر بخيت"],
]

/**
 * `alias name_key → canonical name_key` — the form `transform.ts` looks up.
 *
 * Both halves are `normalizeArabic`d here for the same reason
 * `FAMOUS_POET_KEYS` is: the display spellings above are the corpus's, and
 * nothing downstream should re-normalise a key it was handed.
 */
export const POET_ALIASES: ReadonlyMap<string, string> = new Map(
  POET_ALIAS_PAIRS.map(([alias, canonical]) => [normalizeArabic(alias), normalizeArabic(canonical)]),
)

/**
 * `canonical name_key → canonical DISPLAY name` — the spelling the card reads.
 *
 * Needed for the case where the corpus carries a شاعر ONLY under an alias:
 * `build.ts` normally lets the first canonically-spelled row supply the display
 * name, letter and sort key, and when no such row exists this is where they
 * come from instead. Without it a poet row would read «بشارة الخوري» over
 * `name_key = 'الاخطل الصغير'` — the merge done, but wearing the wrong name.
 */
export const CANONICAL_POET_NAMES: ReadonlyMap<string, string> = new Map(
  POET_ALIAS_PAIRS.map(([, canonical]) => [normalizeArabic(canonical), canonical] as const),
)

/** The display spelling for a canonical key, or `null` if it is not one. */
export function canonicalDisplayName(nameKey: string): string | null {
  return CANONICAL_POET_NAMES.get(nameKey) ?? null
}

/** How many شاعر rows the merge removes — reported by `npm run ingest`. */
export const POET_ALIAS_COUNT = POET_ALIASES.size

/**
 * The identity a شاعر is stored under. Applied ONCE, in `transformPoem` (and in
 * `dedupKeyOfRaw`, which must agree with it), before `poems.poet_id` exists.
 *
 * Deliberately NOT transitive: a chain (a→b, b→c) would make the result depend
 * on iteration order, so `poetAliases.test.ts` asserts no canonical name is
 * itself an alias and this function resolves exactly one hop.
 */
export function canonicalNameKey(nameKey: string): string {
  return POET_ALIASES.get(nameKey) ?? nameKey
}

/** Is this `name_key` one the ingest folds into another row? */
export function isPoetAlias(nameKey: string): boolean {
  return POET_ALIASES.has(nameKey)
}
