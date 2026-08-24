/**
 * The keymap, in one place, so HelpOverlay (`?`) and the handlers can never
 * drift. Arrow semantics are RTL-correct: ← is next, → is previous
 * (amendments §15); j/k are NOT mirrored — they follow document order.
 */
export type Shortcut = {
  /** displayed as <kbd>; keep them ASCII */
  keys: string[]
  label: string
  scope: "global" | "poem" | "duel" | "browse"
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
  { keys: ["j"], label: "البيت التالي", scope: "poem" },
  { keys: ["k"], label: "البيت السابق", scope: "poem" },
  { keys: ["c"], label: "نسخ البيت", scope: "poem" },
  { keys: ["f"], label: "إضافة البيت إلى المختارات", scope: "poem" },
  { keys: ["s"], label: "مشاركة البيت", scope: "poem" },
  { keys: ["t"], label: "إظهار التشكيل أو إخفاؤه", scope: "poem" },
  { keys: ["Enter"], label: "إرسال البيت", scope: "duel" },
  { keys: ["Shift", "Enter"], label: "سطر جديد", scope: "duel" },
  { keys: ["Space"], label: "تخطّي الإنشاد", scope: "duel" },
  { keys: ["←"], label: "المزيد من النتائج", scope: "browse" },
  { keys: ["→"], label: "العودة إلى أول النتائج", scope: "browse" },
]

export const SCOPE_LABEL: Record<Shortcut["scope"], string> = {
  global: "في كل مكان",
  poem: "في القصيدة",
  duel: "في المساجلة",
  browse: "في التصفح",
}
