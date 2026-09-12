/**
 * Empty states carry real أبيات, not apologies (design-ux.md §2).
 * Attribution is given only where it is certain; the rest run unattributed
 * rather than risk a wrong nisba on the page.
 */
export type FlavorBayt = {
  sadr: string
  ajuz: string
  poet: string | null
}

export type FlavorKey =
  | "search-none"
  | "no-favorites"
  | "defeat"
  | "facets-zero"
  | "no-due"

export const FLAVOR: Record<FlavorKey, FlavorBayt> = {
  "search-none": {
    sadr: "وما نيلُ المطالبِ بالتمنّي",
    ajuz: "ولكن تُؤخذُ الدنيا غِلابا",
    poet: "أحمد شوقي",
  },
  "no-favorites": {
    sadr: "إذا لم تستطعْ شيئًا فدعْهُ",
    ajuz: "وجاوزْهُ إلى ما تستطيعُ",
    poet: null,
  },
  defeat: {
    sadr: "ومن يكُ ذا فمٍ مرٍّ مريضٍ",
    ajuz: "يجدْ مُرًّا به الماءَ الزُّلالا",
    poet: "المتنبي",
  },
  "facets-zero": {
    sadr: "قد يُدركُ المتأنّي بعضَ حاجتِهِ",
    ajuz: "وقد يكونُ مع المستعجلِ الزللُ",
    poet: null,
  },
  "no-due": {
    sadr: "العلمُ يُحيي قلوبَ الميّتينَ كما",
    ajuz: "تُحيي البلادَ إذا ما مَسَّها المطرُ",
    poet: null,
  },
}

/** Headline that sits above the flavor بيت for each empty state. */
export const FLAVOR_TITLE: Record<FlavorKey, string> = {
  "search-none": "لا نتيجة",
  "no-favorites": "لا مختارات بعد",
  defeat: "انقضت الأرواح",
  "facets-zero": "لا قصيدة بهذه القيود",
  "no-due": "لا بطاقة مستحقّة اليوم",
}
