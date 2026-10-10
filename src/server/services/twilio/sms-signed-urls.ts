/**
 * The URLs Twilio may have signed. Twilio signs the URL configured on the number, which behind
 * a proxy is not request.url (scheme/host differ). Numbers are configured from different
 * settings (catcher numbers from TWILIO_WEBHOOK_BASE_URL, the platform number by hand), so
 * every configured origin is tried: TWILIO_INBOUND_SMS_URL, then TWILIO_WEBHOOK_BASE_URL /
 * APP_BASE_URL + path, then the public host the request arrived on. Trying several URLs does
 * not weaken the check — each still needs a valid HMAC under the account's auth token.
 */
export function inboundSmsUrlCandidates(request: Request): string[] {
  const url = new URL(request.url);
  const suffix = `${url.pathname}${url.search}`;
  const out: string[] = [];
  const add = (u: string | null | undefined) => {
    const v = u?.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  add(process.env.TWILIO_INBOUND_SMS_URL);
  for (const name of ["TWILIO_WEBHOOK_BASE_URL", "APP_BASE_URL"]) {
    const base = process.env[name]?.trim().replace(/\/+$/, "");
    if (base) add(`${base}${suffix}`);
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) add(`https://${host.split(",")[0].trim()}${suffix}`);
  add(request.url);
  return out;
}
