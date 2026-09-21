/**
 * Privacy policy — /privacy
 *
 * Public and unauthenticated: Google Play and the App Store both require a privacy policy
 * at a URL reachable without signing in, and both check it.
 *
 * It describes what this codebase actually does. When a data flow changes — a new
 * subprocessor, a new category of data, a change to retention — this page changes with it.
 * DRAFT: written from the code, not reviewed by a lawyer.
 */

const CONTACT_EMAIL = "hello@empirevu.com";
const LAST_UPDATED = "20 September 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-background px-5 py-10">
      <article className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-foreground">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground">Last updated {LAST_UPDATED}</p>
        </header>

        <Section title="Who this covers">
          <p>
            EmpireVu is business software for marine and field-service companies: a shared inbox,
            calendar, CRM, quotes and job records, on the web and in the EmpireVu mobile app.
          </p>
          <p>
            We handle two different kinds of data, and they have different rules.{" "}
            <span className="text-foreground">Account data</span> is about the businesses and people
            who use EmpireVu — we decide how that is handled, and this policy describes it.{" "}
            <span className="text-foreground">Business content</span> is what a business stores about
            its own customers — contacts, bookings, messages, quotes, job photos. That belongs to the
            business. We process it on their instructions and do not use it for our own purposes.
          </p>
        </Section>

        <Section title="What we collect">
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li>
              <span className="text-foreground">Your account:</span> name, email address, phone
              number, the organizations and companies you belong to, and your role in each.
            </li>
            <li>
              <span className="text-foreground">Business content you enter:</span> contacts and leads
              (names, phone numbers, email addresses, notes), bookings, tasks, quotes and their line
              items, comments, and messages sent or received through the app.
            </li>
            <li>
              <span className="text-foreground">Calls and messages:</span> SMS and email sent through
              EmpireVu, and records of calls placed by the AI voice agent, including outcome and
              transcript where one is produced.
            </li>
            <li>
              <span className="text-foreground">Job photos:</span> photos taken or chosen in the app
              and attached to a booking, with the caption, who took them and when.
            </li>
            <li>
              <span className="text-foreground">Device identifiers:</span> a push notification token
              per app install, its platform and app version, so alerts can reach the right device.
            </li>
            <li>
              <span className="text-foreground">App activity:</span> actions taken in the app —
              records created and changed, automation runs — kept as an activity timeline.
            </li>
            <li>
              <span className="text-foreground">Payment details:</span> handled by Stripe. Card
              numbers never reach our servers or the app.
            </li>
          </ul>
        </Section>

        <Section title="Camera, microphone and location">
          <p>
            The app asks for the camera only when you take a job photo, and for the microphone only
            when you dictate a note. Dictation is transcribed{" "}
            <span className="text-foreground">on the device</span> — no audio recording is uploaded or
            kept. Photos are re-encoded before upload, which strips the location and camera metadata
            the file arrived with. We do not track your device's location in the background.
          </p>
        </Section>

        <Section title="How it is used">
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li>To run the service: show your work, send what you ask us to send, and keep records.</li>
            <li>
              To draft replies and suggest automations with AI. The relevant lead or message content
              is sent to Anthropic's Claude API for that purpose. Drafts are proposals — nothing is
              sent to a customer until a person approves it.
            </li>
            <li>
              To send notifications you have turned on, subject to your notification preferences and
              quiet hours.
            </li>
            <li>To take payments and deposits, and to bill for EmpireVu itself.</li>
            <li>To keep the service secure, diagnose faults, and meet legal obligations.</li>
          </ul>
          <p className="text-foreground">
            We do not sell personal information. We do not use it for advertising, and we do not track
            you across other companies' apps or websites.
          </p>
        </Section>

        <Section title="Who else processes it">
          <p>These providers process data on our behalf, only to deliver the service:</p>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li>Supabase — database, file storage and sign-in</li>
            <li>Railway — application hosting</li>
            <li>Anthropic — AI drafting and automation suggestions</li>
            <li>Stripe — payments, deposits and subscriptions</li>
            <li>Twilio and Telnyx — SMS and telephony</li>
            <li>Cartesia and Retell — the AI voice agent that places and answers calls</li>
            <li>Resend — transactional email</li>
            <li>Cloudflare — bot protection on public forms</li>
            <li>Apple and Google — delivery of push notifications to your device</li>
            <li>Jobber — only if a business connects its Jobber account</li>
          </ul>
        </Section>

        <Section title="How long it is kept, and how to delete it">
          <p>
            Business content is kept while the account is open, because that is the point of the
            record. You can delete individual records in the app at any time.
          </p>
          <p>
            You can delete your own account from the mobile app: <span className="text-foreground">More
            → Settings → Delete account</span>. That removes your profile and your access. If you are
            the only owner of a team, you will be asked to transfer ownership first; if you are the
            only member of an organization, that organization and its data are removed with you.
          </p>
          <p>
            You can also ask us to delete your account by writing to{" "}
            <a className="text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
            . See <a className="text-primary underline" href="/delete-account">Delete your account</a>{" "}
            for what is removed and what we have to keep.
          </p>
          <p>
            Records we are required to keep for tax and accounting — invoices, payments — are retained
            for as long as the law requires, and are not deleted on request.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Data is encrypted in transit. Your sign-in session is held in the device's secure store
            (Keychain on iOS, Keystore on Android) rather than in ordinary app storage, and the app can
            require Face ID, Touch ID or a fingerprint before it opens. Job photos live in a private
            bucket and are served through short-lived links. Access to a business's data is limited to
            the members of that organization.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            Depending on where you live, you may have the right to see the personal information we
            hold about you, correct it, delete it, or receive a copy. Write to{" "}
            <a className="text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>{" "}
            and we will respond within the period the law allows. If your data was entered by a
            business that uses EmpireVu, we will refer you to that business, which decides what
            happens to its records.
          </p>
        </Section>

        <Section title="Children">
          <p>EmpireVu is a tool for businesses. It is not directed at anyone under 18.</p>
        </Section>

        <Section title="Changes">
          <p>
            If this policy changes in a way that affects you, we will say so in the app before the
            change takes effect. The date at the top always reflects the current version.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            EmpireVu —{" "}
            <a className="text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </Section>
      </article>
    </main>
  );
}
