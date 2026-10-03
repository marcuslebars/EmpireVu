/**
 * Invoice emails — PURE templates returning { subject, html, text }, in the same
 * house style as the quote emails (one button, table HTML, a real text part,
 * branded from the company with no platform marks).
 *
 *   invoiceSent      the invoice, PDF attached, one "View & pay" button
 *   paymentReceipt   thanks + what's left (if anything)
 *   reminder         past due — polite first, plainer later, never threatening
 *   statement        a business account's open invoices, each with its pay link
 */
import { button, DEFAULT_PRIMARY, esc, shell, footerText, type EmailBrand, type RenderedEmail } from "@/server/services/quotes/emails";
import { formatCalendarDate, formatMoney, type InvoiceBrand, type InvoiceDocument, type InvoicePaymentOptions } from "./document";
import type { StatementDocument } from "./pdf";

export function emailBrand(brand: InvoiceBrand): EmailBrand {
  return {
    name: brand.name,
    logoUrl: brand.logoUrl,
    primaryColor: brand.primaryColor,
    replyEmail: brand.replyEmail,
    replyPhone: brand.replyPhone,
    websiteUrl: brand.websiteUrl,
  };
}

function greet(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : "Hi,";
}

function hasOnline(p: InvoicePaymentOptions): boolean {
  return p.card || p.bankDebit;
}

/** "You can also pay by Interac e-Transfer to …" lines, html + text. */
function offlineLines(doc: InvoiceDocument): { html: string; text: string } {
  const bits: string[] = [];
  if (doc.payment.etransfer) {
    bits.push(
      `Interac e-Transfer to ${doc.payment.etransfer.email}${doc.invoiceNumber ? ` (put ${doc.invoiceNumber} in the message)` : ""}${
        doc.payment.etransfer.instructions ? `. ${doc.payment.etransfer.instructions}` : ""
      }`,
    );
  }
  if (doc.payment.cheque) bits.push(`Cheque payable to ${doc.payment.cheque.payableTo}`);
  if (doc.payment.cash) bits.push("Cash in person");
  if (bits.length === 0) return { html: "", text: "" };
  const lead = hasOnline(doc.payment) ? "You can also pay by:" : "You can pay by:";
  return {
    html: `<p style="font-size:14px;color:#4b5563;margin:16px 0 4px">${lead}</p><ul style="font-size:14px;color:#4b5563;margin:0;padding-left:20px">${bits
      .map((b) => `<li>${esc(b)}</li>`)
      .join("")}</ul>`,
    text: `${lead}\n${bits.map((b) => `- ${b}`).join("\n")}`,
  };
}

function common(brand: EmailBrand) {
  return { fromName: brand.name, replyTo: brand.replyEmail };
}

function summaryTable(doc: InvoiceDocument): string {
  const row = (k: string, v: string, strong = false) =>
    `<tr><td style="padding:4px 0;${strong ? "font-weight:700" : "color:#4b5563"}">${esc(k)}</td><td align="right" style="padding:4px 0;white-space:nowrap;${
      strong ? "font-weight:700" : ""
    }">${esc(v)}</td></tr>`;
  const due = formatCalendarDate(doc.dueDate);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;margin:16px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;padding:8px 0">
${row("Invoice total", formatMoney(doc.totalCents, doc.currency))}
${doc.creditCents > 0 ? row("Deposit received", `-${formatMoney(doc.creditCents, doc.currency)}`) : ""}
${doc.paidCents > 0 ? row("Paid so far", `-${formatMoney(doc.paidCents, doc.currency)}`) : ""}
${row("Amount due", formatMoney(doc.balanceCents, doc.currency), true)}
${due ? row("Due", doc.paymentTermsDays <= 0 && doc.dueDate === doc.issueDate ? "On receipt" : due) : ""}
</table>`;
}

export function renderInvoiceSent(doc: InvoiceDocument, opts: { firstName: string | null }): RenderedEmail {
  const brand = emailBrand(doc.brand);
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const ref = doc.invoiceNumber ? ` ${doc.invoiceNumber}` : "";
  const offline = offlineLines(doc);
  const cta = hasOnline(doc.payment) ? "View & Pay Invoice" : "View Invoice";

  const html = shell(
    brand,
    `<p>${esc(greet(opts.firstName))}</p>
<p>Here's your invoice${ref ? ` <strong>${esc(ref.trim())}</strong>` : ""}${doc.title ? ` for ${esc(doc.title)}` : ""}. A PDF copy is attached.</p>
${summaryTable(doc)}
${button(doc.publicUrl, cta, primary)}
${offline.html}
<p style="font-size:14px;color:#6b7280">Questions about this invoice? Just reply to this email.</p>`,
  );
  const text = `${greet(opts.firstName)}

Here's your invoice${ref}${doc.title ? ` for ${doc.title}` : ""}. A PDF copy is attached.

Amount due: ${formatMoney(doc.balanceCents, doc.currency)}${doc.dueDate ? `\nDue: ${formatCalendarDate(doc.dueDate)}` : ""}

${hasOnline(doc.payment) ? "View and pay online" : "View it online"}:
${doc.publicUrl}
${offline.text ? `\n${offline.text}\n` : ""}
${footerText(brand)}`;

  return {
    subject: `Invoice${ref} from ${brand.name ?? "us"} — ${formatMoney(doc.balanceCents, doc.currency)} due`,
    html,
    text,
    ...common(brand),
  };
}

const METHOD_LABEL: Record<string, string> = {
  card: "card",
  bank_debit: "bank debit",
  etransfer: "Interac e-Transfer",
  cheque: "cheque",
  cash: "cash",
  other: "payment",
};

export function renderPaymentReceipt(
  doc: InvoiceDocument,
  payment: { amountCents: number; method: string; receivedAt: string; pending?: boolean },
  opts: { firstName: string | null },
): RenderedEmail {
  const brand = emailBrand(doc.brand);
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const ref = doc.invoiceNumber ? ` ${doc.invoiceNumber}` : "";
  const amount = formatMoney(payment.amountCents, doc.currency);
  const method = METHOD_LABEL[payment.method] ?? "payment";
  const settled = doc.balanceCents <= 0;
  const headline = payment.pending
    ? `We've received your ${method} authorization for ${amount}. Bank debits take a few business days to clear — we'll email you when it does.`
    : `Thank you — we received your ${method} payment of ${amount}.`;
  const after = payment.pending
    ? ""
    : settled
      ? "This invoice is now paid in full."
      : `Remaining balance: ${formatMoney(doc.balanceCents, doc.currency)}.`;

  const html = shell(
    brand,
    `<p>${esc(greet(opts.firstName))}</p>
<p><strong>${esc(headline)}</strong></p>
${after ? `<p>${esc(after)}</p>` : ""}
<p style="font-size:14px;color:#6b7280">Invoice${esc(ref)} · <a href="${esc(doc.publicUrl)}" style="color:${esc(primary)}">view or download it any time</a>.</p>`,
  );
  const text = `${greet(opts.firstName)}

${headline}
${after ? `\n${after}\n` : ""}
Invoice${ref}: ${doc.publicUrl}

${footerText(brand)}`;
  return {
    subject: payment.pending ? `Payment processing — invoice${ref}` : `Payment received — thank you (invoice${ref})`,
    html,
    text,
    ...common(brand),
  };
}

/**
 * Overdue reminder. `index` is 0 for the first reminder. Tone stays polite; the
 * later ones are plainer, not threatening — there's a relationship to keep.
 */
export function renderInvoiceReminder(
  doc: InvoiceDocument,
  opts: { firstName: string | null; daysOverdue: number; index: number },
): RenderedEmail {
  const brand = emailBrand(doc.brand);
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const ref = doc.invoiceNumber ? ` ${doc.invoiceNumber}` : "";
  const due = formatCalendarDate(doc.dueDate);
  const amount = formatMoney(doc.balanceCents, doc.currency);
  const lead =
    opts.index === 0
      ? `A friendly reminder that invoice${ref} for ${amount} was due${due ? ` on ${due}` : ""}. If you've already paid, thank you — please ignore this.`
      : `Invoice${ref} for ${amount} is now ${opts.daysOverdue} days past due. Please arrange payment at your earliest convenience, or reply to let us know if there's a problem.`;
  const offline = offlineLines(doc);

  const html = shell(
    brand,
    `<p>${esc(greet(opts.firstName))}</p>
<p>${esc(lead)}</p>
${summaryTable(doc)}
${button(doc.publicUrl, hasOnline(doc.payment) ? "Pay Invoice" : "View Invoice", primary)}
${offline.html}`,
  );
  const text = `${greet(opts.firstName)}

${lead}

Amount due: ${amount}
${doc.publicUrl}
${offline.text ? `\n${offline.text}\n` : ""}
${footerText(brand)}`;
  return {
    subject: opts.index === 0 ? `Reminder: invoice${ref} is due` : `Past due: invoice${ref} (${amount})`,
    html,
    text,
    ...common(brand),
  };
}

export function renderStatement(st: StatementDocument, opts: { firstName: string | null }): RenderedEmail {
  const brand = emailBrand(st.brand);
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const total = formatMoney(st.totalDueCents, st.currency);
  const rows = st.lines
    .map(
      (l) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid #f3f4f6"><a href="${esc(l.publicUrl)}" style="color:${esc(primary)};font-weight:600">${esc(
        l.invoiceNumber ?? "Invoice",
      )}</a>${l.overdue ? ' <span style="color:#b91c1c;font-size:12px">OVERDUE</span>' : ""}<div style="font-size:13px;color:#6b7280">${esc(
        l.dueDate ? `Due ${formatCalendarDate(l.dueDate)}` : "",
      )}</div></td>
<td align="right" style="padding:8px 0;border-bottom:1px solid #f3f4f6;white-space:nowrap;font-weight:600">${esc(formatMoney(l.balanceCents, st.currency))}</td>
</tr>`,
    )
    .join("");

  const html = shell(
    brand,
    `<p>${esc(greet(opts.firstName))}</p>
<p>Here's the statement for <strong>${esc(st.customer.name)}</strong> as of ${esc(formatCalendarDate(st.statementDate) ?? st.statementDate)}. A PDF copy is attached.</p>
${
  st.lines.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;margin:16px 0">${rows}
<tr><td style="padding:10px 0;font-weight:700">Total due</td><td align="right" style="padding:10px 0;font-weight:700">${esc(total)}</td></tr></table>
<p style="font-size:14px;color:#6b7280">Click an invoice to view or pay it.</p>`
    : "<p>Nothing is owing — thank you!</p>"
}`,
  );
  const text = `${greet(opts.firstName)}

Statement for ${st.customer.name} as of ${formatCalendarDate(st.statementDate) ?? st.statementDate}.

${st.lines.map((l) => `- ${l.invoiceNumber ?? "Invoice"}: ${formatMoney(l.balanceCents, st.currency)}${l.overdue ? " (overdue)" : ""}\n  ${l.publicUrl}`).join("\n")}

Total due: ${total}

${footerText(brand)}`;
  return {
    subject: `Statement from ${brand.name ?? "us"} — ${total} due`,
    html,
    text,
    ...common(brand),
  };
}
