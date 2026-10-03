/**
 * Quote emails — the four messages a customer receives.
 *
 *   quoteSent        the quote itself, with one button
 *   depositReceipt   confirmation after the deposit is paid
 *   expiryReminder   one gentle nudge, 5 days before valid_until
 *   quoteReplaced    sent on reissue, pointing at the new quote
 *
 * Every one is branded from the COMPANY. EmpireVu is the backend and is named
 * nowhere in these — the customer hired the brand, not the platform.
 *
 * Templates are PURE functions returning { subject, html, text } so they can be
 * snapshot-tested without a mail server or a database.
 *
 * House style, deliberately:
 *   • ONE call to action per email. Two buttons means a decision; a decision means
 *     a delay.
 *   • Table-based HTML with inline styles — the only thing that renders reliably
 *     in Outlook and Gmail's clipped view.
 *   • Every email has a real plain-text part, not a stripped-tags afterthought.
 *   • No urgency the facts don't support. See seasonalCapacityLine.
 */

export interface EmailBrand {
  name: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  replyEmail: string | null;
  replyPhone: string | null;
  websiteUrl: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** From display name — the address itself stays the verified sender. */
  fromName: string | null;
  replyTo: string | null;
}

export const DEFAULT_PRIMARY = "#1f2937";

/** Escape for HTML text/attribute context. Brand and customer text both flow in here. */
export function esc(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function money(cents: number, currency = "CAD"): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);
}

export function longDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * The honest capacity line — included ONLY while it is actually true.
 *
 * "Spots fill by mid-October" is a real fact about a seasonal storage yard in
 * September. Sent in February it is a lie, and a customer who notices stops
 * believing the rest of the email. Gate it on the month rather than sending it
 * year-round because it converts.
 */
export function seasonalCapacityLine(now: Date): string | null {
  const month = now.getUTCMonth(); // 0-indexed
  const inSeason = month >= 7 && month <= 9; // August–October
  return inSeason ? "Spots do fill up by mid-October, so it's worth getting booked in." : null;
}

/** Shared shell: brand header, body, brand footer. No platform marks anywhere. */
export function shell(brand: EmailBrand, bodyHtml: string): string {
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const header = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="40" style="height:40px;width:auto;border:0;display:block" />`
    : `<div style="font-size:19px;font-weight:700;color:${esc(primary)}">${esc(brand.name)}</div>`;

  const footerBits = [
    brand.name ? `<div style="font-weight:600;color:#374151">${esc(brand.name)}</div>` : "",
    brand.replyPhone ? `<div>${esc(brand.replyPhone)}</div>` : "",
    brand.replyEmail ? `<div>${esc(brand.replyEmail)}</div>` : "",
    brand.websiteUrl
      ? `<div><a href="${esc(brand.websiteUrl)}" style="color:${esc(primary)}">${esc(
          brand.websiteUrl.replace(/^https:\/\//, ""),
        )}</a></div>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<tr><td style="height:4px;background:${esc(primary)};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 24px 8px">${header}</td></tr>
<tr><td style="padding:0 24px 24px;font-size:16px;line-height:1.6">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280">${footerBits}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function button(url: string, label: string, primary: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
<tr><td style="border-radius:8px;background:${esc(primary)}">
<a href="${esc(url)}" style="display:inline-block;padding:15px 28px;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none">${esc(label)}</a>
</td></tr></table>`;
}

export function footerText(brand: EmailBrand): string {
  return [brand.name, brand.replyPhone, brand.replyEmail].filter(Boolean).join("\n");
}

function common(brand: EmailBrand) {
  return { fromName: brand.name, replyTo: brand.replyEmail };
}

export interface QuoteEmailContext {
  brand: EmailBrand;
  quoteUrl: string;
  quoteNumber: string | null;
  title: string | null;
  customerName: string | null;
  currency: string;
}

/** 1. The quote itself. Intro excerpt + exactly one button. */
export function renderQuoteSent(
  ctx: QuoteEmailContext & { introMessage: string | null; totalCents: number; depositCents: number; validUntil: string | null },
): RenderedEmail {
  const primary = ctx.brand.primaryColor || DEFAULT_PRIMARY;
  const greeting = ctx.customerName ? `Hi ${ctx.customerName},` : "Hi,";
  const valid = longDate(ctx.validUntil);
  // An excerpt, not the whole note — the quote page is where it belongs, and a
  // wall of text above the button costs clicks.
  const excerpt = (ctx.introMessage ?? "").split("\n").filter(Boolean).slice(0, 2).join(" ");

  const html = shell(
    ctx.brand,
    `<p>${esc(greeting)}</p>
<p>Your quote${ctx.quoteNumber ? ` <strong>${esc(ctx.quoteNumber)}</strong>` : ""} is ready${
      ctx.title ? ` — ${esc(ctx.title)}` : ""
    }.</p>
${excerpt ? `<p style="color:#4b5563">${esc(excerpt)}</p>` : ""}
<p>You can review it, choose any optional services, and approve online. Your total updates as you choose.</p>
${button(ctx.quoteUrl, "View & Approve Your Quote", primary)}
${valid ? `<p style="font-size:14px;color:#6b7280">This quote is valid until ${esc(valid)}.</p>` : ""}`,
  );

  const text = `${greeting}

Your quote${ctx.quoteNumber ? ` ${ctx.quoteNumber}` : ""} is ready${ctx.title ? ` — ${ctx.title}` : ""}.
${excerpt ? `\n${excerpt}\n` : ""}
Review it, choose any optional services, and approve online:
${ctx.quoteUrl}
${valid ? `\nValid until ${valid}.` : ""}

${footerText(ctx.brand)}`;

  return {
    subject: `Your quote${ctx.quoteNumber ? ` ${ctx.quoteNumber}` : ""} from ${ctx.brand.name ?? "us"}`,
    html,
    text,
    ...common(ctx.brand),
  };
}

/** 2. Deposit receipt. States what was bought — including chosen options — and what happens next. */
export function renderDepositReceipt(
  ctx: QuoteEmailContext & {
    depositCents: number;
    totalCents: number;
    balanceCents: number;
    purchasedLines: { label: string; amountCents: number }[];
  },
): RenderedEmail {
  const greeting = ctx.customerName ? `Hi ${ctx.customerName},` : "Hi,";
  const rows = ctx.purchasedLines
    .map(
      (l) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #f3f4f6">${esc(l.label)}</td>
<td align="right" style="padding:6px 0;border-bottom:1px solid #f3f4f6;white-space:nowrap">${esc(
          money(l.amountCents, ctx.currency),
        )}</td></tr>`,
    )
    .join("");

  const html = shell(
    ctx.brand,
    `<p>${esc(greeting)}</p>
<p><strong>Thanks — your deposit is received and your spot is booked.</strong></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;margin:16px 0">
${rows}
<tr><td style="padding:10px 0 0">Total</td><td align="right" style="padding:10px 0 0">${esc(money(ctx.totalCents, ctx.currency))}</td></tr>
<tr><td style="padding:4px 0;font-weight:700">Deposit paid</td><td align="right" style="padding:4px 0;font-weight:700">${esc(money(ctx.depositCents, ctx.currency))}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280">Balance due later</td><td align="right" style="padding:4px 0;color:#6b7280">${esc(money(ctx.balanceCents, ctx.currency))}</td></tr>
</table>
<p><strong>What happens next:</strong> we'll be in touch to schedule your drop-off. Nothing else is needed from you right now.</p>
<p style="font-size:14px;color:#6b7280">Your quote${ctx.quoteNumber ? ` (${esc(ctx.quoteNumber)})` : ""} stays available here: <a href="${esc(ctx.quoteUrl)}" style="color:${esc(ctx.brand.primaryColor || DEFAULT_PRIMARY)}">view it any time</a>.</p>`,
  );

  const text = `${greeting}

Thanks — your deposit is received and your spot is booked.

${ctx.purchasedLines.map((l) => `- ${l.label}: ${money(l.amountCents, ctx.currency)}`).join("\n")}

Total: ${money(ctx.totalCents, ctx.currency)}
Deposit paid: ${money(ctx.depositCents, ctx.currency)}
Balance due later: ${money(ctx.balanceCents, ctx.currency)}

What happens next: we'll be in touch to schedule your drop-off. Nothing else is
needed from you right now.

Your quote: ${ctx.quoteUrl}

${footerText(ctx.brand)}`;

  return {
    subject: `Deposit received — you're booked in${ctx.quoteNumber ? ` (${ctx.quoteNumber})` : ""}`,
    html,
    text,
    ...common(ctx.brand),
  };
}

/** 3. Expiry reminder — ONE gentle nudge at valid_until − 5 days. */
export function renderExpiryReminder(
  ctx: QuoteEmailContext & { validUntil: string | null; depositCents: number; now?: Date },
): RenderedEmail {
  const primary = ctx.brand.primaryColor || DEFAULT_PRIMARY;
  const greeting = ctx.customerName ? `Hi ${ctx.customerName},` : "Hi,";
  const valid = longDate(ctx.validUntil);
  const capacity = seasonalCapacityLine(ctx.now ?? new Date());

  const html = shell(
    ctx.brand,
    `<p>${esc(greeting)}</p>
<p>Just a quick note that your quote${ctx.quoteNumber ? ` <strong>${esc(ctx.quoteNumber)}</strong>` : ""} is still open${
      valid ? `, and it's valid until ${esc(valid)}` : ""
    }.</p>
${capacity ? `<p>${esc(capacity)}</p>` : ""}
<p>If you'd like any changes, just reply to this email and we'll sort it out.</p>
${button(ctx.quoteUrl, "View Your Quote", primary)}`,
  );

  const text = `${greeting}

Just a quick note that your quote${ctx.quoteNumber ? ` ${ctx.quoteNumber}` : ""} is still open${
    valid ? `, and it's valid until ${valid}` : ""
  }.
${capacity ? `\n${capacity}\n` : ""}
If you'd like any changes, just reply to this email and we'll sort it out.

${ctx.quoteUrl}

${footerText(ctx.brand)}`;

  return {
    subject: `Your quote is still open${valid ? ` until ${valid}` : ""}`,
    html,
    text,
    ...common(ctx.brand),
  };
}

/** 4. Sent on reissue. The old link still resolves, but says "replaced" — this carries the new one. */
export function renderQuoteReplaced(
  ctx: QuoteEmailContext & { reason: string | null },
): RenderedEmail {
  const primary = ctx.brand.primaryColor || DEFAULT_PRIMARY;
  const greeting = ctx.customerName ? `Hi ${ctx.customerName},` : "Hi,";

  const html = shell(
    ctx.brand,
    `<p>${esc(greeting)}</p>
<p><strong>We've updated your quote.</strong>${
      ctx.reason ? ` ${esc(ctx.reason)}` : ""
    } The new version replaces the one we sent before — please use the link below from now on.</p>
${button(ctx.quoteUrl, "View Your Updated Quote", primary)}
<p style="font-size:14px;color:#6b7280">The previous link will tell you it's been replaced, so there's no risk of approving the old one by mistake.</p>`,
  );

  const text = `${greeting}

We've updated your quote.${ctx.reason ? ` ${ctx.reason}` : ""} The new version replaces the
one we sent before — please use this link from now on:

${ctx.quoteUrl}

The previous link will tell you it's been replaced, so there's no risk of
approving the old one by mistake.

${footerText(ctx.brand)}`;

  return {
    subject: `We've updated your quote${ctx.quoteNumber ? ` — ${ctx.quoteNumber}` : ""}`,
    html,
    text,
    ...common(ctx.brand),
  };
}
