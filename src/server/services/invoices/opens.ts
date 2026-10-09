/**
 * Invoice opens — pure helpers shared by the public routes and the email senders.
 *
 *   • Page opens are counted from the public page's own data request (the page's
 *     JavaScript calls the API), so link scanners that only fetch the HTML don't
 *     count. Headless browsers and crawlers are dropped by user agent.
 *   • Email opens come from a 1×1 image in the invoice and reminder emails. Some mail
 *     apps load images on their own (Apple Mail Privacy Protection, security scanners),
 *     so an email open is a hint, never a status change. The image is served from the
 *     brand's own invoice domain — no platform marks.
 *   • Nothing identifying is stored: no IP, only a coarse device label ("iPhone").
 */

/** A refresh, or coming back from the pay page, within this window is the same open. */
export const OPEN_DEDUPE_SECONDS = 30 * 60;

/** Which email an open came from: the invoice itself, or reminder N (1-based). */
export type EmailKind = "invoice" | `reminder-${number}`;

export function parseEmailKind(raw: string | null | undefined): EmailKind | null {
  if (raw === "invoice") return "invoice";
  const m = /^reminder-([1-9]\d?)$/.exec(raw ?? "");
  return m ? (`reminder-${Number(m[1])}` as EmailKind) : null;
}

const AUTOMATED = /(headless|bot\b|bot\/|crawler|spider|slurp|preview|scanner|python-requests|curl\/|wget|go-http-client|okhttp|java\/|axios|node-fetch|undici|^node$|facebookexternalhit|whatsapp|skypeuripreview|bingpreview|proofpoint|mimecast|barracuda)/i;

/**
 * A request that is plainly a program, not a person looking at the invoice. A page
 * open with no user agent at all is a program; an image load with none can be a
 * desktop mail app, so `allowEmpty` lets the email-open path keep it.
 */
export function isAutomatedAgent(userAgent: string | null | undefined, opts: { allowEmpty?: boolean } = {}): boolean {
  const ua = (userAgent ?? "").trim();
  if (!ua) return !opts.allowEmpty;
  return AUTOMATED.test(ua);
}

/** "iPhone", "Android phone", "Mac", "Windows PC"… — enough to recognise "that was them on their phone". */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  const ua = userAgent ?? "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/CrOS/i.test(ua)) return "Chromebook";
  if (/Linux/i.test(ua)) return "Linux computer";
  return null;
}

/** The open-tracking image URL for one email, on the brand's own invoice origin. */
export function emailOpenPixelUrl(publicInvoiceUrl: string, kind: EmailKind): string {
  // publicInvoiceUrl is `{origin}/i/{token}`; the API lives on the same origin.
  const m = /^(.*)\/i\/([a-f0-9]{32})$/.exec(publicInvoiceUrl);
  if (!m) return "";
  return `${m[1]}/api/public/invoices/${m[2]}/open?e=${encodeURIComponent(kind)}`;
}

/** Append the tracking image just before </body> (or at the end). Empty URL → unchanged. */
export function withOpenPixel(html: string, pixelUrl: string): string {
  if (!pixelUrl) return html;
  const img = `<img src="${pixelUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${img}</body>`) : html + img;
}

/** A transparent 1×1 GIF. */
export const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
