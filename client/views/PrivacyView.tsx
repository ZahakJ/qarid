/**
 * #/privacy — the privacy policy. It describes what `server/users.ts` stores
 * and `server/ratelimit.ts` reads. The deletion URL is `#/u/<name>`.
 */
import { Rule } from "../components/Ornaments.tsx"
import { routeHash } from "../router.ts"
import { shareOrigin } from "../platform/native.ts"

/**
 * Filled in by whoever operates a deployment. An empty value drops its clause.
 */
const OPERATOR_CONTACT = ""
const POLICY_EFFECTIVE = "25 آب 2026"
const OPERATOR_JURISDICTION = ""

export function PrivacyView() {
  return (
    <div className="view rules-view privacy-view">
      <header className="view__head">
        <h1 className="view__title">سياسة الخصوصية</h1>
        <p className="view__lede">
          قريض ديوانٌ يُتصفَّح بلا حساب. الحساب لمساجلة صديقٍ باسمك ولصفحةٍ تحملُه — وهذا ما نحفظه حينئذٍ، وكيف، وكيف تمحوه.
        </p>
        <p className="privacy-effective">تاريخ السريان: {POLICY_EFFECTIVE}</p>
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
            <b>المساجلة بلا حساب</b> — الاسم الذي تكتبه إن كتبتَه، والأبيات المتبادلة، وأثرُ رمز المقعد لا نصُّه. تُمحى كلُّها
            بعد يومٍ من انتهاء المساجلة.
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
          <li>لا نطلب بريدًا. استرجاعُ كلمة السر برمز الاستعادة الذي يظهر لك عند التسجيل، ولا نحفظ منه إلا أثرَه.</li>
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
          {OPERATOR_CONTACT
            ? `لأيّ سؤالٍ عن خصوصيتك أو طلبِ حذف: ${OPERATOR_CONTACT}. `
            : "حذفُ حسابك بيدك من صفحتك، فلا يحتاج إلى مراسلتنا. "}
          {OPERATOR_JURISDICTION ? `تحكم هذه السياسةَ أنظمةُ ${OPERATOR_JURISDICTION}. ` : ""}
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
