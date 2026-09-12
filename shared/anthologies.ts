/**
 * المختارات المنظومة — the two curated shelves the ديوان opens with.
 *
 * This file is the CANON, not the data. Nothing here is an id: every entry is
 * a شاعر and the folded opening words of a مطلع, and the server resolves the
 * pair against `data/qarid.db` AT RUNTIME (`server/routes/anthology.ts`). That
 * is deliberate and it is the whole design:
 *
 *   - `public_id` moves on every rebuild for the 73 % of قصائد that fall back
 *     to `q<row id>` (CLAUDE.md §The artefact), so a table of ids would rot on
 *     the next `npm run ingest`. A مطلع does not move.
 *   - the resolution needs no re-ingest and no new column: it rides the
 *     `baits_fts` index the search box already uses, and the anchor is folded
 *     by `shared/arabic.ts` — the one normalizer — so «قِفا نَبكِ» and «قفا
 *     نبك» are the same anchor here for exactly the reason they are the same
 *     query in البحث.
 *   - a curated line the corpus does not hold RESOLVES TO NOTHING and is said
 *     to be missing. It is never quietly dropped: «المعلقات» that print nine
 *     odes and call it ten would be lying about the ديوان.
 *
 * Identity of a شاعر is `normalizeArabic(poet)` folded through
 * `shared/poetAliases.ts`, the same key `poets.name_key` is UNIQUE on — the
 * `famousPoets.ts` pattern. And the شاعر is part of the ANCHOR, not decoration:
 * 21,739 صدور in the corpus carry a different روي under a different شاعر
 * (CLAUDE.md §Corpus quirks), and «على قدر أهل العزم» alone appears under six
 * names. Anchored on the words alone, «سئمت تكاليف الحياة» resolves to أبو نصر
 * النحاس and «أقيموا بني أمي» to ابن عديّم الرواحي — both real rows, neither
 * the poet the anthology is naming.
 *
 * Every entry below was verified to resolve against the built artefact
 * (`build_id d1a38337`); `shared/anthologies.test.ts` re-checks the shape and
 * `server/routes/anthology.test.ts` re-checks the resolution over the fixture.
 */

import { bareWords } from "./arabic.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** What a shelf renders: whole قصائد, or single أبيات on a `BaytPlate`. */
export type AnthologyKind = "poems" | "baits"

export interface AnthologyEntry {
  /**
   * The شاعر as the anthology names him. Folded to `name_key`, so the natural
   * spelling is fine — «حافظ إبراهيم» finds the corpus's «حافظ ابراهيم».
   */
  readonly poet: string
  /**
   * The anchor AND the fallback text: the opening words of the مطلع, written
   * the way the anthology says them. `entryAnchor()` folds it; the shelf prints
   * it verbatim when the corpus has no match.
   */
  readonly matla: string
  /** المعلقات only — the ode's own name, «معلقة امرئ القيس». */
  readonly name?: string
}

export interface Anthology {
  readonly slug: string
  /** «المعلقات» — the shelf's name, and the page's `<h1>`. */
  readonly title: string
  /** One line under the title. */
  readonly tagline: string
  /** The shelf's own paragraph, on its page. */
  readonly blurb: string
  readonly kind: AnthologyKind
  readonly entries: readonly AnthologyEntry[]
}

/**
 * How many opening words anchor an entry.
 *
 * Four is the floor the corpus set. «آذنتنا ببينها أسماء» is three words and
 * is unique in 3.37M أبيات; two words are not (a «قفا نبك» anchor matches
 * twenty-three قصائد, most of them somebody quoting امرأ القيس). Above six the
 * anchor starts breaking on the scrape's own damage — a word split across the
 * hemistich boundary («تَعَبٌ كُلُّها الحَياةُ فَما أَعْ / جَبُ …») ends the
 * صدر mid-token — so an entry may name fewer words than its مطلع has, and the
 * shorter phrase is still the anchor.
 */
export const ANCHOR_MIN_WORDS = 3

/**
 * The one place a curated مطلع becomes a lookup key.
 *
 * `bareWords` is `normalizeArabic` + the search box's own punctuation strip
 * (`shared/arabic.ts`), so the anchor is spelled exactly the way `baits_fts`
 * spelled the بيت at ingest — which is what lets the resolution be one FTS5
 * phrase instead of a scan.
 */
export function entryAnchor(matla: string): string {
  return bareWords(matla)
}

/** The anchor's words, for the callers that need to count or quote them. */
export function entryAnchorWords(matla: string): string[] {
  return entryAnchor(matla).split(" ").filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────────
// المعلقات — the ten hanging odes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ten, not seven. The السبع المعلقات of ابن الأنباري are the core; الأعشى and
 * عبيد بن الأبرص come in with أبي عبيدة and النابغة with ابن خلدون, and the
 * ten-ode collection is the one a ديوان hangs on its wall.
 */
const MUALLAQAT: readonly AnthologyEntry[] = [
  { poet: "امرؤ القيس", name: "معلقة امرئ القيس", matla: "قفا نبك من ذكرى حبيب ومنزل" },
  { poet: "طرفة بن العبد", name: "معلقة طرفة", matla: "لخولة أطلال ببرقة ثهمد" },
  { poet: "زهير بن أبي سلمى", name: "معلقة زهير", matla: "أمن أم أوفى دمنة لم تكلم" },
  { poet: "لبيد بن ربيعة", name: "معلقة لبيد", matla: "عفت الديار محلها فمقامها" },
  { poet: "عمرو بن كلثوم", name: "معلقة عمرو بن كلثوم", matla: "ألا هبي بصحنك فاصبحينا" },
  { poet: "عنترة بن شداد", name: "معلقة عنترة", matla: "هل غادر الشعراء من متردم" },
  { poet: "الحارث بن حلزة", name: "معلقة الحارث بن حلزة", matla: "آذنتنا ببينها أسماء" },
  { poet: "النابغة الذبياني", name: "معلقة النابغة", matla: "يا دار مية بالعلياء فالسند" },
  { poet: "الأعشى", name: "معلقة الأعشى", matla: "ودع هريرة إن الركب مرتحل" },
  { poet: "عبيد بن الأبرص", name: "معلقة عبيد بن الأبرص", matla: "أقفر من أهله ملحوب" },
]

// ─────────────────────────────────────────────────────────────────────────────
// مئة بيت سائر — the hundred that became sayings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A بيت سائر is one that left its قصيدة and went on alone: quoted in a
 * خطبة, written over a door, said by people who could not name the شاعر.
 * These hundred are the commons of the language, and each one is anchored to
 * the copy its own شاعر carries — not to the most-quoted row, which is often
 * a later poet quoting him.
 *
 * Attribution follows the corpus where the corpus is right and drops the
 * entry where it is not: «إذا بلغ الفطام لنا صبي» is عمرو بن كلثوم's and the
 * artefact files it under عنترة, so it is simply not here.
 */
const SAAIR: readonly AnthologyEntry[] = [
  { poet: "المتنبي", matla: "على قدر أهل العزم تأتي العزائم" },
  { poet: "المتنبي", matla: "إذا غامرت في شرف مروم" },
  { poet: "المتنبي", matla: "الخيل والليل والبيداء تعرفني" },
  { poet: "المتنبي", matla: "أنا الذي نظر الأعمى إلى أدبي" },
  { poet: "المتنبي", matla: "ومن نكد الدنيا على الحر أن يرى" },
  { poet: "المتنبي", matla: "ذو العقل يشقى في النعيم بعقله" },
  { poet: "المتنبي", matla: "ما كل ما يتمنى المرء يدركه" },
  { poet: "المتنبي", matla: "أعز مكان في الدنى سرج سابح" },
  { poet: "المتنبي", matla: "وإذا كانت النفوس كبارا" },
  { poet: "المتنبي", matla: "عيد بأية حال عدت يا عيد" },
  { poet: "المتنبي", matla: "الرأي قبل شجاعة الشجعان" },
  { poet: "المتنبي", matla: "إذا رأيت نيوب الليث بارزة" },
  { poet: "المتنبي", matla: "ومن يك ذا فم مر مريض" },
  { poet: "المتنبي", matla: "أنام ملء جفوني عن شواردها" },
  { poet: "المتنبي", matla: "وإذا لم يكن من الموت بد" },
  { poet: "المتنبي", matla: "إذا أنت أكرمت الكريم ملكته" },
  { poet: "المتنبي", matla: "لا يسلم الشرف الرفيع من الأذى" },
  { poet: "المتنبي", matla: "من يهن يسهل الهوان عليه" },
  { poet: "المتنبي", matla: "الظلم من شيم النفوس فإن تجد" },
  { poet: "المتنبي", matla: "كفى بك داء أن ترى الموت شافيا" },
  { poet: "المتنبي", matla: "لا تشتر العبد إلا والعصا معه" },
  { poet: "المتنبي", matla: "أرق على أرق ومثلي يأرق" },
  { poet: "المتنبي", matla: "صحب الناس قبلنا ذا الزمانا" },
  { poet: "المتنبي", matla: "ولو أن الحياة تبقى لحي" },
  { poet: "أبو تمام", matla: "السيف أصدق أنباء من الكتب" },
  { poet: "أبو تمام", matla: "نقل فؤادك حيث شئت من الهوى" },
  { poet: "أبو تمام", matla: "وطول مقام المرء في الحي مخلق" },
  { poet: "أبو تمام", matla: "وإذا أراد الله نشر فضيلة" },
  { poet: "أبو تمام", matla: "بيض الصفائح لا سود الصحائف" },
  { poet: "أبو العلاء المعري", matla: "غير مجد في ملتي واعتقادي" },
  { poet: "أبو العلاء المعري", matla: "ضحكنا وكان الضحك منا سفاهة" },
  { poet: "الإمام الشافعي", matla: "ما حك جلدك مثل ظفرك" },
  { poet: "الإمام الشافعي", matla: "دع الأيام تفعل ما تشاء" },
  { poet: "الإمام الشافعي", matla: "تموت الأسد في الغابات جوعا" },
  { poet: "الإمام الشافعي", matla: "سافر تجد عوضا عمن تفارقه" },
  { poet: "الإمام الشافعي", matla: "إني رأيت وقوف الماء يفسده" },
  { poet: "الإمام الشافعي", matla: "إذا لم يكن صفو الوداد طبيعة" },
  { poet: "الإمام الشافعي", matla: "شكوت إلى وكيع سوء حفظي" },
  { poet: "الإمام الشافعي", matla: "نعيب زماننا والعيب فينا" },
  { poet: "زهير بن أبي سلمى", matla: "ومن يجعل المعروف في غير أهله" },
  { poet: "زهير بن أبي سلمى", matla: "ومن هاب أسباب المنايا ينلنه" },
  { poet: "زهير بن أبي سلمى", matla: "ومهما تكن عند امرئ من خليقة" },
  { poet: "زهير بن أبي سلمى", matla: "سئمت تكاليف الحياة ومن يعش" },
  { poet: "زهير بن أبي سلمى", matla: "رأيت المنايا خبط عشواء من تصب" },
  { poet: "طرفة بن العبد", matla: "ستبدي لك الأيام ما كنت جاهلا" },
  { poet: "طرفة بن العبد", matla: "وظلم ذوي القربى أشد مضاضة" },
  { poet: "عنترة بن شداد", matla: "لا تسقني ماء الحياة بذلة" },
  { poet: "عنترة بن شداد", matla: "وإذا الجبان نهاك يوم كريهة" },
  { poet: "امرؤ القيس", matla: "مكر مفر مقبل مدبر معا" },
  { poet: "السموأل", matla: "إذا المرء لم يدنس من اللؤم عرضه" },
  { poet: "السموأل", matla: "تعيرنا أنا قليل عديدنا" },
  { poet: "السموأل", matla: "وما مات منا سيد حتف أنفه" },
  { poet: "الشنفرى", matla: "أقيموا بني أمي صدور مطيكم" },
  { poet: "المقنع الكندي", matla: "يعاتبني في الدين قومي وإنما" },
  { poet: "أحمد شوقي", matla: "قم للمعلم وفه التبجيلا" },
  { poet: "أحمد شوقي", matla: "وإذا أصيب القوم في أخلاقهم" },
  { poet: "أحمد شوقي", matla: "وطني لو شغلت بالخلد عنه" },
  { poet: "أحمد شوقي", matla: "وما نيل المطالب بالتمني" },
  { poet: "حافظ إبراهيم", matla: "الأم مدرسة إذا أعددتها" },
  { poet: "حافظ إبراهيم", matla: "أنا البحر في أحشائه الدر كامن" },
  { poet: "حافظ إبراهيم", matla: "وكم ذا بمصر من المضحكات" },
  { poet: "إيليا أبو ماضي", matla: "قال السماء كئيبة وتجهما" },
  { poet: "أبو فراس الحمداني", matla: "أراك عصي الدمع شيمتك الصبر" },
  { poet: "أبو فراس الحمداني", matla: "سيذكرني قومي إذا جد جدهم" },
  { poet: "الطغرائي", matla: "أعلل النفس بالآمال أرقبها" },
  { poet: "ابن الوردي", matla: "اعتزل ذكر الأغاني والغزل" },
  { poet: "علي بن أبي طالب", matla: "الناس من جهة التمثال أكفاء" },
  { poet: "علي بن أبي طالب", matla: "وفي الجهل قبل الموت موت لأهله" },
  { poet: "علي بن أبي طالب", matla: "إذا اشتملت على اليأس القلوب" },
  { poet: "كعب بن زهير", matla: "بانت سعاد فقلبي اليوم متبول" },
  { poet: "البوصيري", matla: "أمن تذكر جيران بذي سلم" },
  { poet: "الفرزدق", matla: "هذا الذي تعرف البطحاء وطأته" },
  { poet: "جرير", matla: "إن العيون التي في طرفها حور" },
  { poet: "الحطيئة", matla: "من يفعل الخير لا يعدم جوازيه" },
  { poet: "بشار بن برد", matla: "إذا بلغ الرأي المشورة فاستعن" },
  { poet: "الأخطل", matla: "وإذا افتقرت إلى الذخائر لم تجد" },
  { poet: "ابن زيدون", matla: "أضحى التنائي بديلا من تدانينا" },
  { poet: "ابو نواس", matla: "دع عنك لومي فإن اللوم إغراء" },
  { poet: "معن بن أوس المزني", matla: "أعلمه الرماية كل يوم" },
  { poet: "عمرو بن كلثوم", matla: "ألا لا يجهلن أحد علينا" },
  { poet: "أبو ذؤيب الهذلي", matla: "وإذا المنية أنشبت أظفارها" },
  { poet: "النابغة الذبياني", matla: "ولست بمستبق أخا لا تلمه" },
  { poet: "النابغة الذبياني", matla: "فإنك كالليل الذي هو مدركي" },
  { poet: "أبو الأسود الدؤلي", matla: "لا تنه عن خلق وتأتي مثله" },
  { poet: "أبو البقاء الرندي", matla: "لكل شيء إذا ما تم نقصان" },
  { poet: "ابن الفارض", matla: "سقتني حميا الحب راحة مقلتي" },
  { poet: "دريد بن الصمة", matla: "إذا لم تستطع شيئا فدعه" },
  { poet: "سلم الخاسر", matla: "من راقب الناس مات غما" },
  { poet: "البحتري", matla: "إذا ما الجرح رم على فساد" },
  { poet: "مسكين الدرامي", matla: "أخاك أخاك إن من لا أخا له" },
  { poet: "المتوكل الليثي", matla: "يا أيها الرجل المعلم غيره" },
  { poet: "صالح بن عبد القدوس", matla: "إذا قل ماء الوجه قل حياؤه" },
  { poet: "أبو القاسم الشابي", matla: "إذا الشعب يوما أراد الحياة" },
  { poet: "أبو القاسم الشابي", matla: "ومن يتهيب صعود الجبال" },
  { poet: "حسان بن ثابت", matla: "وأحسن منك لم تر قط عيني" },
  { poet: "ابن المعتز", matla: "يا نفس صبرا لعل الخير عقباك" },
  { poet: "لبيد بن ربيعة", matla: "ألا كل شيء ما خلا الله باطل" },
  { poet: "الخنساء", matla: "يذكرني طلوع الشمس صخرا" },
  { poet: "ابن الرومي", matla: "بلد صحبت به الشبيبة والصبا" },
  { poet: "مجنون ليلى", matla: "وقد يجمع الله الشتيتين بعدما" },
]

// ─────────────────────────────────────────────────────────────────────────────
// The shelves
// ─────────────────────────────────────────────────────────────────────────────

export const ANTHOLOGIES: readonly Anthology[] = [
  {
    slug: "muallaqat",
    title: "المعلقات",
    tagline: "عشر قصائد عُلِّقت على الكعبة، أو هكذا قيل",
    blurb:
      "قيل إنها كُتبت بماء الذهب وعُلِّقت على أستار الكعبة، وقيل إنها عُلِّقت في الأذهان فحسب. " +
      "وأيًّا كان الخبر، فهذه العشر هي أول ما يُقرأ من الشعر العربي وآخر ما يُنسى منه: " +
      "أطلالٌ ورحيلٌ وفخرٌ وحكمة، وقصائد لا يزال مطلعها يُروى وحده كأنه بيت سائر.",
    kind: "poems",
    entries: MUALLAQAT,
  },
  {
    slug: "sair",
    title: "مئة بيت سائر",
    tagline: "أبياتٌ خرجت من قصائدها فصارت أمثالًا",
    blurb:
      "بيتٌ سائر هو بيتٌ فارق قصيدته ومضى وحده: يُقال في الخطبة، ويُكتب على الباب، " +
      "ويردّده من لا يعرف قائله. جمعنا هاهنا مئةً منها، كلٌّ منها موصولٌ بديوان صاحبه، " +
      "فإن شئت قرأت القصيدة التي جاء منها، وإن شئت ساجلت به.",
    kind: "baits",
    entries: SAAIR,
  },
]

/** Shelf by slug, for the route and the client's deep link. */
export const ANTHOLOGY_BY_SLUG: ReadonlyMap<string, Anthology> = new Map(
  ANTHOLOGIES.map((a) => [a.slug, a] as const),
)

export function anthologyBySlug(slug: string): Anthology | null {
  return ANTHOLOGY_BY_SLUG.get(slug) ?? null
}
