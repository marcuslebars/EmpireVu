/**
 * Account deletion — /delete-account
 *
 * Google Play requires a publicly reachable page describing how to delete an account and
 * what is removed, in addition to the in-app route. Public and unauthenticated by design:
 * someone who can no longer sign in still has to be able to find this.
 */

import { platformBrand } from "@/lib/platform-brand";

const CONTACT_EMAIL = platformBrand.supportEmail;
const PRODUCT = platformBrand.name;

export default function DeleteAccountPage() {
  return (
    <main className="min-h-screen bg-background px-5 py-10">
      <article className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-foreground">Delete your {PRODUCT} account</h1>
          <p className="text-sm text-muted-foreground">
            You can do this yourself in the app, or ask us to do it for you.
          </p>
        </header>

        <section className="flex flex-col gap-3 rounded-xl border border-border bg-secondary p-5">
          <h2 className="text-lg font-semibold text-foreground">In the app</h2>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>Open the {PRODUCT} app and sign in.</li>
            <li>
              Go to <span className="text-foreground">More → Settings</span>.
            </li>
            <li>
              Tap <span className="text-foreground">Delete account</span> and confirm.
            </li>
          </ol>
          <p className="text-sm leading-relaxed text-muted-foreground">
            If you are the only owner of a team, you will be asked to hand ownership to someone else
            first, so the rest of the team does not lose access. If you are the only member of an
            organization, deleting your account removes that organization too — you will be asked to
            confirm that separately.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-foreground">By email</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Write to{" "}
            <a className="text-primary underline" href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Delete my ${PRODUCT} account`)}`}>
              {CONTACT_EMAIL}
            </a>{" "}
            from the address on your account, with the subject "Delete my {PRODUCT} account". We will
            confirm before anything is removed, and complete it within 30 days.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-foreground">What is deleted</h2>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>Your profile: name, email address, phone number and sign-in credentials.</li>
            <li>Your membership of every organization, and your access to their data.</li>
            <li>The push notification tokens for your devices, so alerts stop immediately.</li>
            <li>
              Where you were the only member of an organization: that organization's contacts,
              bookings, tasks, quotes and job photos.
            </li>
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-foreground">What is kept, and why</h2>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>
              Records belonging to an organization that still has other members — its contacts,
              bookings and quotes stay with the business, which owns them.
            </li>
            <li>
              Invoices and payment records, which tax and accounting law requires us to retain. These
              are kept for the statutory period and are not deleted on request.
            </li>
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Everything else is removed. Deletion is permanent — we cannot restore an account
            afterwards.
          </p>
        </section>

        <footer className="border-t border-border pt-5 text-sm text-muted-foreground">
          Questions:{" "}
          <a className="text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          · <a className="text-primary underline" href="/privacy">Privacy Policy</a>
        </footer>
      </article>
    </main>
  );
}
