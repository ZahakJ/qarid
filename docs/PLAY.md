# Google Play

Everything the Play Console asks for, settled from the repository. Section 1 is
the list of steps only the owner can take; the rest is what those steps paste
or upload.

## 1. Owner steps in the Play Console

1. **Developer account.** Create it (one-time fee, identity verification). A
   personal account created after November 2023 must run a closed test with at
   least 12 testers for 14 continuous days before it can apply for production.
2. **Fill the deployment's contact.** Set `PRIVACY_CONTACT` (an email address)
   in the server's `.env` and restart, so `https://<host>/privacy` names it.
   Put the same address in the contact constant at the top of
   `client/views/PrivacyView.tsx` so the in-app page matches (§6).
3. **Create the app.** All apps → Create app. Name «قَريض», default language
   Arabic (`ar`), App, Free.
4. **Store listing.** Main store listing: paste the Arabic copy (§7). Add an
   English (`en-US`) translation with the English copy. Upload the graphics
   (§8). Category *Books & Reference*; contact email; website
   `https://<host>`.
5. **App content** (Policy → App content), one by one:
   - Privacy policy: `https://<host>/privacy`.
   - App access: *All or some functionality is restricted* → give the
     reviewer a username and password for a test account created on the
     deployment (accounts are only needed for named rooms, دواوين and the
     profile page).
   - Ads: *No*.
   - Content rating: run the IARC questionnaire with the answers in §9.
   - Target audience: 13 and over; not designed for children.
   - News app: No. Government app: No. Financial features: None. Health: None.
   - Data safety: transcribe §5.
   - Data deletion: the in-app path and the URL in §5.
6. **App signing.** Release → Setup → App signing: accept Play App Signing.
   Your keystore becomes the **upload key**; keep it and its passwords backed
   up off this machine. Copy the **app signing key** SHA-256 fingerprint from
   that page and set it on the server as `ANDROID_CERT_SHA256` (with
   `ANDROID_PACKAGE`), then restart, so App Links verify against the
   certificate Play installs.
7. **Build the bundle** (§2) and check it (§2, *Verify*).
8. **Closed test.** Testing → Closed testing → Create track → upload
   `app-release.aab`, release notes from `docs/releases/`, add at least 12
   testers by email list, roll out. Keep it running 14 days.
9. **Production.** Dashboard → Apply for production. Once granted:
   Production → Create release → promote the tested bundle, countries: all,
   roll out.
10. **Every later release.** Bump the version (§3), rebuild, upload to the
    closed track first, then promote.

## 2. The build

Play takes an Android App Bundle. One command builds it, from a clean web
build in `app-web/` (gitignored) so the `dist/` a running server serves is
never touched:

```sh
export JAVA_HOME=<JDK 21> ANDROID_HOME=<Android SDK>
VITE_API_BASE=https://<host> QARID_APP_ID=<package id> tools/android-bundle.sh
# → android/app/build/outputs/bundle/release/app-release.aab
```

`VITE_API_BASE` has no default: the shell would talk to nothing. The script
refuses to finish if the bundle does not name that host, or if it is unsigned.

**Identity** — `android/identity.properties` (gitignored; keys in
`identity.properties.example`): `applicationId`, `appLinkHost`.

**Signing** — the keystore stays with the owner and never enters the
repository. The build reads each value from the first of these that has it:

| Value | `android/keystore.properties` | Gradle property | Environment |
|---|---|---|---|
| keystore path | `storeFile` | `-Pqarid.storeFile=` | `QARID_STORE_FILE` |
| keystore password | `storePassword` | `-Pqarid.storePassword=` | `QARID_STORE_PASSWORD` |
| key alias | `keyAlias` | `-Pqarid.keyAlias=` | `QARID_KEY_ALIAS` |
| key password | `keyPassword` | `-Pqarid.keyPassword=` | `QARID_KEY_PASSWORD` |

`keystore.properties`, `*.keystore` and `*.jks` are gitignored. Gradle
properties can also live in `~/.gradle/gradle.properties`. With none of them
set, the release builds unsigned.

**Verify** before uploading:

```sh
$JAVA_HOME/bin/jarsigner -verify android/app/build/outputs/bundle/release/app-release.aab   # jar verified.
```

## 3. Version

`android/version.properties` holds `versionCode` and `versionName`;
`package.json`'s `version` is the number the app shows under «عن قريض» and
moves with `versionName`.

| Release | versionCode | versionName | Contents |
|---|---|---|---|
| shipped (GitHub) | 3 | 2.1.0 | الديوان قصائد |
| first Play upload | 4 | 2.2.0 | online مساجلة without an account, بيت اليوم share page |
| each later upload | +1 | semver | |

Play refuses a bundle whose `versionCode` is not above every code it has
accepted on any track, so a rejected or abandoned upload still spends its
number. Tag `v<versionName>` on the commit the bundle was built from.

## 4. Target SDK and permissions

- `targetSdkVersion` 36, `compileSdkVersion` 36, `minSdkVersion` 24
  (`android/variables.gradle`). Play requires target 36 for new apps and
  updates from 31 August 2026.
- 64-bit: no native code of its own; the bundle has no `lib/` to check.
- Permissions in the merged manifest:

| Permission | From | Why |
|---|---|---|
| `INTERNET` | app | talks to the deployment |
| `VIBRATE` | `@capacitor/haptics` | a tap on a verdict |
| `<package>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | AndroidX core | signature-level, internal to the app |

No dangerous (runtime) permissions: no storage, camera, location, contacts,
notifications or microphone. The avatar picker uses the system file chooser.
`allowBackup` is on: Android's own backup may copy the app's local data
(favourites, تحفيظ cards, session token) to the user's Google account; that
is the user's backup, not collection by the app.

## 5. Data safety

**Does the app collect or share user data?** Collects: yes. Shares: no. No ads
SDK, no analytics SDK, no third-party service receives anything.

**Encrypted in transit?** Yes. HTTPS only; the native shell uses a bearer
token over the same origin.

**Can users request deletion?** Yes. In the app: profile → «احذف حسابي»,
confirmed with the password; immediate and irreversible. On the web:
`https://<host>/#/u/<username>` → «احذف حسابي». Data from a match without an
account is deleted on the schedule below without any request.

| Play data type | Collected | Required | Purpose | Source in the code |
|---|---|---|---|---|
| Personal info → Name | yes | optional | App functionality | display name of an account; the name typed for a match without an account |
| Personal info → User IDs | yes | required for accounts | App functionality, Account management | username |
| Photos | yes | optional | App functionality | avatar |
| App activity → In-app actions | yes | — | App functionality | match transcripts and results, streaks, published arsenal |
| App activity → Other user-generated content | yes | optional | App functionality | دواوين: title, description, chosen أبيات; reports and blocks |
| Device or other IDs | no | | | |
| Location, email, phone, address, financial, health, messages, contacts, files, calendar, audio, web history | no | | | |

- **Password**: stored only as a scrypt hash, under *User IDs / account
  management*. Recovery codes are stored hashed the same way.
- **IP address**: read at request time for rate limiting
  (`server/ratelimit.ts`), kept in memory, not stored per user. If the form
  asks, mark it *processed ephemerally*, purpose *App functionality /
  fraud prevention*.
- **Match without an account**: the name typed for it (optional), the أبيات
  exchanged and the result, and SHA-256 digests of the two seat secrets, in
  `data/qarid-matches.db`. Nothing ties it to a person or a device. A finished
  match is deleted 24 hours after it ends; an unjoined one after 30 minutes.
- Solo play, favourites and تحفيظ cards stay on the device.

## 6. Privacy policy

`https://<host>/privacy` — a static Arabic page served by the server
(`client/public/privacy.html`), readable without JavaScript, the URL for the
Play form. `#/privacy` is the same text inside the app. The contact line comes
from `PRIVACY_CONTACT`; while it is unset the line is left out.

## 7. Store listing

Numbers are Western digits, as in the app.

### Arabic (default)

**Name** (30)

```
قَريض
```

**Short description** (80)

```
ديوان الشعر العربي: ثلاثة ملايين بيت تُقرأ وتُبحث، ومساجلةٌ على الرويّ
```

**Full description** (4000)

```
قَريض اسمٌ قديمٌ للشعر. وهذا ديوانٌ للشعر العربيّ يُقرأ ويُبحث فيه، ومساجلةٌ تُلعب عليه.

3,369,701 بيتًا لـ6,941 شاعرًا: تُتصفَّح بالعصر والبحر والغرض والرويّ، ويُبحث فيها بتشكيلٍ وبغيره، وتُقرأ القصيدةُ صفحةً كما تُطبع أو في وضع قراءةٍ تنزوي فيه الأدواتُ كلُّها.

المساجلة
يُلقى بيتٌ، ويُجاب ببيتٍ من الديوان يبدأ برويِّ الأوّل. الحكمُ على مذهب القدماء، ولا يُقبل القريب. ضدّ الديوان بعدٍّ ووقت، أو ضدّ صديقٍ في مكانٍ آخر برابطٍ يُرسَل إليه، بلا حساب.

بيت اليوم
بيتٌ كلَّ يوم، يُشارَك رابطًا وبطاقة.

الحفظ
المختاراتُ على الجهاز بلا حساب. والدواوينُ رفوفٌ مُسمّاة على حساب: تُجمَع وتُرتَّب وتُشارَك وتُلعب فيها المساجلة.

التحفيظ
تمرينٌ على القصيدة حتى تثبت.

بلا إعلانات، وبلا تتبّع، وبلا بريد. وحذفُ الحساب بيدك من داخل التطبيق.

المتنُ من arbml/ashaar. والمصدرُ مفتوح: github.com/ZahakJ/qarid
```

### English (en-US)

**Name** (30)

```
Qarid — Arabic Poetry
```

**Short description** (80)

```
3 million lines of classical Arabic poetry to read, search and duel on rhyme
```

**Full description** (4000)

```
Qarid is an old Arabic word for poetry. This is a diwan of Arabic verse to read and search, and a game played on it.

3,369,701 lines by 6,941 poets. Browse by era, metre, theme and rhyme letter; search with or without vowel marks; read a poem as a printed page or in a reading mode with every control out of the way.

Musajala
A line is recited; you answer with another line from the corpus that begins with the rhyme letter of the first. Judged the classical way, near-misses not accepted. Play against the corpus, or against a friend elsewhere through a link, no account needed.

Line of the day
One line each day, shared as a link and a card.

Collections
Favourites live on the device without an account. With an account, build named diwans: collect lines, order them, share them, play a musajala inside them.

Memorize
Drill a poem until it stays.

No ads, no tracking, no email. Delete your account yourself, inside the app.

The interface is in Arabic. Corpus: arbml/ashaar. Source: github.com/ZahakJ/qarid
```

**Tags**: Arabic poetry · poetry · literature · Arabic · classical Arabic · word game

## 8. Graphics

All in [`media/store/`](media/store/).

| Asset | File | Play's rule |
|---|---|---|
| App icon | `icon-512.png` | 512 × 512, 32-bit PNG with alpha, ≤ 1 MB |
| Feature graphic | `feature-graphic.png` | 1024 × 500, JPEG or 24-bit PNG, no alpha |
| Phone screenshots | `phone-*.png` | 2–8, each side 320–3840 px, long side ≤ 2 × short; 1080 × 1920 here |

Upload in this order:

1. `phone-1-home` — بيت اليوم and the doors under it.
2. `phone-2-poem` — a قصيدة as a page.
3. `phone-3-match` — joining a friend's مساجلة from a link, no account.
4. `phone-4-day` — بيت اليوم by date, with «شارك».
5. `phone-5-poets` — the شعراء by letter and era.
6. `phone-6-buhur` — the sixteen بحور.

Regenerate after a visual change: build in a separate worktree (its own
`dist/`), run its server on a spare port against the real corpus, and capture
each route at 360 × 640, DPR 3, with touch, so the phone chrome is on:

```sh
PORT=5790 DB_PATH=<checkout>/data/qarid.db USERS_DB_PATH=.scratch/users.db \
  MATCHES_DB_PATH=.scratch/matches.db node server/index.ts &
```

then any headless Chromium with viewport 360 × 640, `deviceScaleFactor: 3`,
`isMobile` and `hasTouch` (Playwright's `newPage` options) on each route.

The match shot opens the share link of a match created with
`POST /api/match`.

## 9. Content rating and declarations

IARC questionnaire, expected result *Everyone / PEGI 3*:

| Question | Answer | Why |
|---|---|---|
| Violence, sexual content, drugs, gambling, profanity | No | none is depicted; the corpus is classical literature |
| Users interact or exchange content | Yes | two players exchange أبيات in a match; a name typed for a match without an account is shown only to the opponent; account names, avatars and دواوين are visible; report and block are in the app (`server/routes/moderation.ts`), and an admin can remove an avatar or a display name |
| Shares location | No | |
| Digital purchases | No | |

| Declaration | Answer |
|---|---|
| Ads | No |
| Target audience | 13+, not designed for children |
| App access | test account in the instructions |
| Account deletion URL | `https://<host>/#/u/<username>` → «احذف حسابي» |
