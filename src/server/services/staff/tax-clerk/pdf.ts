/**
 * PDFs with pdf-lib (already a dependency):
 *   pngAsPdf       a PNG receipt (screenshots) wrapped in a one-page PDF, because the
 *                  expense-receipts bucket and expenses.receipt_type only take jpeg / pdf
 *   hstSummaryPdf  the accountant packet's one-page summary with the CRA line numbers
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { DISCLAIMER, money, netPhrase, shortDate, type HstPeriod, type HstWorksheet } from "./hst";

/** One page sized to the picture (fit within US Letter at 72 dpi), the PNG drawn full-page. */
export async function pngAsPdf(png: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // A plain Uint8Array of this realm (a Buffer, or one from another realm, fails pdf-lib's type check).
  const image = await doc.embedPng(Uint8Array.from(png));
  const scale = Math.min(1, 612 / image.width, 792 / image.height);
  const w = Math.max(1, image.width * scale);
  const h = Math.max(1, image.height * scale);
  const page = doc.addPage([w, h]);
  page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  return doc.save();
}

/** pdf-lib's standard fonts only encode WinAnsi: keep text plain. */
function plain(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, "");
}

export interface SummaryInput {
  companyName: string;
  hstNumber: string | null;
  period: HstPeriod;
  worksheet: HstWorksheet;
  preparedOn: string;
  expenseCount: number;
  invoiceCount: number;
}

export async function hstSummaryPdf(input: SummaryInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.4, 0.4, 0.45);
  let y = 740;
  const text = (s: string, opts: { size?: number; bold?: boolean; x?: number; color?: ReturnType<typeof rgb> } = {}) => {
    page.drawText(plain(s), { x: opts.x ?? 56, y, size: opts.size ?? 11, font: opts.bold ? bold : font, color: opts.color ?? ink });
  };
  const w = input.worksheet;
  const p = input.period;
  const year = Number(p.end.slice(0, 4));

  text(`${input.companyName} - GST/HST worksheet`, { size: 16, bold: true });
  y -= 22;
  text(`${p.label} (${p.range}), regular method${input.hstNumber ? `  |  HST # ${input.hstNumber}` : ""}`, { color: grey });
  y -= 16;
  text(`Return due ${shortDate(p.dueDate, year - 1)}${p.paymentDueDate !== p.dueDate ? `, payment due ${shortDate(p.paymentDueDate, year - 1)}` : ""}. Prepared ${input.preparedOn}.`, { color: grey });
  y -= 36;

  const rows: Array<[string, string, number, boolean?]> = [
    ["101", "Sales and other revenue (before tax)", w.salesCents],
    ["103", "GST/HST collected or collectible", w.collectedCents],
    ["104", "Adjustments", 0],
    ["105", "Total GST/HST and adjustments (103 + 104)", w.collectedCents],
    ["106", "Input tax credits (ITCs)", w.itcCents],
    ["107", "Adjustments", 0],
    ["108", "Total ITCs and adjustments (106 + 107)", w.itcCents],
    ["109", "Net tax (105 - 108)", w.netCents, true],
  ];
  for (const [line, label, cents, strong] of rows) {
    text(`Line ${line}`, { bold: true });
    text(label, { x: 120, bold: strong });
    const amount = money(cents);
    page.drawText(plain(amount), { x: 556 - (strong ? bold : font).widthOfTextAtSize(amount, 11), y, size: 11, font: strong ? bold : font, color: ink });
    y -= 22;
  }
  y -= 6;
  text(`Net: ${netPhrase(w.netCents)}.`, { bold: true });
  y -= 30;

  const notes = [
    `Sales: ${input.invoiceCount} invoice${input.invoiceCount === 1 ? "" : "s"} issued in the period (not drafts or voided)${w.creditNoteCount ? `, including ${w.creditNoteCount} credit note${w.creditNoteCount === 1 ? "" : "s"}` : ""}. Deposits applied are payments and don't change the sales figure.`,
    w.importedExcluded ? `${w.importedExcluded} invoice${w.importedExcluded === 1 ? " was" : "s were"} imported from the previous system and left out (already reported there).` : null,
    `ITCs: the sales tax on ${input.expenseCount} expense${input.expenseCount === 1 ? "" : "s"} in the period${w.mealsDisallowedCents ? `; meals and entertainment at 50% (${money(w.mealsDisallowedCents)} left out)` : ""}.`,
    w.lateItcCents ? `Line 106 includes ${money(w.lateItcCents)} of ITCs from ${w.lateExpenseCount} receipt${w.lateExpenseCount === 1 ? "" : "s"} of earlier periods that came in after those periods were done (CRA allows claiming them later; flagged in the expenses CSV).` : null,
    w.missingReceipts ? `${w.missingReceipts} expense${w.missingReceipts === 1 ? " has" : "s have"} no receipt picture - see the expenses CSV.` : "Every expense in the CSV has a receipt link (good for 30 days).",
    "Adjustments (lines 104 and 107), instalments and rebates aren't worked out here.",
    DISCLAIMER,
  ].filter((n): n is string => Boolean(n));
  text("Notes", { bold: true });
  y -= 18;
  for (const note of notes) {
    // Simple word wrap at ~95 characters.
    const words = plain(note).split(" ");
    let line = "";
    for (const word of words) {
      if (`${line} ${word}`.trim().length > 95) {
        text(line, { size: 10, color: grey });
        y -= 14;
        line = word;
      } else line = `${line} ${word}`.trim();
    }
    if (line) {
      text(line, { size: 10, color: grey });
      y -= 18;
    }
  }
  return doc.save();
}
