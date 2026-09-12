/**
 * `#/more` — the «المزيد» tab (the fifth door of the phone chrome).
 *
 * Everything the masthead used to carry and the bottom bar has no room for: the
 * four reading surfaces that are not tabs (الشعراء، بيت اليوم، التجوال،
 * المختارات، الإحصاءات), the rules of the game, the account, and the two pages
 * that used to live in the footer.
 *
 * It is a native settings list — grouped rows, each at least 48px, icon ·
 * label · disclosure — and the disclosure points LEFT, because forward is
 * toward the inline-end edge under RTL. What keeps it ours rather than a
 * borrowed iOS table is the frame: the whole list is one illuminated panel with
 * the four manuscript corners, and each group is titled over a dissolving gold
 * hairline, the same head the rest of the app gives a section.
 *
 * On desktop this route renders too — nothing links to it there, because the
 * masthead already IS this index, and a route that 404s because of the reader's
 * pointer type would be worse than one nobody visits.
 */
import type { ReactNode } from "react"

import {
  AccountMark,
  BuhurMark,
  DayMark,
  ForwardChevron,
  KeepMark,
  PoetsMark,
  QafiyaMark,
  ShelfMark,
  RulesMark,
  ShieldMark,
  SignOutMark,
  StatsMark,
  WanderMark,
} from "../components/ChromeIcons.tsx"
import { InstallControl } from "../components/InstallControl.tsx"
import { Avatar } from "../components/Avatar.tsx"
import { PanelCorners, Rule } from "../components/Ornaments.tsx"
import { routeHash, type Route } from "../router.ts"
import { useAuth } from "../store/authStore.ts"

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="moregroup">
      <h2 className="moregroup__title">{title}</h2>
      <Rule className="moregroup__rule" />
      <ul className="moregroup__rows">{children}</ul>
    </section>
  )
}

function LinkRow({
  icon,
  label,
  note,
  route,
}: {
  icon: ReactNode
  label: string
  note?: string
  route: Route
}) {
  return (
    <li className="morerow-slot">
      <a className="morerow" href={routeHash(route)}>
        <span className="morerow__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="morerow__text">
          <span className="morerow__label">{label}</span>
          {note ? <span className="morerow__note">{note}</span> : null}
        </span>
        <span className="morerow__go" aria-hidden="true">
          <ForwardChevron />
        </span>
      </a>
    </li>
  )
}

function ActionRow({
  icon,
  label,
  note,
  onClick,
  tone,
}: {
  icon: ReactNode
  label: string
  note?: string
  onClick: () => void
  tone?: "quiet"
}) {
  return (
    <li className="morerow-slot">
      <button type="button" className="morerow" data-tone={tone ?? "normal"} onClick={onClick}>
        <span className="morerow__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="morerow__text">
          <span className="morerow__label">{label}</span>
          {note ? <span className="morerow__note">{note}</span> : null}
        </span>
      </button>
    </li>
  )
}

/**
 * The account group. It says three different things depending on what the
 * server has told us, and one of them is «nothing at all»: a deployment with no
 * writable users database has no account door anywhere else in the app either,
 * and a row that cannot open is worse than no row (the masthead's own rule).
 */
function AccountGroup() {
  const status = useAuth((s) => s.status)
  const available = useAuth((s) => s.available)
  const user = useAuth((s) => s.user)
  const openDialog = useAuth((s) => s.openDialog)
  const signOut = useAuth((s) => s.signOut)

  if (status === "unknown" || !available) return null

  return (
    <Group title="الحساب">
      {user ? (
        <>
          <li className="morerow-slot">
            <a className="morerow" href={routeHash({ view: "profile", username: user.username })}>
              <span className="morerow__disc" aria-hidden="true">
                <Avatar name={user.displayName} src={user.avatar} />
              </span>
              <span className="morerow__text">
                <span className="morerow__label">
                  <bdi>{user.displayName}</bdi>
                </span>
                <span className="morerow__note">صفحتك وإعداداتها: الصورة، ورمز الاستعادة، والمحظورون</span>
              </span>
              <span className="morerow__go" aria-hidden="true">
                <ForwardChevron />
              </span>
            </a>
          </li>
          <ActionRow icon={<SignOutMark />} label="اخرج" tone="quiet" onClick={() => void signOut()} />
        </>
      ) : (
        <ActionRow
          icon={<AccountMark />}
          label="دخول"
          note="الحساب لمساجلة صديقٍ باسمك، ولصفحةٍ تحملُه"
          onClick={() => openDialog("login")}
        />
      )}
    </Group>
  )
}

export function MoreView() {
  return (
    <div className="view more-view">
      <div className="morelist">
        <PanelCorners />

        <Group title="الديوان">
          <LinkRow
            icon={<ShelfMark />}
            label="المختارات المنظومة"
            note="المعلقات العشر، ومئة بيتٍ سائر"
            route={{ view: "anthology" }}
          />
          <LinkRow icon={<PoetsMark />} label="الشعراء" note="فهرسٌ على حروف الشهرة" route={{ view: "poets" }} />
          <LinkRow icon={<DayMark />} label="بيت اليوم" note="مطلعٌ واحد للناس جميعًا" route={{ view: "daily" }} />
          <LinkRow icon={<WanderMark />} label="التجوال" note="بيتٌ واحد، وثلاثة أبواب" route={{ view: "wander" }} />
          <LinkRow icon={<KeepMark />} label="المختارات" note="ما اخترته من الأبيات، ومجموعاتك" route={{ view: "favorites" }} />
          {/* Beside المختارات and not instead of it: the ♥ is this browser's
              list and works signed out; a ديوان is named, ordered, shareable
              and lives on the account. Two acts, two rows. */}
          <LinkRow
            icon={<ShelfMark />}
            label="دواويني"
            note="ما جمعتَه أنت من الأبيات، مرتَّبًا ومُسمًّى"
            route={{ view: "diwans" }}
          />
          <LinkRow icon={<StatsMark />} label="الإحصاءات" note="البحور والأعصر والقوافي، معدودة" route={{ view: "stats" }} />
        </Group>

        {/* Two rows for the reader who is WRITING rather than browsing. They
            are their own group because that is a different person at a
            different moment, and «الصنعة» is the word the قدماء used for it —
            صناعة الشعر, the craft under the poems. */}
        <Group title="الصنعة">
          <LinkRow
            icon={<BuhurMark />}
            label="بحور الشعر"
            note="الستة عشر بتفعيلاتها ومفاتيحها، وشاهدٌ على كلٍّ منها"
            route={{ view: "buhur" }}
          />
          <LinkRow
            icon={<QafiyaMark />}
            label="باحث القافية"
            note="اختر الرويّ، فنُريك ما قافاه به الفحول"
            route={{ view: "qafiya", query: {} }}
          />
        </Group>

        <Group title="اللعب">
          <LinkRow
            icon={<RulesMark />}
            label="كيف تتم المساجلة"
            note="كيف يُشتقّ الرويّ، وما يُقبل وما يُردّ"
            route={{ view: "rules" }}
          />
        </Group>

        <AccountGroup />

        <Group title="عن قريض">
          <LinkRow icon={<ShieldMark />} label="سياسة الخصوصية" route={{ view: "privacy" }} />
          <li className="morerow-slot morerow-slot--about">
            <div className="moreabout">
              <p className="moreabout__name">
                <span>قريض — ديوان الشعر العربي ومساجلته</span>
                {/* an ASCII version string inside an RTL line needs its own run */}
                <bdi className="moreabout__v" dir="ltr">
                  {__APP_VERSION__}
                </bdi>
              </p>
              <p className="moreabout__line">
                المتن من مجموعة <bdi dir="ltr">arbml/ashaar</bdi> المفتوحة، جُمعت من الدواوين المنشورة على الشابكة.
                القصائد وأصحابها لأهلها، وهذا فهرسٌ لها لا أكثر.
              </p>
              <p className="moreabout__line">
                {/* The Latin family name is its own LTR run AND unbreakable:
                    without the run the واو before it is dragged to the far end
                    of the line, and without the nowrap the phrase breaks at its
                    own spaces and «Arabic» lands alone on the next line, which
                    reads as two different faces. */}
                الخطوط: أميري للبيت، وعارف رقعة للعناوين، و
                <bdi className="moreabout__face" dir="ltr">
                  IBM Plex Sans Arabic
                </bdi>{" "}
                للواجهة.
              </p>
              <div className="moreabout__install">
                <InstallControl />
              </div>
            </div>
          </li>
        </Group>
      </div>
    </div>
  )
}
