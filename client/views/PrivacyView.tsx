/**
 * #/privacy — the hosted privacy policy (a Google Play requirement for an app
 * with accounts).
 *
 * It is the SAME page whether reached in the native shell, at
 * `https://qarid.example.com/#/privacy`, or from the Play listing — that URL
 * is the stable one the Data Safety form and the store link point at. The page
 * is ARABIC ONLY — the owner's call (2026-08-27): the site is Arabic, and an
 * English half read as assembled. docs/legal/data-safety.md carries the English
 * a Play reviewer might need; the page itself does not.
 *
 * Everything here is the truth about what `server/users.ts` actually stores and
 * `server/ratelimit.ts` actually reads — no collection this app does not do. The
 * owner-only blanks (contact, jurisdiction) are EMPTY constants and are the
 * whole of what a human must fill before publishing — a missing one drops its
 * clause instead of printing a marker; the deletion URL is the live
 * `#/privacy`-sibling `#/u/<name>` settings.
 */
import { Rule } from "../components/Ornaments.tsx"
import { routeHash } from "../router.ts"
import { shareOrigin } from "../platform/native.ts"

/**
 * The owner-only blanks. **RELEASE BLOCKER: `OWNER_CONTACT` and
 * `OWNER_JURISDICTION` must carry real values before the Play listing goes
 * public** — see docs/legal/data-safety.md.
 *
 * They are EMPTY, not placeholders. A `[OWNER: …]` token printed on the page is
 * an English word, Latin brackets and a fake email on the one screen a Play
 * reviewer reads, so the page drops the whole clause while a value is missing
 * rather than showing the marker. Filling either constant restores its sentence
 * and nothing else has to change.
 */
const OWNER_CONTACT = ""
const OWNER_EFFECTIVE = "25 آب 2026"
const OWNER_JURISDICTION = ""

export function PrivacyView() {
  return (
    <div className="view rules-view privacy-view">
      <header className="view__head">
        <h1 className="view__title">سياسة الخصوصية</h1>
        <p className="view__lede">
          قريض ديوانٌ يُتصفَّح بلا حساب. الحساب لمساجلة صديقٍ باسمك ولصفحةٍ تحملُه — وهذا ما نحفظه حينئذٍ، وكيف، وكيف تمحوه.
        </p>
        <p className="privacy-effective">تاريخ السريان: {OWNER_EFFECTIVE}</p>
      </header>

      <section className="rule-sec">
        <h2 className="section-title">ما الذي نجمعه</h2>
        <Rule />
        <p>لا نجمع إلا ما يقوم به الحساب والمساجلة، ولا نطلب بريدًا ولا رقمًا ولا اسمًا حقيقيًّا:</p>
        <ul className="privacy-list">
          <li>
            <b>اسم المستخدم</b> الذي تختاره — وهو عنوان صفحتك العلنية.
          </li>
          <li>
            <b>بصمةُ كلمة السر لا نصُّها</b> — لا نخزّن كلمة السر نفسَها أبدًا، بل أثرًا مُجزّأً منها لا سبيل إلى ردِّه
            إليها، فلا نعرفها ولا نستطيع استرجاعها.
          </li>
          <li>
            <b>الاسم المعروض</b> (اختياري) — ما يراه خصمك على لوح المساجلة.
          </li>
          <li>
            <b>صورة الحساب</b> (اختيارية) — إن رفعتَ صورةً، حُفِظَت عندنا كما هي لتُعرَض على صفحتك.
          </li>
          <li>
            <b>إحصاء اللعب والمساجلة</b> — عدد المساجلات ونتائجها وأطول سلسلة، وترسانتُك إن اخترتَ نشرها.
          </li>
          <li>
            <b>سجلّ الغرف والمساجلات</b> — الأبيات المتبادلة في غرفك، ومع من ومتى.
          </li>
          <li>
            <b>عنوان جهازك على الشابكة عابرًا</b> — يُستعمل لحظةَ الطلب للحدّ من الإكثار ومنع الإساءة، ولا يُخزَّن سجلًّا
            دائمًا لك.
          </li>
        </ul>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">كيف نستعمله</h2>
        <Rule />
        <p>
          نستعمل هذه المعلومات لتشغيل الحساب والمساجلة لا غير: أن تدخل، وأن تُساجِل صديقًا في غرفة، وأن تظهر صفحتُك وسجلّك،
          وأن نحمي الخدمة من الإكثار والإساءة. والجلسةُ محفوظةٌ في متصفّحك على الموقع، وفي رمزِ دخولٍ على التطبيق، لا غير.
        </p>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">ما لا نفعله</h2>
        <Rule />
        <ul className="privacy-list">
          <li>لا نبيع بياناتك، ولا نشاركها مع طرفٍ ثالث لإعلانٍ أو غيره.</li>
          <li>لا نتعقّبك عبر المواقع، ولا نُضمّن أدوات تحليلٍ خارجية.</li>
          <li>لا نطلب بريدًا، فلا استرجاع لكلمة السر — احفظها، فالوحيد الذي يُعيد ضبطها هو صاحب الخدمة يدويًّا.</li>
        </ul>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">مدة الحفظ</h2>
        <Rule />
        <p>
          نحفظ حسابك ما دام قائمًا. تنتهي الجلسات من نفسها بعد تسعين يومًا من آخر استعمال. الغرف المنتظِرة تُطوى بعد ساعاتٍ من
          إهمالها، والمساجلات المنتهية يُحتفَظ بنصّها أيامًا ثم تُطوى. وإذا حذفتَ حسابك مُحي كلُّ ذلك حالًا كما يلي.
        </p>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">كيف تحذف حسابك</h2>
        <Rule />
        <p>
          الحذف بيدك، فوريٌّ لا رجعة فيه، من داخل التطبيق ومن الموقع سواء: افتح صفحتك ثم «احذف حسابي»، وأكّد بكلمة سرّك.
          حينئذٍ يُمحى اسمُك وبصمة سرّك وكلُّ جلساتك ورموزك، وصورتُك، وترسانتُك المنشورة، وسجلُّ مساجلاتك — وتُغلَق غرفُك
          المفتوحة، ويفوز خصمُك في أيّ مساجلةٍ جارية. أمّا المساجلات المنتهية فيبقى نصُّها عند خصمك، ويظهر اسمُك فيها «لاعبًا
          محذوفًا».
        </p>
        <p>
          عنوان الحذف على الشابكة هو صفحةُ حسابك نفسها:{" "}
          <span dir="ltr" className="privacy-url">
              {shareOrigin()}/#/u/&lt;اسمك&gt;
            </span>
          . ولعبُك المفرد محفوظٌ في متصفّحك أنت لا عندنا، فامسحُه بمسح بيانات الموقع من المتصفح.
        </p>
      </section>

      <section className="rule-sec">
        <h2 className="section-title">التواصل والتغيير</h2>
        <Rule />
        <p>
          {OWNER_CONTACT
            ? `لأيّ سؤالٍ عن خصوصيتك أو طلبِ حذف: ${OWNER_CONTACT}. `
            : "حذفُ حسابك بيدك من صفحتك، فلا يحتاج إلى مراسلتنا. "}
          {OWNER_JURISDICTION ? `تحكم هذه السياسةَ أنظمةُ ${OWNER_JURISDICTION}. ` : ""}
          وإذا تغيّرت السياسة حدّثنا هذه الصفحة وتاريخَ سريانها.
        </p>
        <p className="privacy-back">
          <a className="btn btn--ghost" href={routeHash({ view: "home" })}>
            إلى الديوان
          </a>
        </p>
      </section>
    </div>
  )
}
