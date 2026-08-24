/**
 * The sixteen بحور of الخليل بن أحمد — static, no API call. Feeds the بحر chip
 * popover on the poem page (design-ux.md §3 Poem) and the tafʿila glyph on the
 * chip itself.
 *
 * `slug` matches shared/meters.ts (design-server.md §3) so a chip can link
 * straight into #/browse?meter=<slug>. `sort` is the classical circle order,
 * not corpus frequency.
 */
export type Bahr = {
  slug: string
  /** display name, with the definite article as the corpus writes it */
  name: string
  /** التفعيلات of one full بيت, in reading order */
  tafilat: string[]
  /** the مفتاح: the mnemonic hemistich that scans as the meter itself */
  miftah: string
  /** the مفتاح's own scansion, i.e. what the mnemonic line maps onto */
  miftahTafilat: string
  sort: number
}

export const BUHUR: Bahr[] = [
  {
    slug: "tawil",
    name: "الطويل",
    tafilat: ["فعولن", "مفاعيلن", "فعولن", "مفاعلن"],
    miftah: "طويلٌ له دونَ البحورِ فضائلُ",
    miftahTafilat: "فعولن مفاعيلن فعولن مفاعلن",
    sort: 1,
  },
  {
    slug: "madid",
    name: "المديد",
    tafilat: ["فاعلاتن", "فاعلن", "فاعلاتن"],
    miftah: "لمديدِ الشعرِ عندي صفاتُ",
    miftahTafilat: "فاعلاتن فاعلن فاعلاتن",
    sort: 2,
  },
  {
    slug: "basit",
    name: "البسيط",
    tafilat: ["مستفعلن", "فاعلن", "مستفعلن", "فعلن"],
    miftah: "إنّ البسيطَ لديه يُبسَطُ الأملُ",
    miftahTafilat: "مستفعلن فاعلن مستفعلن فعلن",
    sort: 3,
  },
  {
    slug: "wafir",
    name: "الوافر",
    tafilat: ["مفاعلتن", "مفاعلتن", "فعولن"],
    miftah: "بحورُ الشعرِ وافرُها جميلُ",
    miftahTafilat: "مفاعلتن مفاعلتن فعولن",
    sort: 4,
  },
  {
    slug: "kamil",
    name: "الكامل",
    tafilat: ["متفاعلن", "متفاعلن", "متفاعلن"],
    miftah: "كَمُلَ الجمالُ من البحورِ الكاملُ",
    miftahTafilat: "متفاعلن متفاعلن متفاعلن",
    sort: 5,
  },
  {
    slug: "hazaj",
    name: "الهزج",
    tafilat: ["مفاعيلن", "مفاعيلن"],
    miftah: "على الأهزاجِ تسهيلُ",
    miftahTafilat: "مفاعيلن مفاعيلن",
    sort: 6,
  },
  {
    slug: "rajaz",
    name: "الرجز",
    tafilat: ["مستفعلن", "مستفعلن", "مستفعلن"],
    miftah: "في أبحرِ الأرجازِ بحرٌ يسهُلُ",
    miftahTafilat: "مستفعلن مستفعلن مستفعلن",
    sort: 7,
  },
  {
    slug: "ramal",
    name: "الرمل",
    tafilat: ["فاعلاتن", "فاعلاتن", "فاعلاتن"],
    miftah: "رملُ الأبحرِ ترويهِ الثقاتُ",
    miftahTafilat: "فاعلاتن فاعلاتن فاعلاتن",
    sort: 8,
  },
  {
    slug: "sari",
    name: "السريع",
    tafilat: ["مستفعلن", "مستفعلن", "فاعلن"],
    miftah: "بحرٌ سريعٌ ما له ساحلُ",
    miftahTafilat: "مستفعلن مستفعلن فاعلن",
    sort: 9,
  },
  {
    slug: "munsarih",
    name: "المنسرح",
    tafilat: ["مستفعلن", "مفعولات", "مستفعلن"],
    miftah: "مُنسرحٌ فيه يُضرَبُ المثلُ",
    miftahTafilat: "مستفعلن مفعولات مفتعلن",
    sort: 10,
  },
  {
    slug: "khafif",
    name: "الخفيف",
    tafilat: ["فاعلاتن", "مستفعلن", "فاعلاتن"],
    miftah: "يا خفيفًا خفّت به الحركاتُ",
    miftahTafilat: "فاعلاتن مستفعلن فاعلاتن",
    sort: 11,
  },
  {
    slug: "mudari",
    name: "المضارع",
    tafilat: ["مفاعيلن", "فاعلاتن"],
    miftah: "تُعَدُّ المضارعاتُ",
    miftahTafilat: "مفاعيلن فاعلاتن",
    sort: 12,
  },
  {
    slug: "muqtadab",
    name: "المقتضب",
    tafilat: ["مفعولات", "مستفعلن"],
    miftah: "اقتُضِبَ كما سُئِلوا",
    miftahTafilat: "مفعولات مستفعلن",
    sort: 13,
  },
  {
    slug: "mujtath",
    name: "المجتث",
    tafilat: ["مستفعلن", "فاعلاتن", "فاعلاتن"],
    miftah: "إنْ جُثّتِ الحركاتُ",
    miftahTafilat: "مستفعلن فاعلاتن",
    sort: 14,
  },
  {
    slug: "mutaqarib",
    name: "المتقارب",
    tafilat: ["فعولن", "فعولن", "فعولن", "فعولن"],
    miftah: "عن المتقاربِ قال الخليلُ",
    miftahTafilat: "فعولن فعولن فعولن فعولن",
    sort: 15,
  },
  {
    slug: "mutadarik",
    name: "المتدارك",
    tafilat: ["فاعلن", "فاعلن", "فاعلن", "فاعلن"],
    miftah: "حركاتُ المُحدَثِ تنتقلُ",
    miftahTafilat: "فاعلن فاعلن فاعلن فاعلن",
    sort: 16,
  },
]

const BY_SLUG = new Map(BUHUR.map((b) => [b.slug, b]))

export function bahrBySlug(slug: string | null | undefined): Bahr | undefined {
  return slug ? BY_SLUG.get(slug) : undefined
}

/** The single تفعيلة used as the chip's glyph mark — the meter's signature. */
export function bahrGlyph(slug: string | null | undefined): string {
  const b = bahrBySlug(slug)
  return b?.tafilat[0] ?? ""
}
