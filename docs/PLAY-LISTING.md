# Google Play listing

Everything a Play Console submission needs that can be settled from the
repository: the copy, the questionnaire answers, the assets, and the build. What
needs a Google account, money, or the signing key is listed at the end as
manual — this file cannot do those.

Where a Play question turns on Play's own definitions rather than on a fact
about the app, this file states the fact and says which way it points.

## The build

Play takes an **Android App Bundle**, not an APK:

```sh
VITE_API_BASE=<PUBLIC_ORIGIN> npm run build     # the shell's API origin is baked in HERE
QARID_APP_ID=<your package id> npx cap sync android
cd android && ./gradlew bundleRelease
# → android/app/build/outputs/bundle/release/app-release.aab
```

`VITE_API_BASE` has no default. A bundle built without it has a shell that
talks to nothing; check the built JS names your host before you upload:

```sh
unzip -p android/app/build/outputs/bundle/release/app-release.aab 'base/assets/public/assets/index-*.js' | grep -c '<your host>'   # > 0
```

Signed with the key in `android/keystore.properties` (gitignored — see
`build.gradle`), which becomes the **upload key** once Play App Signing is on;
Play re-signs for distribution with a key it holds. Identity comes from
`android/identity.properties` (gitignored; `identity.properties.example` shows
the keys), the version from `android/version.properties` (tracked):

- **`versionCode` must go up on every upload.** Play refuses a bundle whose
  code is not above the last it accepted. Bump it in `version.properties`;
  nothing else needs editing.
- `targetSdkVersion` is 36 (`android/variables.gradle`), above Play's current
  floor for new apps. `minSdkVersion` 24.
- The bundle is 64-bit clean by construction: a Capacitor app ships no native
  code of its own.

Verify before uploading:

```sh
jarsigner -verify android/app/build/outputs/bundle/release/app-release.aab   # "jar verified."
```

## Assets

All under [`media/store/`](media/store/):

| Asset | File | Size | Play's rule |
|---|---|---|---|
| App icon | `icon-512.png` | 512 × 512 | 512 × 512 PNG |
| Feature graphic | `feature-graphic.png` | 1024 × 500 | exactly 1024 × 500 |
| Phone screenshots ×6 | `phone-1-home.png` … `phone-6-diwans.png` | 780 × 1560 | each side 320–3840 px, long side ≤ 2× short |

The screenshots are the smoke walk's phone captures (`tools/screenshot.mjs
--mobile`, a 390-wide DPR-2 device with `hasTouch`) cropped from 780 × 1688 to
2:1 — the raw capture is 2.16:1, which the Console refuses. No frames, no
overlays, no captions burned in. Upload order and what each shows:

1. `phone-1-home` — بيت اليوم and the doors under it.
2. `phone-2-poem` — a قصيدة as a ديوان page.
3. `phone-3-duel-play` — a مساجلة in progress.
4. `phone-4-poets` — the شعراء index on حروف الشهرة.
5. `phone-5-buhur` — the sixteen بحور.
6. `phone-6-diwans` — a reader's دواوين.

Regenerate after a visual change:

```sh
npm run build && node tools/screenshot.mjs --no-build --mobile
for s in home poem duel-play poets buhur diwans; do
  magick screenshots/$s-390.png -gravity center -crop 780x1560+0+0 +repage docs/media/store/phone-N-$s.png
done
magick docs/media/banner.png -resize 1024x -gravity center -crop 1024x500+0+0 +repage docs/media/store/feature-graphic.png
```

## Copy

Arabic, in the register of the app's own strings. Numbers Western, as
everywhere in the app.

### App name (30 max)

```
قَريض
```

### Short description (80 max)

```
ديوان الشعر العربي: ثلاثة ملايين بيت تُقرأ وتُبحث، ومساجلةٌ على الرويّ
```

### Full description (4000 max)

```
قَريض اسمٌ قديمٌ للشعر. وهذا ديوانٌ للشعر العربيّ يُقرأ ويُبحث فيه، ومساجلةٌ تُلعب عليه.

3,369,701 بيتًا لـ6,941 شاعرًا: تُتصفَّح بالعصر والبحر والغرض والرويّ، ويُبحث فيها بتشكيلٍ وبغيره، وتُقرأ القصيدةُ صفحةً كما تُطبع أو في وضع قراءةٍ تنزوي فيه الأدواتُ كلُّها.

المساجلة
يُلقي الحاسوبُ بيتًا، ويُجاب ببيتٍ آخرَ من الديوان يبدأ برويِّ الأوّل. الحكمُ على مذهب القدماء، ولا يُقبل القريب. ضدّ الديوان بعدٍّ ووقت، وتُضيَّق بعصرٍ أو بحرٍ أو شاعر — أو ضدّ صديقٍ في غرفة.

الحفظ
المختاراتُ قائمةٌ على الجهاز بلا حساب. والدواوينُ رفوفٌ مُسمّاةٌ مرتَّبةٌ على حساب: تُجمَع، وتُرتَّب باليد، وتُشارَك، وتُلعب فيها المساجلة.

التحفيظ
تمرينٌ على القصيدة حتى تثبت، وعدٌّ لما صار يُجاب عليه من الحروف.

بلا إعلانات، وبلا تتبّع، وبلا بريد. الحسابُ للمساجلة مع صديقٍ باسمك ولصفحةٍ تحملُه، لا غير — وحذفُه بيدك من داخل التطبيق.

المتنُ من arbml/ashaar. والمصدرُ مفتوح: github.com/ZahakJ/qarid
```

### Category

**Books & Reference.** (Not Education — there is a drill, but the thing is a
ديوان first. Not Games — the مساجلة is one door of six.)

### Tags

Arabic poetry · poetry · literature · Arabic · classical Arabic · quiz

### Contact and links

| Field | Value |
|---|---|
| Website | `PUBLIC_ORIGIN` of your deployment |
| Privacy policy | `PUBLIC_ORIGIN/#/privacy` — the in-app page, Arabic, and it names the deletion URL |
| Email | the address in `client/views/PrivacyView.tsx`'s `OWNER_CONTACT` — **must be filled before submitting** |

## Data safety

The answers are already worked out, row by row, in
[`legal/data-safety.md`](legal/data-safety.md). Summary of what they come to:

- Collects: username (required), display name (optional), avatar (optional),
  gameplay/room history. Password stored as a scrypt hash only.
- **Shares nothing.** No ads SDK, no analytics, no third-party service.
- Encrypted in transit: yes (HTTPS only; the native shell uses a bearer token
  over the same origin).
- Deletion: self-serve, in-app **and** at a web URL (the profile page), immediate
  and irreversible — both of which Play's form asks for.
- IP address: processed ephemerally for rate-limiting; not stored per user.

## Content rating (IARC questionnaire)

The app is a poetry corpus and a rhyme game. Expected outcome: **Everyone /
PEGI 3**. The questions and the fact that answers each:

| Question | Answer | Fact |
|---|---|---|
| Violence, sexual content, drugs, gambling | No | None depicted. The corpus is classical literature and some of it is about wine and war, as literature is — Play's rating questions are about *depicted* content in the app, not a library's subject matter. If the reviewer disagrees, answer «references to» and accept a Teen rating. |
| User-generated content / users interact | **Yes** | Two readers can play a مساجلة in a room, and can name a ديوان. There is a report-and-block system (`server/routes/moderation.ts`) and a display-name/description moderation path — say so in the "how is it moderated" field. |
| Users can share their location | No | No location anywhere. |
| Purchases, ads, digital goods | No | None. |

## App content declarations

| Declaration | Answer |
|---|---|
| Ads | No ads |
| Target audience | 13+ (an account can be created; no child-directed content) — **not** "designed for children" |
| News app | No |
| COVID-19 contact tracing | No |
| Government app | No |
| Financial features | None |
| Health | None |
| Data safety | per `legal/data-safety.md` |
| App access | Most of the app needs no account. For the parts that do (rooms, دواوين), give the reviewer a test account — create one on your deployment and put its username/password in the "App access" instructions. |
| Account deletion URL | `PUBLIC_ORIGIN/#/u/<username>` → «احذف حسابي» |

## What remains manual

In order:

1. **A Play developer account** — one-time fee, identity verification.
   Individual accounts registered since late 2023 must run a **closed test
   with at least 12 testers for 14 continuous days** before they may request
   production access; plan for that.
2. **Fill the two owner blanks** in `client/views/PrivacyView.tsx`
   (`OWNER_CONTACT`, `OWNER_JURISDICTION`) and redeploy, so the privacy page
   Play links to is complete.
3. **Create the app** in the Console (default language Arabic — `ar`), paste
   the copy above, upload the assets.
4. **App content**: privacy policy URL, data safety (from `legal/data-safety.md`),
   content rating, target audience, ads, app access (with a test account).
5. **Play App Signing**: accept it on first upload; the key in
   `keystore.properties` becomes the upload key. Then re-check the
   `assetlinks.json` fingerprint — Play's *distribution* certificate differs from
   your upload key, and App Links verify against the certificate on the
   installed APK. Take the SHA-256 from Console → Setup → App signing and set
   `ANDROID_CERT_SHA256` to it on the server.
6. **Upload the AAB** to a closed testing track, add testers, wait out the 14
   days, then apply for production.
7. On every later release: bump `versionCode` in `android/version.properties`,
   `bundleRelease`, upload.
