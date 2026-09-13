# EmpireVu Mobile (iOS + Android)

The native app for EmpireVu, built from the Claude Design handoff (`EmpireVu Mobile.dc.html`).
It is a [Capacitor 8](https://capacitorjs.com) shell around a React bundle that ships inside
the app, talking to the same Next.js API and Supabase project as the web app.

- **Shared data layer.** `@/lib/api-client` resolves to the repo's `src/lib/api-client.ts`, so
  request and response types never drift between web and mobile. The mobile app points it at
  `VITE_API_BASE_URL` and authenticates with the Supabase access token (`Authorization: Bearer`).
- **Navigation.** Five tabs (Home, Inbox, Calendar, Tasks, More), each with its own stack.
  Org/company scope is persistent and every query is scoped by it.
- **Native features.** Push notifications, Face ID / Touch ID / fingerprint unlock, job photos
  with an offline upload queue, on-device dictation (voice note → task), system dialer, Messages
  and Mail.

```
mobile/
  src/            React app (screens/, state/, ui/, lib/)
  android/        Android Studio project (committed)
  ios/            Xcode project (committed; Swift Package Manager, no CocoaPods)
  assets/         Icon + splash sources for @capacitor/assets
```

## Local development

```bash
cd mobile
cp .env.example .env        # VITE_API_BASE_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm install
npm run dev                 # browser preview on :5174 (native plugins fall back or no-op)
npm run typecheck && npm test
```

Run on a device: `npm run sync`, then `npm run open:android` (Android Studio) or
`npm run open:ios` (Xcode, macOS only).

Regenerate icons and splash screens after changing `assets/`: `npm run assets`.

## Backend prerequisites (one-time, before the first build ships)

1. **Deploy the API changes on this branch.** The server now accepts Bearer tokens and sends
   CORS headers for `capacitor://localhost` and `https://localhost`. Nothing works from the app
   without it.
2. **Apply the migration** `supabase/migrations/20260913120000_mobile_app.sql`. It adds
   `device_tokens`, `notification_preferences`, `job_photos` and the private `job-photos` bucket.
3. **Supabase Auth → URL Configuration → Redirect URLs:** add `com.empirevu.app://auth-callback`.
   Password reset, email confirmation, Google and Apple sign-in all return through it.
4. **Sign in with Apple.** The iOS app offers Google sign-in, so App Store Guideline 4.8 requires
   Sign in with Apple as well. Enable the Apple provider in Supabase Auth: Services ID, key and
   team ID from the Apple Developer portal.
5. **Push credentials on the web and worker services** (see the root `.env.example`):
   - iOS: create an APNs auth key (.p8) and set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`,
     `APNS_BUNDLE_ID=com.empirevu.app`, and `APNS_PRODUCTION=true`.
   - Android: create a Firebase project with Android app `com.empirevu.app`. Set
     `FCM_SERVICE_ACCOUNT_JSON` on the server and put `google-services.json` in
     `android/app/` (it is git-ignored).

   Without these the app still works; pushes are simply not sent.

## Android → Google Play

Requirements: JDK 21 and the Android SDK (API 36). Android Studio installs both.

1. Create an upload key once and keep it safe:
   `keytool -genkeypair -v -keystore upload.keystore -alias empirevu -keyalg RSA -keysize 2048 -validity 10000`
2. Create `android/keystore.properties` (git-ignored):
   ```
   storeFile=/absolute/path/upload.keystore
   storePassword=…
   keyAlias=empirevu
   keyPassword=…
   ```
3. Build: `npm run sync`, then `cd android && ./gradlew bundleRelease`. The bundle is written to
   `android/app/build/outputs/bundle/release/app-release.aab`.
4. Play Console:
   - Create the app with package `com.empirevu.app` and enroll in Play App Signing.
   - Upload the AAB to Internal testing first.
   - **Data safety:** declare collection of name, email and phone (account management and app
     functionality), photos (job photos), app activity (in-app actions) and device IDs (push token).
     Data is encrypted in transit, not sold, and not shared for advertising. Users can request
     deletion.
   - **Account deletion:** in-app at More → Settings → Delete account. Play also requires a web
     URL for deletion requests; point it at your support or privacy page.
   - Complete the privacy policy URL, content rating questionnaire, target audience (18+,
     business) and store listing.
   - Screenshots: phone at 1080×1920 or higher, at least 2.
   - The Android versionCode must increase with every upload (CI uses the run number via
     `ANDROID_VERSION_CODE`).

## iOS → App Store

Requirements: a Mac with Xcode 16 or newer, and an Apple Developer Program membership.

1. `npm run sync`, then `npm run open:ios`.
2. Target **App** → *Signing & Capabilities*:
   - Choose your Team.
   - Keep **Push Notifications**; the entitlement is already in `App/App.entitlements`.
   - Add **Background Modes → Remote notifications** if Xcode doesn't pick it up from `Info.plist`.
3. In the Apple Developer portal, register App ID `com.empirevu.app` with Push Notifications and
   Sign in with Apple.
4. *Product → Archive → Distribute App → App Store Connect.* Test through TestFlight before
   submitting.
5. App Store Connect:
   - **App Privacy:** Contact Info (name, email, phone), User Content (photos, other user content)
     and Identifiers (device ID). All are linked to the user, used only for app functionality,
     and not used for tracking. This matches `App/PrivacyInfo.xcprivacy`.
   - **Review notes:** provide a demo account with an organization that has data. Explain that
     EmpireVu is a business tool sold to organizations, and that billing is not offered in the app.
   - Screenshots: 6.9" (1320×2868) and 6.5" (1284×2778) iPhone. The app is iPhone-only.
   - Export compliance: `ITSAppUsesNonExemptEncryption` is `false` (standard HTTPS only).

## CI

`.github/workflows/mobile.yml` typechecks, tests and builds the bundle. It then builds Android
(a signed AAB when the signing secrets exist, a debug APK otherwise) and iOS (a signed IPA when
the signing secrets exist, a simulator compile otherwise). The required variables and secrets
are listed at the top of the workflow.

## Store-policy decisions baked into the app

- **Account deletion** is available in-app (Apple 5.1.1(v), Google Play). If the user is the only
  owner of a team, deletion is refused until ownership is transferred. If the user is the only
  member of an organization, deletion also removes that organization, after an explicit second
  confirmation.
- **Billing is read-only.** No plan purchases, upgrade links or billing-portal links, because of
  Apple 3.1.1 and Google Play's payments policy. Stripe Connect and quote deposits stay: they pay
  for real-world services, which both stores permit outside in-app purchase.
- **Sign in with Apple** is shown on iOS whenever Google sign-in is (Apple 4.8).
- **Permissions** are requested only when first used (camera, microphone and speech, notifications),
  and each has a purpose string.
- **Backups:** app data is excluded from Android backups, and the session lives in the
  Keychain/Keystore.

## Known limitations

- **Biometric unlock** gates a Keychain/Keystore-stored session at launch. It is not a
  biometry-bound key (`BiometryCurrentSet`), as the handoff describes. The password path is
  always available.
- **Voice notes** use on-device recognition. No audio is uploaded or retained, so there is no
  recording linked to the task. Moving to server-side Whisper, as the handoff recommends, needs
  an OpenAI key and a `voice-notes` bucket.
- **Push categories:** only leads (new lead, urgent or completed call, inbound text) and payments
  (quote approved or paid) are emitted today. AI-draft, schedule-conflict, workflow-failure and
  daily-digest pushes need the server to emit those events; their preference toggles are stored
  already.
- **Marina calls** are placed server-side (Retell/Cartesia). The app follows the outcome; it is not
  a CallKit/VoIP call. Call and Text on a record open the system dialer and Messages.
- **Quote builder** creates hand-priced lines. Catalog-priced services (hull length, engines) are
  still built on the web.
- **Jobber connection** (OAuth) and intake-key creation happen on the web.
- **Public quote and booking pages** stay web pages, sent to customers who don't have the app.
- **Light theme** is not shipped. The app is dark-only, like the web app.
- **Offline photo uploads** drain while the app is open, not in the background.
