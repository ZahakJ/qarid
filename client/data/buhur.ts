/**
 * The sixteen بحور of الخليل بن أحمد — static, no API call. Feeds the بحر chip
 * popover on the poem page (design-ux.md §3 Poem), the tafʿila glyph on the
 * chip itself, and صفحة البحور (`#/buhur`, client/views/BuhurView.tsx).
 *
 * `slug` matches shared/meters.ts (design-server.md §3) so a chip can link
 * straight into #/browse?meter=<slug>. `sort` is the classical circle order,
 * not corpus frequency.
 *
 * What صفحة البحور added to this table is `daira` — الدائرة العروضية the بحر
 * belongs to. It is not decoration: الخليل did not list sixteen metres, he drew
 * five circles and read the metres off them, and a page that teaches البحور as
 * a flat list of sixteen throws away the only structure that explains why
 * الطويل and المديد are relatives. The corpus knows nothing about any of this —
 * `meters` carries a slug, a name and تفعيلات — so it lives here, in the
 * bundle, beside the مفتاح it belongs with.
 */
export type Bahr = {
  slug: string
  /** display name, with the definite article as the corpus writes it */
  name: string
  /** التفعيلات of one full بيت, in reading order */
  tafilat: string[]
  /** the مفتاح: the mnemonic hemistich that scans as the meter itself */
  miftah: string
  /**
   * The مفتاح's OWN scansion, i.e. what the mnemonic line actually maps onto —
   * which is not always `tafilat`, and deliberately so.
   *
   * Two of the sixteen differ from the canonical feet above, and both are right:
   * المنسرح's مفتاح ends «مفتعلن», a زحاف of مستفعلن, and المجتث's مفتاح is
   * genuinely two feet where the بحر is three. That is prosody, not a typo.
   *
   * **Nothing renders this field today** (BuhurView prints `tafilat` as cells and
   * `miftah` as a line; the قصيدة page's popover prints the same two), and
   * putting it on screen BESIDE `tafilat` uncommented is what would read as a
   * data error on the one page this app must be unimpeachable. A renderer that
   * shows both must carry the caveat with it:
   *
   *     «ومفتاح البحر قد يجري على زحافٍ من زحافاته.»
   */
  miftahTafilat: string
  /** which of الخليل's five دوائر this بحر is read off */
  daira: DairaSlug
  /**
   * One clause the reader would otherwise have to be told by a teacher. Only
   * المتدارك carries one so far, and it carries it because the page would
   * otherwise attribute to الخليل a بحر he did not name.
   */
  note?: string
  sort: number
}

export type DairaSlug = "mukhtalif" | "mutalif" | "mujtalab" | "mushtabih" | "muttafiq"

export type Daira = {
  slug: DairaSlug
  /** the دائرة's name, as العروضيون write it */
  name: string
  /** why it carries that name — one clause, and the reason is always the أجزاء */
  why: string
  sort: number
}

/**
 * الدوائر الخمس, in الخليل's own order.
 *
 * Every `why` says the same kind of thing because the names all mean the same
 * kind of thing: a دائرة is named for how its أجزاء sit together — whether they
 * differ, agree, are drawn from elsewhere, or resemble one another. Saying that
 * once per circle is what turns five headings into an explanation.
 */
export const DAWAIR: Daira[] = [
  {
    slug: "mukhtalif",
    name: "دائرة المختلِف",
    why: "سُمِّيت بذلك لاختلاف أجزائها: خماسيٌّ يتلوه سباعيّ.",
    sort: 1,
  },
  {
    slug: "mutalif",
    name: "دائرة المؤتلِف",
    why: "ائتلفت أجزاؤها فتساوت، وانفردت بالسبب الثقيل: مُفاعَلَتُن ومُتَفاعِلُن.",
    sort: 2,
  },
  {
    slug: "mujtalab",
    name: "دائرة المجتلَب",
    why: "اجتُلبت أجزاؤها من الدائرة الأولى، فكلُّ بحرٍ فيها تكرارُ جزءٍ واحد.",
    sort: 3,
  },
  {
    slug: "mushtabih",
    name: "دائرة المشتبِه",
    why: "اشتبهت أجزاؤها، وفيها وحدها الوتدُ المفروق، وهي أوسع الدوائر.",
    sort: 4,
  },
  {
    slug: "muttafiq",
    name: "دائرة المتَّفِق",
    why: "اتّفقت أجزاؤها فلم يبقَ فيها إلا الخماسيّ وحده.",
    sort: 5,
  },
]

const DAIRA_BY_SLUG = new Map(DAWAIR.map((d) => [d.slug, d]))

export function dairaBySlug(slug: DairaSlug | null | undefined): Daira | undefined {
  return slug ? DAIRA_BY_SLUG.get(slug) : undefined
}

export const BUHUR: Bahr[] = [
  {
    slug: "tawil",
    name: "الطويل",
    tafilat: ["فعولن", "مفاعيلن", "فعولن", "مفاعلن"],
    miftah: "طويلٌ له دونَ البحورِ فضائلُ",
    miftahTafilat: "فعولن مفاعيلن فعولن مفاعلن",
    daira: "mukhtalif",
    sort: 1,
  },
  {
    slug: "madid",
    name: "المديد",
    tafilat: ["فاعلاتن", "فاعلن", "فاعلاتن"],
    miftah: "لمديدِ الشعرِ عندي صفاتُ",
    miftahTafilat: "فاعلاتن فاعلن فاعلاتن",
    daira: "mukhtalif",
    sort: 2,
  },
  {
    slug: "basit",
    name: "البسيط",
    tafilat: ["مستفعلن", "فاعلن", "مستفعلن", "فعلن"],
    miftah: "إنّ البسيطَ لديه يُبسَطُ الأملُ",
    miftahTafilat: "مستفعلن فاعلن مستفعلن فعلن",
    daira: "mukhtalif",
    sort: 3,
  },
  {
    slug: "wafir",
    name: "الوافر",
    tafilat: ["مفاعلتن", "مفاعلتن", "فعولن"],
    miftah: "بحورُ الشعرِ وافرُها جميلُ",
    miftahTafilat: "مفاعلتن مفاعلتن فعولن",
    daira: "mutalif",
    sort: 4,
  },
  {
    slug: "kamil",
    name: "الكامل",
    tafilat: ["متفاعلن", "متفاعلن", "متفاعلن"],
    miftah: "كَمُلَ الجمالُ من البحورِ الكاملُ",
    miftahTafilat: "متفاعلن متفاعلن متفاعلن",
    daira: "mutalif",
    sort: 5,
  },
  {
    slug: "hazaj",
    name: "الهزج",
    tafilat: ["مفاعيلن", "مفاعيلن"],
    miftah: "على الأهزاجِ تسهيلُ",
    miftahTafilat: "مفاعيلن مفاعيلن",
    daira: "mujtalab",
    sort: 6,
  },
  {
    slug: "rajaz",
    name: "الرجز",
    tafilat: ["مستفعلن", "مستفعلن", "مستفعلن"],
    miftah: "في أبحرِ الأرجازِ بحرٌ يسهُلُ",
    miftahTafilat: "مستفعلن مستفعلن مستفعلن",
    daira: "mujtalab",
    sort: 7,
  },
  {
    slug: "ramal",
    name: "الرمل",
    tafilat: ["فاعلاتن", "فاعلاتن", "فاعلاتن"],
    miftah: "رملُ الأبحرِ ترويهِ الثقاتُ",
    miftahTafilat: "فاعلاتن فاعلاتن فاعلاتن",
    daira: "mujtalab",
    sort: 8,
  },
  {
    slug: "sari",
    name: "السريع",
    tafilat: ["مستفعلن", "مستفعلن", "فاعلن"],
    miftah: "بحرٌ سريعٌ ما له ساحلُ",
    miftahTafilat: "مستفعلن مستفعلن فاعلن",
    daira: "mushtabih",
    sort: 9,
  },
  {
    slug: "munsarih",
    name: "المنسرح",
    tafilat: ["مستفعلن", "مفعولات", "مستفعلن"],
    miftah: "مُنسرحٌ فيه يُضرَبُ المثلُ",
    miftahTafilat: "مستفعلن مفعولات مفتعلن",
    daira: "mushtabih",
    sort: 10,
  },
  {
    slug: "khafif",
    name: "الخفيف",
    tafilat: ["فاعلاتن", "مستفعلن", "فاعلاتن"],
    miftah: "يا خفيفًا خفّت به الحركاتُ",
    miftahTafilat: "فاعلاتن مستفعلن فاعلاتن",
    daira: "mushtabih",
    sort: 11,
  },
  {
    slug: "mudari",
    name: "المضارع",
    tafilat: ["مفاعيلن", "فاعلاتن"],
    miftah: "تُعَدُّ المضارعاتُ",
    miftahTafilat: "مفاعيلن فاعلاتن",
    daira: "mushtabih",
    sort: 12,
  },
  {
    slug: "muqtadab",
    name: "المقتضب",
    tafilat: ["مفعولات", "مستفعلن"],
    miftah: "اقتُضِبَ كما سُئِلوا",
    miftahTafilat: "مفعولات مستفعلن",
    daira: "mushtabih",
    sort: 13,
  },
  {
    slug: "mujtath",
    name: "المجتث",
    tafilat: ["مستفعلن", "فاعلاتن", "فاعلاتن"],
    miftah: "إنْ جُثّتِ الحركاتُ",
    miftahTafilat: "مستفعلن فاعلاتن",
    daira: "mushtabih",
    sort: 14,
  },
  {
    slug: "mutaqarib",
    name: "المتقارب",
    tafilat: ["فعولن", "فعولن", "فعولن", "فعولن"],
    miftah: "عن المتقاربِ قال الخليلُ",
    miftahTafilat: "فعولن فعولن فعولن فعولن",
    daira: "muttafiq",
    sort: 15,
  },
  {
    slug: "mutadarik",
    name: "المتدارك",
    tafilat: ["فاعلن", "فاعلن", "فاعلن", "فاعلن"],
    miftah: "حركاتُ المُحدَثِ تنتقلُ",
    miftahTafilat: "فاعلن فاعلن فاعلن فاعلن",
    daira: "muttafiq",
    note: "استدركه الأخفشُ على الخليل، فلذلك يُسمَّى المحدَث والمخترَع. وإذا تحرّكت أسبابه كلُّها سُمِّي الخبب.",
    sort: 16,
  },
]

const BY_SLUG = new Map(BUHUR.map((b) => [b.slug, b]))

export function bahrBySlug(slug: string | null | undefined): Bahr | undefined {
  return slug ? BY_SLUG.get(slug) : undefined
}

/** البحور of one دائرة, in circle order — the sections of `#/buhur`. */
export function buhurOfDaira(slug: DairaSlug): Bahr[] {
  return BUHUR.filter((b) => b.daira === slug)
}

/** The single تفعيلة used as the chip's glyph mark — the meter's signature. */
export function bahrGlyph(slug: string | null | undefined): string {
  const b = bahrBySlug(slug)
  return b?.tafilat[0] ?? ""
}
