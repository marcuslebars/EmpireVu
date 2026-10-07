/**
 * What a CUSTOMER sees when a request from a public page (quote approval, invoice
 * payment) fails.
 *
 * The server only sends messages written for people (see handleRoute), but a public
 * page is the last line: a proxy error page, an older server, or a message that
 * somehow carries an id or a stack must never reach a customer. So a server message
 * is shown only when it looks like a sentence meant for them; anything else becomes
 * the page's own fallback, with the error reference (if the server gave one) so
 * support can find the log line.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TECHNICAL_RE = /(^API error \d+)|(\bat \S+:\d+)|[{}<>]|\b(stripe|supabase|postgres|sql|undefined|null|TypeError|ECONN\w*)\b|\bcs_(test|live)_|\bacct_|\bpi_\w{6,}/i;

export function looksCustomerSafe(message: string): boolean {
  const m = message.trim();
  return m.length > 0 && m.length <= 300 && !UUID_RE.test(m) && !TECHNICAL_RE.test(m);
}

export function customerSafeMessage(status: number, body: unknown, fallback: string): string {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; errorId?: unknown };
  const message = typeof b.error === "string" ? b.error : "";
  const errorId = typeof b.errorId === "string" && /^[a-z0-9]{4,16}$/i.test(b.errorId) ? b.errorId : null;

  // A 500 is, by definition, something we didn't write a message for.
  if (status !== 500 && message && looksCustomerSafe(message)) return message;
  return errorId ? `${fallback} (Reference: ${errorId})` : fallback;
}
