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
  /^\/book\//, // public booking
  /^\/invite\//, // team invitation, which prompts sign-in itself when needed
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}
