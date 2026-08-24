/**
 * The keymap, in one place, so HelpOverlay (`?`) and the handlers can never
 * drift. Arrow semantics are RTL-correct: ← is next, → is previous
 * (amendments §15); j/k are NOT mirrored — they follow document order.
 *
 * The Latin letters here are KEYCAPS, not characters. `useKeyboard` matches
 * `logicalKey(e)`, which falls back to `e.code`, so `j` fires on the physical J
 * whatever the layout has printed on it — which is the whole point in a product
 * whose readers are on an Arabic layout, where that key emits «ت».
 */
export type Shortcut = {
  /**
   * Displayed as <kbd>. Keep them to the keycap's own legend — ASCII for the
   * letters and named keys (`Esc`, `Enter`, `Shift`), and the two ARROWS ← / →,
   * which are the legends of real keys and are deliberately not spelled
   * `Left`/`Right`: an English word in an all-Arabic UI reads as untranslated.
   * They are safe in the `direction: ltr` <kbd> because U+2190/U+2192 are not
   * Bidi_Mirrored — unlike brackets and parentheses, which are.
   */
  keys: string[]
  label: string
  scope: "global" | "poem" | "duel" | "browse" | "train"
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ["?"], label: "عرض هذه القائمة", scope: "global" },
  { keys: ["/"], label: "التركيز على حقل البحث", scope: "global" },
  { keys: ["Esc"], label: "إغلاق النافذة أو إلغاء التركيز", scope: "global" },
  { keys: ["g", "h"], label: "الصفحة الأولى", scope: "global" },
  { keys: ["g", "p"], label: "الشعراء", scope: "global" },
  { keys: ["g", "b"], label: "التصفح", scope: "global" },
  { keys: ["g", "d"], label: "المساجلة", scope: "global" },
  { keys: ["g", "f"], label: "المختارات", scope: "global" },
  { keys: ["g", "s"], label: "الإحصاءات", scope: "global" },
  { keys: ["g", "t"], label: "التحفيظ", scope: "global" },
  { keys: ["g", "w"], label: "التجوال", scope: "global" },
  { keys: ["j"], label: "البيت التالي", scope: "poem" },
  { keys: ["k"], label: "البيت السابق", scope: "poem" },
  { keys: ["c"], label: "نسخ البيت", scope: "poem" },
  { keys: ["f"], label: "إضافة البيت إلى المختارات", scope: "poem" },
  { keys: ["s"], label: "مشاركة البيت", scope: "poem" },
  { keys: ["t"], label: "إظهار التشكيل أو إخفاؤه", scope: "poem" },
  { keys: ["Enter"], label: "إرسال البيت", scope: "duel" },
  { keys: ["Shift", "Enter"], label: "سطر جديد", scope: "duel" },
  { keys: ["Space"], label: "تخطّي الإنشاد", scope: "duel" },
  { keys: ["Enter"], label: "إرسال الجواب، ثم قبول التقدير المقترح", scope: "train" },
  { keys: ["1"], label: "من جديد — لم أذكره", scope: "train" },
  { keys: ["2"], label: "بصعوبة", scope: "train" },
  { keys: ["3"], label: "أصبتُ", scope: "train" },
  { keys: ["4"], label: "سهل", scope: "train" },
  { keys: ["←"], label: "المزيد من النتائج", scope: "browse" },
  { keys: ["→"], label: "العودة إلى أول النتائج", scope: "browse" },
]

export const SCOPE_LABEL: Record<Shortcut["scope"], string> = {
  global: "في كل مكان",
  poem: "في القصيدة",
  duel: "في المساجلة",
  browse: "في التصفح",
  train: "في المذاكرة",
}
