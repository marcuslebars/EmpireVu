# Store submission — EmpireVu Mobile

Everything needed to put the app in front of Google Play and App Store review, in the order
it's needed. Listing copy is a starting point, written to be true of the app as it exists —
edit the voice, not the claims.

Package / bundle id: `com.empirevu.app` (permanent once published to either store).

---

## 1. Blocking prerequisites

Nothing can be submitted until these exist. Everything here is an account or a key, so it has
to be done by an owner of the business, not by CI.

| # | What | Where | Blocks |
|---|---|---|---|
| 1 | Google Play Console account (one-off $25) | play.google.com/console | Android |
| 2 | Apple Developer Program ($99/yr) | developer.apple.com | iOS |
| 3 | Upload keystore + the four signing secrets in GitHub | local `keytool`, then repo secrets | Android release build |
| 4 | Firebase project with an Android app for `com.empirevu.app` → `google-services.json` + a service-account JSON | console.firebase.google.com | Android push |
| 5 | APNs auth key (.p8) with its key id and team id | Apple Developer → Keys | iOS push |
| 6 | Privacy policy URL live | `https://app.empirevu.com/privacy` (ships with PR #95) | both |
| 7 | Account-deletion URL live | `https://app.empirevu.com/delete-account` (same PR) | Play |
| 8 | Screenshots on a demo org (see §4) | — | both |

### 3 — the upload key, step by step

Run this once, keep the file and the passwords somewhere permanent. Losing this key means
never being able to update the app under this listing again.

```bash
keytool -genkeypair -v -keystore upload.keystore -alias empirevu -keyalg RSA -keysize 2048 -validity 10000
```

Then add four repository secrets in GitHub (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 upload.keystore` (on Windows: `certutil -encode`, then strip the header/footer lines) |
| `ANDROID_KEYSTORE_PASSWORD` | the store password you chose |
| `ANDROID_KEY_ALIAS` | `empirevu` |
| `ANDROID_KEY_PASSWORD` | the key password you chose |

Add `ANDROID_GOOGLE_SERVICES_JSON` (the whole file contents) at the same time — CI now
**fails** a signed build without it rather than shipping an app whose push silently never works.

### 4 and 5 — push credentials

On the Railway **web** and **worker** services:

```
FCM_SERVICE_ACCOUNT_JSON   # Firebase → Project settings → Service accounts → Generate key
APNS_KEY_ID
APNS_TEAM_ID
APNS_PRIVATE_KEY           # contents of the .p8, newlines preserved
APNS_BUNDLE_ID=com.empirevu.app
APNS_PRODUCTION=true
```

Until these are set the app works normally and simply sends no pushes.

---

## 2. Google Play listing

**App name (30):** EmpireVu

**Short description (80):**
> Leads, jobs, quotes and crew — the whole marina day, from your phone.

**Full description (4000):**

> EmpireVu is the operations app for marine and field-service businesses — detailing, storage,
> coatings, and the crews who do the work.
>
> **One inbox for every conversation.** Calls, texts, emails and web enquiries land in a single
> queue, with the ones waiting on a reply at the top. Nothing sits unanswered because it came
> in through the wrong channel.
>
> **Replies drafted for you.** The assistant reads the conversation and drafts a reply in your
> voice. You read it, change what you want, and send it — nothing reaches a customer until you
> approve it.
>
> **Quotes that price themselves.** Pick services from your catalog, enter the boat length, and
> the total comes back from your own pricing rules — per foot, per engine, tiered, bundled. Send
> it and take the deposit through Stripe.
>
> **The day's jobs, and the crew on them.** See what's booked, who's assigned and where the
> conflicts are. Reschedule from the calendar, assign a task, and everyone sees it.
>
> **Photos from the job, even with no signal.** Shoot before-and-after photos on the boat; they
> upload themselves when you're back in coverage and file against the booking.
>
> **Voice notes become tasks.** Talk, and the note turns into a task on the right job. Speech is
> transcribed on the device — no recording is uploaded.
>
> **Alerts worth the interruption.** New leads, approved quotes, deposits paid, schedule
> conflicts, and a morning digest. Every category is a switch, with quiet hours you set.
>
> EmpireVu requires an account. It is sold to businesses; plans and billing are managed on the
> web.

**Category:** Business · **Tags:** business management, CRM, field service
**Contact:** hello@empirevu.com · **Privacy policy:** https://app.empirevu.com/privacy

### Data safety form

Answer it this way — these match what the code actually sends.

| Question | Answer |
|---|---|
| Does the app collect or share user data? | Yes, collects. **No** sharing with third parties for their own use. |
| Is data encrypted in transit? | Yes |
| Can users request deletion? | Yes — in app, and at https://app.empirevu.com/delete-account |

| Data type | Collected | Purpose | Required? |
|---|---|---|---|
| Name, email address, phone number | Yes | App functionality, account management | Required |
| Other user content (contacts, bookings, quotes, messages, notes) | Yes | App functionality | Required |
| Photos | Yes | App functionality (job records) | Optional |
| Voice / audio | **No** | Dictation is transcribed on-device; no audio leaves the phone | — |
| App activity (in-app actions) | Yes | App functionality, analytics | Required |
| Device or other IDs | Yes | App functionality (push delivery) | Optional |
| Location | **No** | Not collected; photo metadata is stripped on upload | — |
| Financial info | **No** | Payments go through Stripe; card data never reaches the app | — |

Declare **no** data sold, **no** data shared for advertising, **no** tracking for ads.

### Content rating questionnaire

Business app, no user-generated public content, no ads, no gambling, no violence. Target
audience 18+. Expect "Everyone" / PEGI 3.

---

## 3. App Store Connect listing

**Name:** EmpireVu · **Subtitle (30):** Run the marina day
**Keywords (100):** marine,boat,detailing,storage,field service,crm,quotes,scheduling,leads,crew
**Support URL:** https://empirevu.com · **Privacy policy:** https://app.empirevu.com/privacy
**Description:** reuse the Play full description above.

**App privacy (nutrition labels):** Contact Info (name, email, phone), User Content (photos,
other), Identifiers (device ID), Usage Data (product interaction) — all *linked to the user*,
all "App Functionality", **none** used for tracking. This matches `ios/App/App/PrivacyInfo.xcprivacy`.

**Age rating:** 17+ is unnecessary; rate 4+ with no objectionable content. Business tool.

**Review notes — this is what gets apps rejected, so be explicit:**

> EmpireVu is sold to marine-services businesses and requires an account tied to an
> organization. Demo account: <email> / <password>. It has an organization with sample leads,
> bookings and quotes so every screen has data.
>
> Billing is deliberately read-only in the app: plans are purchased on the web, and nothing
> inside the app unlocks digital content. Stripe is used only for deposits on real-world
> services (boat detailing, winter storage), which Guideline 3.1.3(e) permits outside in-app
> purchase.
>
> Account deletion is in the app at More → Settings → Delete account.

Create that demo account before submitting. Reviewers reject on a login wall they can't pass.

---

## 4. Screenshots

Play: at least 2 phone screenshots, 1080×1920 or larger. Apple: 6.9" (1320×2868) and
6.5" (1284×2778).

**Take them on a demo organization, not a real one.** The obvious screens — Home, Inbox, a
lead, the calendar, the quote builder — all show customer names, phone numbers and email
addresses. Those go in a public store listing that anyone can read.

The emulator already set up for this is `ev_test` (Pixel 6, Android 15), which produces
1080×2400 — over the Play minimum:

```bash
"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" exec-out screencap -p > shot.png
```

Suggested set, in this order: Command Center (the day at a glance) · Inbox with replies
waiting · A lead with a drafted reply · Quote builder with live totals · Calendar day with
crew · Job photos.

---

## 5. Release build and upload

```bash
cd mobile
npm ci && npm run build && npx cap sync android
cd android && ANDROID_VERSION_CODE=1 ./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab
```

CI does the same on every push to `main` and uploads the AAB as an artifact, using the run
number as the version code. `ANDROID_VERSION_CODE` is now mandatory for release builds — a
build without it fails rather than producing versionCode 1 that Play rejects.

Upload the first build to **Internal testing**, install from the Play link on a real phone,
and check the things an emulator can't: push arrives, the camera behaves, and Google sign-in
completes in the system browser.

iOS is built by the `ios` job in `.github/workflows/mobile.yml` once the five `IOS_*` secrets
exist; there's no Mac needed in the loop.

---

## 6. Known review risks

| Risk | Where it stands |
|---|---|
| **Apple 4.8 — Sign in with Apple** | Required because the app offers Google sign-in. The button is in the app; the Apple provider must be enabled in Supabase Auth, with a Services ID, key and team id, or sign-in fails at review. |
| **Apple 5.1.1(v) — account deletion** | In the app, and a public URL. Done. |
| **Play — data safety accuracy** | Declare photos and device IDs. Under-declaring is the usual rejection. |
| **Large-screen layout** | `screenOrientation="portrait"` is ignored at targetSdk 36 on tablets, so Play's pre-launch report will screenshot a stretched layout. Not a rejection, but it will appear in the report. |
| **Background location / audio** | Neither is used. If a reviewer asks, dictation is on-device and photos have their metadata stripped. |
