/**
 * Invoice + statement PDFs (pdf-lib, pure JS — no headless browser, no native
 * deps, runs in the Next server and the reminder job alike).
 *
 * Built from the same InvoiceDocument the page and the emails use, so the PDF can
 * never disagree with them. Branded from the company: logo, name, colour, HST
 * number and address. The platform is named nowhere.
 *
 * Standard PDF fonts only cover Latin-1-ish text (WinAnsi). Anything outside it
 * (emoji, other scripts) is replaced rather than allowed to throw — a customer's
 * name must never be the reason an invoice can't be produced.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";

import {
  formatCalendarDate,
  formatMoney,
  formatTaxRate,
  termsLabel,
  type InvoiceBrand,
  type InvoiceDocument,
  type InvoicePaymentOptions,
} from "./document";

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.9, 0.91, 0.93);

function hexToRgb(hex: string | null | undefined, fallback: RGB): RGB {
  const m = typeof hex === "string" ? hex.trim().match(/^#?([0-9a-f]{6})$/i) : null;
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Replace anything the standard fonts can't encode. */
export function pdfSafe(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/\t/g, " ")
    .replace(/[^\n\x20-\x7E\u00A1-\u00FF]/gu, "?");
}

class Layout {
  page: PDFPage;
  y: number;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly onNewPage: (l: Layout) => void,
  ) {
    this.page = doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height: number): void {
    if (this.y - height < MARGIN + 24) {
      this.page = this.doc.addPage([PAGE_W, PAGE_H]);
      this.y = PAGE_H - MARGIN;
      this.onNewPage(this);
    }
  }

  text(t: string, x: number, size: number, opts: { font?: PDFFont; color?: RGB; y?: number } = {}): void {
    this.page.drawText(pdfSafe(t), { x, y: opts.y ?? this.y, size, font: opts.font ?? this.font, color: opts.color ?? INK });
  }

  textRight(t: string, right: number, size: number, opts: { font?: PDFFont; color?: RGB; y?: number } = {}): void {
    const f = opts.font ?? this.font;
    const s = pdfSafe(t);
    this.page.drawText(s, { x: right - f.widthOfTextAtSize(s, size), y: opts.y ?? this.y, size, font: f, color: opts.color ?? INK });
  }

  wrap(t: string, size: number, width: number, font: PDFFont = this.font): string[] {
    const out: string[] = [];
    for (const para of pdfSafe(t).split("\n")) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = "";
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(next, size) <= width) {
          line = next;
        } else {
          if (line) out.push(line);
          // A single over-long word is hard-cut.
          let rest = w;
          while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
            let cut = rest.length - 1;
            while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
            out.push(rest.slice(0, cut));
            rest = rest.slice(cut);
          }
          line = rest;
        }
      }
      out.push(line);
    }
    return out;
  }

  paragraph(t: string, x: number, size: number, width: number, opts: { font?: PDFFont; color?: RGB; lineGap?: number } = {}): void {
    const lines = this.wrap(t, size, width, opts.font);
    const lh = size + (opts.lineGap ?? 3);
    for (const line of lines) {
      this.ensure(lh);
      this.text(line, x, size, opts);
      this.y -= lh;
    }
  }

  rule(color: RGB = RULE): void {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color });
  }
}

async function fetchLogo(doc: PDFDocument, url: string | null): Promise<PDFImage | null> {
  if (!url || !/^https:\/\//i.test(url)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 3_000_000) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
    return null; // SVG / WebP aren't embeddable — the brand name is drawn instead.
  } catch {
    return null;
  }
}

async function header(l: Layout, brand: InvoiceBrand, accent: RGB, heading: string, metaRows: Array<[string, string]>): Promise<void> {
  l.page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: accent });
  const top = l.y;
  const logo = await fetchLogo(l.doc, brand.logoUrl);
  let leftY = top;
  if (logo) {
    const ratio = logo.width / logo.height;
    let h = 40;
    let w = ratio * h;
    if (w > 180) {
      w = 180;
      h = w / ratio;
    }
    l.page.drawImage(logo, { x: MARGIN, y: top - h + 8, width: w, height: h });
    leftY = top - h - 6;
  } else {
    l.text(brand.name, MARGIN, 18, { font: l.bold, color: accent, y: top - 10 });
    leftY = top - 30;
  }

  const brandLines = [
    logo ? brand.name : null,
    ...(brand.address ? brand.address.split("\n") : []),
    brand.replyPhone,
    brand.replyEmail,
    brand.taxRegistrationNumber ? `HST/GST #: ${brand.taxRegistrationNumber}` : null,
  ].filter((v): v is string => Boolean(v && v.trim()));
  for (const line of brandLines) {
    l.text(line, MARGIN, 9, { color: MUTED, y: leftY });
    leftY -= 12;
  }

  const right = PAGE_W - MARGIN;
  l.textRight(heading, right, 22, { font: l.bold, y: top - 12 });
  let rightY = top - 32;
  for (const [k, v] of metaRows) {
    l.textRight(`${k}  ${v}`, right, 9.5, { y: rightY, color: k ? INK : MUTED });
    rightY -= 13;
  }
  l.y = Math.min(leftY, rightY) - 14;
}

function billToBlock(l: Layout, doc: InvoiceDocument): void {
  l.ensure(70);
  l.text("BILL TO", MARGIN, 8.5, { font: l.bold, color: MUTED });
  l.y -= 14;
  l.text(doc.billTo.name, MARGIN, 11, { font: l.bold });
  l.y -= 14;
  const lines = [
    doc.billTo.attention ? `Attn: ${doc.billTo.attention}` : null,
    ...(doc.billTo.address ? doc.billTo.address.split("\n") : []),
    doc.billTo.email,
    doc.billTo.phone,
    doc.billTo.taxNumber ? `Tax #: ${doc.billTo.taxNumber}` : null,
  ].filter((v): v is string => Boolean(v && v.trim()));
  for (const line of lines) {
    l.text(line, MARGIN, 9.5, { color: MUTED });
    l.y -= 12;
  }
  l.y -= 10;
}

function stamp(l: Layout, label: string, color: RGB): void {
  const size = 26;
  const w = l.bold.widthOfTextAtSize(label, size) + 24;
  const x = PAGE_W - MARGIN - w;
  const y = l.y + 30;
  l.page.drawRectangle({ x, y: y - 8, width: w, height: size + 10, borderColor: color, borderWidth: 2, opacity: 0, borderOpacity: 0.8 });
  l.text(label, x + 12, size, { font: l.bold, color, y });
}

const COL = { qty: MARGIN + CONTENT_W - 210, unit: MARGIN + CONTENT_W - 90, amount: PAGE_W - MARGIN };

function tableHeader(l: Layout, accent: RGB): void {
  l.ensure(24);
  l.page.drawRectangle({ x: MARGIN, y: l.y - 6, width: CONTENT_W, height: 20, color: accent, opacity: 0.08 });
  l.text("DESCRIPTION", MARGIN + 6, 8.5, { font: l.bold, color: MUTED });
  l.textRight("QTY", COL.qty, 8.5, { font: l.bold, color: MUTED });
  l.textRight("UNIT PRICE", COL.unit, 8.5, { font: l.bold, color: MUTED });
  l.textRight("AMOUNT", COL.amount - 6, 8.5, { font: l.bold, color: MUTED });
  l.y -= 24;
}

function qtyLabel(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/0$/, "");
}

function paymentSection(l: Layout, payment: InvoicePaymentOptions, doc: { publicUrl: string; invoiceNumber: string | null; currency: string; balanceCents: number }): void {
  const blocks: Array<[string, string]> = [];
  if (payment.card || payment.bankDebit) {
    const how = [payment.card ? "card, Apple Pay or Google Pay" : null, payment.bankDebit ? "bank debit" : null].filter(Boolean).join(" or ");
    blocks.push(["Pay online", `By ${how}: ${doc.publicUrl}`]);
  }
  if (payment.etransfer) {
    blocks.push([
      "Interac e-Transfer",
      `Send to ${payment.etransfer.email}${doc.invoiceNumber ? ` with ${doc.invoiceNumber} in the message` : ""}.${payment.etransfer.instructions ? ` ${payment.etransfer.instructions}` : ""}`,
    ]);
  }
  if (payment.cheque) {
    blocks.push(["Cheque", `Payable to ${payment.cheque.payableTo}${payment.cheque.mailTo ? `, mailed to ${payment.cheque.mailTo.replace(/\n/g, ", ")}` : ""}.`]);
  }
  if (payment.cash) blocks.push(["Cash", "Accepted in person."]);
  if (blocks.length === 0) return;

  l.ensure(40);
  l.y -= 6;
  l.text("HOW TO PAY", MARGIN, 8.5, { font: l.bold, color: MUTED });
  l.y -= 15;
  for (const [title, body] of blocks) {
    l.ensure(28);
    l.text(title, MARGIN, 9.5, { font: l.bold });
    l.y -= 12;
    l.paragraph(body, MARGIN, 9.5, CONTENT_W, { color: MUTED });
    l.y -= 4;
  }
}

function footer(l: Layout, text: string | null): void {
  if (!text) return;
  l.ensure(30);
  l.y -= 8;
  l.rule();
  l.y -= 14;
  l.paragraph(text, MARGIN, 8.5, CONTENT_W, { color: MUTED });
}

/** The invoice PDF. */
export async function renderInvoicePdf(doc: InvoiceDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${doc.brand.name} invoice ${doc.invoiceNumber ?? "(draft)"}`));
  pdf.setAuthor(pdfSafe(doc.brand.name));
  pdf.setCreator(pdfSafe(doc.brand.name));
  pdf.setProducer(pdfSafe(doc.brand.name));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToRgb(doc.brand.primaryColor, INK);

  const l = new Layout(pdf, font, bold, (lay) => {
    lay.text(`${doc.brand.name} - Invoice ${doc.invoiceNumber ?? "(draft)"} (continued)`, MARGIN, 9, { color: MUTED });
    lay.y -= 22;
    tableHeader(lay, accent);
  });

  const meta: Array<[string, string]> = [
    ["Invoice #", doc.invoiceNumber ?? "DRAFT"],
    ...(doc.issueDate ? [["Issued", formatCalendarDate(doc.issueDate) ?? ""] as [string, string]] : []),
    ...(doc.dueDate ? [["Due", formatCalendarDate(doc.dueDate) ?? ""] as [string, string]] : []),
    ["Terms", termsLabel(doc.paymentTermsDays)],
  ];
  await header(l, doc.brand, accent, "INVOICE", meta);

  billToBlock(l, doc);
  if (doc.state === "paid") stamp(l, "PAID", rgb(0.09, 0.55, 0.3));
  if (doc.state === "void") stamp(l, "VOID", rgb(0.75, 0.15, 0.15));

  if (doc.title) {
    l.paragraph(doc.title, MARGIN, 12, CONTENT_W, { font: bold });
    l.y -= 6;
  }

  tableHeader(l, accent);
  for (const line of doc.lines) {
    const descLines = line.description ? l.wrap(line.description, 8.5, COL.qty - MARGIN - 70) : [];
    const labelLines = l.wrap(line.label, 10, COL.qty - MARGIN - 60, bold);
    const h = labelLines.length * 13 + descLines.length * 11 + 8;
    l.ensure(h);
    const rowTop = l.y;
    l.textRight(qtyLabel(line.quantity), COL.qty, 10, { y: rowTop });
    l.textRight(formatMoney(line.unitPriceCents, doc.currency), COL.unit, 10, { y: rowTop });
    l.textRight(formatMoney(line.amountCents, doc.currency), COL.amount - 6, 10, { y: rowTop });
    for (const t of labelLines) {
      l.text(t, MARGIN + 6, 10, { font: bold });
      l.y -= 13;
    }
    for (const t of descLines) {
      l.text(t, MARGIN + 6, 8.5, { color: MUTED });
      l.y -= 11;
    }
    l.y -= 4;
    l.rule();
    l.y -= 12;
  }

  // Totals
  const rows: Array<[string, string, boolean]> = [
    ["Subtotal", formatMoney(doc.subtotalCents, doc.currency), false],
    [`HST/GST (${formatTaxRate(doc.taxRateBps)})`, formatMoney(doc.taxCents, doc.currency), false],
    ["Total", formatMoney(doc.totalCents, doc.currency), true],
  ];
  if (doc.creditCents > 0) rows.push(["Deposit received", `-${formatMoney(doc.creditCents, doc.currency)}`, false]);
  if (doc.paidCents > 0) rows.push(["Payments received", `-${formatMoney(doc.paidCents, doc.currency)}`, false]);
  if (doc.pendingCents > 0) rows.push(["Bank debit clearing", formatMoney(doc.pendingCents, doc.currency), false]);
  l.ensure(rows.length * 16 + 40);
  for (const [k, v, strong] of rows) {
    l.textRight(k, COL.unit, 10, { font: strong ? bold : font, color: strong ? INK : MUTED });
    l.textRight(v, COL.amount - 6, 10, { font: strong ? bold : font });
    l.y -= 16;
  }
  l.y -= 2;
  l.page.drawRectangle({ x: COL.qty - 40, y: l.y - 8, width: COL.amount - (COL.qty - 40), height: 26, color: accent, opacity: 0.1 });
  l.textRight("Balance due", COL.unit, 12, { font: bold });
  l.textRight(formatMoney(doc.balanceCents, doc.currency), COL.amount - 6, 12, { font: bold });
  l.y -= 34;

  if (doc.notes) {
    l.ensure(30);
    l.text("NOTES", MARGIN, 8.5, { font: bold, color: MUTED });
    l.y -= 14;
    l.paragraph(doc.notes, MARGIN, 9.5, CONTENT_W);
    l.y -= 6;
  }

  if (doc.balanceCents > 0 && doc.state !== "void") paymentSection(l, doc.payment, doc);
  footer(l, doc.footerText);

  return pdf.save();
}

// ── Statements ───────────────────────────────────────────────────────────────

export interface StatementLine {
  invoiceNumber: string | null;
  title: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  overdue: boolean;
  publicUrl: string;
}

export interface StatementDocument {
  brand: InvoiceBrand;
  payment: InvoicePaymentOptions;
  currency: string;
  statementDate: string;
  customer: { name: string; attention: string | null; address: string | null; email: string | null };
  lines: StatementLine[];
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; over90: number };
  totalDueCents: number;
  footerText: string | null;
}

export async function renderStatementPdf(st: StatementDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${st.brand.name} statement for ${st.customer.name}`));
  pdf.setAuthor(pdfSafe(st.brand.name));
  pdf.setCreator(pdfSafe(st.brand.name));
  pdf.setProducer(pdfSafe(st.brand.name));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToRgb(st.brand.primaryColor, INK);
  const cols = { issued: MARGIN + 150, due: MARGIN + 240, total: MARGIN + 340, paid: MARGIN + 420, bal: PAGE_W - MARGIN - 6 };

  const head = (lay: Layout) => {
    lay.ensure(24);
    lay.page.drawRectangle({ x: MARGIN, y: lay.y - 6, width: CONTENT_W, height: 20, color: accent, opacity: 0.08 });
    lay.text("INVOICE", MARGIN + 6, 8.5, { font: bold, color: MUTED });
    lay.text("ISSUED", cols.issued, 8.5, { font: bold, color: MUTED });
    lay.text("DUE", cols.due, 8.5, { font: bold, color: MUTED });
    lay.textRight("TOTAL", cols.total + 60, 8.5, { font: bold, color: MUTED });
    lay.textRight("PAID", cols.paid + 50, 8.5, { font: bold, color: MUTED });
    lay.textRight("BALANCE", cols.bal, 8.5, { font: bold, color: MUTED });
    lay.y -= 24;
  };
  const l = new Layout(pdf, font, bold, (lay) => {
    lay.text(`${st.brand.name} - Statement for ${st.customer.name} (continued)`, MARGIN, 9, { color: MUTED });
    lay.y -= 22;
    head(lay);
  });

  await header(l, st.brand, accent, "STATEMENT", [
    ["Date", formatCalendarDate(st.statementDate) ?? st.statementDate],
    ["Amount due", formatMoney(st.totalDueCents, st.currency)],
  ]);

  l.text("ACCOUNT", MARGIN, 8.5, { font: bold, color: MUTED });
  l.y -= 14;
  l.text(st.customer.name, MARGIN, 11, { font: bold });
  l.y -= 14;
  for (const line of [st.customer.attention ? `Attn: ${st.customer.attention}` : null, ...(st.customer.address?.split("\n") ?? []), st.customer.email].filter(
    (v): v is string => Boolean(v && v.trim()),
  )) {
    l.text(line, MARGIN, 9.5, { color: MUTED });
    l.y -= 12;
  }
  l.y -= 12;

  head(l);
  if (st.lines.length === 0) {
    l.text("Nothing is owing. Thank you!", MARGIN + 6, 10, { color: MUTED });
    l.y -= 20;
  }
  for (const line of st.lines) {
    l.ensure(20);
    l.text(line.invoiceNumber ?? "-", MARGIN + 6, 9.5, { font: bold });
    l.text(formatCalendarDate(line.issueDate) ?? "-", cols.issued, 9, { color: MUTED });
    l.text(`${formatCalendarDate(line.dueDate) ?? "-"}${line.overdue ? "  OVERDUE" : ""}`, cols.due, 9, {
      color: line.overdue ? rgb(0.75, 0.15, 0.15) : MUTED,
    });
    l.textRight(formatMoney(line.totalCents, st.currency), cols.total + 60, 9.5);
    l.textRight(formatMoney(line.paidCents, st.currency), cols.paid + 50, 9.5, { color: MUTED });
    l.textRight(formatMoney(line.balanceCents, st.currency), cols.bal, 9.5, { font: bold });
    l.y -= 16;
    l.rule();
    l.y -= 10;
  }

  // Aging summary
  l.ensure(60);
  l.y -= 4;
  const buckets: Array<[string, number]> = [
    ["Current", st.aging.current],
    ["1-30 days", st.aging.d1_30],
    ["31-60 days", st.aging.d31_60],
    ["61-90 days", st.aging.d61_90],
    ["Over 90", st.aging.over90],
  ];
  const bw = CONTENT_W / buckets.length;
  buckets.forEach(([k, v], i) => {
    const x = MARGIN + i * bw;
    l.text(k, x + 4, 8.5, { color: MUTED });
    l.text(formatMoney(v, st.currency), x + 4, 10.5, { font: bold, y: l.y - 14 });
  });
  l.y -= 40;
  l.page.drawRectangle({ x: PAGE_W - MARGIN - 220, y: l.y - 8, width: 220, height: 26, color: accent, opacity: 0.1 });
  l.textRight("Total amount due", PAGE_W - MARGIN - 100, 12, { font: bold });
  l.textRight(formatMoney(st.totalDueCents, st.currency), PAGE_W - MARGIN - 6, 12, { font: bold });
  l.y -= 34;

  if (st.totalDueCents > 0) {
    const p = st.payment;
    const online = p.card || p.bankDebit;
    paymentSection(l, { ...p, card: false, bankDebit: false }, { publicUrl: "", invoiceNumber: null, currency: st.currency, balanceCents: st.totalDueCents });
    if (online) {
      l.ensure(30);
      l.text("Pay online", MARGIN, 9.5, { font: bold });
      l.y -= 12;
      l.paragraph("Each invoice above has its own secure payment page - use the links in the email this statement came with.", MARGIN, 9.5, CONTENT_W, { color: MUTED });
    }
  }
  footer(l, st.footerText);
  return pdf.save();
}
