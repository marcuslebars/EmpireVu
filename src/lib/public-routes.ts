/**
 * Routes a signed-out visitor is SUPPOSED to reach.
 *
 * On these pages the token in the URL is the credential; an account is not.
 * Sending someone here to sign in is not a security boundary — the real one is
 * server-side in the API routes — it just makes the page unusable for the only
 * people it exists for.
 *
 * Kept beside the redirects it guards rather than imported from the router, so
 * adding a public route and forgetting this list is a visible omission in one
 * file instead of a silent redirect in another.
 */
const PUBLIC_PATHS: RegExp[] = [
  /^\/q\//, // customer quote — the deposit link
  /^\/i\//, // customer invoice — the pay page
  /^\/book\//, // public booking
  /^\/f\//, // hosted website lead form (also the /embed/v1.js iframe)
  /^\/invite\//, // team invitation, which prompts sign-in itself when needed
  /^\/welcome\/crankleads\/?$/, // CrankLeads purchase landing — the buyer has no session yet
  // Set-password / recovery links (incl. the CrankLeads welcome email). The page verifies
  // the link's token itself and sends a visitor without one to sign-in.
  /^\/update-password\/?$/,
  // Store-review pages: Google Play and the App Store open these signed out and reject
  // the listing if they land on a sign-in form. Exact matches — nothing under them.
  /^\/privacy\/?$/,
  /^\/delete-account\/?$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}

/** Only same-origin absolute paths ("/onboarding"), never "//host" or a full URL. */
export function safeNextPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}

const POST_AUTH_KEY = "empirevu_post_auth_path";

/**
 * Remember where a signed-out visitor was going (e.g. a setup reminder's
 * `/onboarding?step=phone&org=…` deep link) so sign-in can land them there instead of the
 * dashboard. Same-origin paths only; best-effort (sessionStorage may be unavailable).
 */
export function rememberPostAuthPath(path: string): void {
  const safe = safeNextPath(path);
  if (!safe || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(POST_AUTH_KEY, safe);
  } catch {
    /* storage unavailable — the user just lands on the dashboard */
  }
}

/** The remembered path (once — it is cleared), or null. */
export function takePostAuthPath(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(POST_AUTH_KEY);
    window.sessionStorage.removeItem(POST_AUTH_KEY);
    return safeNextPath(value);
  } catch {
    return null;
  }
}
