/**
 * #/rules — قواعد المساجلة, written for the player rather than for the server.
 *
 * The one thing this page exists to explain is the PEEL: the قافية of a بيت is
 * not simply its last letter, so a chain that looks wrong is usually the peel
 * doing its job. Every example below is one of the golden cases pinned in
 * shared/arabic.test.ts (`rawiyyOf`), so the page and the implementation cannot
 * drift into disagreeing.
 *
 * The verdict table is the exact set of outcomes `/api/game/verify` can answer
 * (design-server.md §8 + amendments §7) — no invented tags, and the costs are
 * the ones scoring.ts actually applies.
 */
import { Rule } from "../components/Ornaments.tsx"
import { routeHash } from "../router.ts"

/** Each row is a golden case of `rawiyyOf` in shared/arabic.test.ts. */
const PEELS: { word: string; rawiyy: string; why: string }[] = [
  { word: "اِرتَجي", rawiyy: "ج", why: "الياء آخرًا وصلٌ لا رويّ، فتُقشَر" },
  { word: "يَدعو", rawiyy: "ع", why: "والواو مثلها" },
  { word: "كِتابُهُ", rawiyy: "ب", why: "وهاء الضمير تُقشَر كذلك" },
  { word: "شِفاهُ", rawiyy: "ه", why: "لكنّ الهاء الأصليّة تبقى" },
  { word: "العَليمِ", rawiyy: "م", why: "والميم رويٌّ صريح" },
]

const VERDICTS: { tag: string; copy: string; cost: string }[] = [
  { tag: "حرفٌ خطأ", copy: "بيتك لا يبدأ بالحرف المطلوب.", cost: "لا شيء — البيت يبقى في الحقل" },
  { tag: "قيل قبلُ", copy: "هذا البيت — أو قصيدته — قيل في هذه المساجلة.", cost: "لا شيء" },
  { tag: "لم أجده", copy: "ليس في الديوان بهذا اللفظ.", cost: "روحٌ واحدة، مع ثلاثة اقتراحات" },
  { tag: "قريبٌ منه", copy: "وجدتُ بيتًا يشبهه شبهًا بعيدًا.", cost: "تقبله بخمسٍ وعشرين نقطة" },
  { tag: "أكثر من بيت", copy: "لفظك يصلح لأكثر من بيت — اختر أيّها قصدت.", cost: "لا شيء" },
  { tag: "شطرٌ ناقص", copy: "هذا بيتٌ في الديوان بلا عجز.", cost: "لا شيء" },
  { tag: "انقضى الوقت", copy: "لم تُجب قبل انتهاء المهلة.", cost: "روحٌ واحدة، ويُنشد الخصم ما كان يصلح" },
]

export function RulesView() {
  return (
    <div className="view rules-view">
      <header className="view__head">
        <h1 className="view__title">قواعد المساجلة</h1>
        <p className="view__lede">
          يُنشد الخصمُ بيتًا، فتُجيبَه ببيتٍ يبدأ بحرف رويِّه. فإذا انقطعتَ، ذهبتْ روح؛ وإذا انقطع هو، فقد أفحمتَه.
        </p>
      </header>

      <section className="rule-sec">
        <h2 className="section-title">أوّلًا: الرويّ</h2>
        <Rule />
        <p>
          رويُّ البيت ليس آخر حرفٍ في عجزه بالضرورة. تُقشَر الوصلة: الألف والواو والياء إذا جاءت إشباعًا في الآخر،
          وهاء الضمير. ما بقي بعد القشر هو الرويّ، وعليه تُبنى المساجلة.
        </p>
        <div className="rule-ex">
          {PEELS.map((p) => (
            <p className="rule-ex__line" key={p.word}>
              <bdi>{p.word}</bdi>
              <span className="rule-ex__note">
                {" ← الرويّ "}
                <em>{p.rawiyy}</em>
                {` · ${p.why}`}
              </span>
            </p>
          ))}
        </div>
        <p>
          ولأنّ القشر يُختلَف فيه، تقبل قريض الحرفين معًا: الرويَّ المقشور، والحرفَ الأخير كما هو. والمطلوب يُعرض
          دائمًا صريحًا فوق حقل الكتابة، ومعه الحرفُ الآخر إن اختلفا.
        </p>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">ثانيًا: ما يُقبل</h2>
        <Rule />
        <ul className="rule-list">
          <li>
            <b>البيت كاملًا، أو صدره وحده.</b>
            <span>إن كتبتَ الصدر فقط وكان في الديوان، قُبل وأُكمل لك عجزه.</span>
          </li>
          <li>
            <b>بلا تشكيل، وبأيّ رسمٍ للهمزة.</b>
            <span>«إذا» و«اذا» سواء، و«التاء المربوطة» تُحسب هاءً، والألف المقصورة ياءً.</span>
          </li>
          <li>
            <b>ولو أخطأتَ كلمةً أو كلمتين.</b>
            <span>يُبحث عن أقرب بيت، ويُقبل إذا كان الشبه قويًّا؛ فإن ضعف عُرض عليك لتقبله بثمن.</span>
          </li>
          <li>
            <b>ولا يُقبل بيتٌ قيل مرّتين.</b>
            <span>ولا بيتٌ من قصيدةٍ سبق أن أخذتَ منها بيتًا — لا تُعدَّن على ديوانٍ واحد.</span>
          </li>
        </ul>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">ثالثًا: ما يُردّ</h2>
        <Rule />
        <div className="table-scroll">
          <table className="verdicts">
            <thead>
              <tr>
                <th>الحكم</th>
                <th>المعنى</th>
                <th>الثمن</th>
              </tr>
            </thead>
            <tbody>
              {VERDICTS.map((v) => (
                <tr key={v.tag}>
                  <td>{v.tag}</td>
                  <td>{v.copy}</td>
                  <td>{v.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>الحكمُ للخادم وحده: قريض لا تقبل بيتًا ولا تردّه من عندها، وإنّما تسأل الديوان.</p>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">رابعًا: النقاط</h2>
        <Rule />
        <ul className="rule-list">
          <li>
            <b>مئة نقطة للبيت.</b>
            <span>
              تزيد بطول سلسلتك، وبما بقي من وقتك، وبغرابة البيت — فبيتٌ لشاعرٍ مغمور أثمنُ من بيتٍ يعرفه كلّ أحد.
            </span>
          </li>
          <li>
            <b>وخمسمئة إن أفحمتَ الخصم.</b>
            <span>أي إذا لم يبقَ في الديوان بيتٌ يبدأ بالحرف الذي ألزمتَه به.</span>
          </li>
          <li>
            <b>والهمسُ بثمن.</b>
            <span>«من قائله؟» و«أوّل كلمة» و«البحر» تُخصم من نقاط الدور، و«بدّل الحرف» تقطع سلسلتك.</span>
          </li>
        </ul>
      </section>

      <div className="poet-toolbar">
        <a className="btn btn--primary" href={routeHash({ view: "duel" })}>
          ساجِلني
        </a>
        <a className="btn" href={routeHash({ view: "daily" })}>
          تحدّي اليوم
        </a>
      </div>
    </div>
  )
}
