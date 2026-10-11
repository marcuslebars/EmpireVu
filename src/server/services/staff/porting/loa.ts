/**
 * The Letter of Authorization (US/Canada port-in) the owner e-signs on /port/:token, as a PDF
 * (pdf-lib, standard fonts). It names the business, the authorized person, the service address,
 * the current carrier and the numbers, and carries the typed signature with the date, IP and
 * browser it was signed from. The account number and PIN are deliberately NOT printed: they go
 * to the porting form separately, so the stored PDF never holds them.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { prettyPhone } from "@/lib/carrier-forwarding";
import { pdfSafe } from "@/server/services/invoices/pdf";
import type { ServiceAddress } from "@/server/services/staff/porting/db-types";

export interface LoaInput {
  businessName: string;
  authorizedName: string;
  serviceAddress: ServiceAddress;
  carrier: string;
  numbers: string[];
  signedName: string;
  signedAtIso: string;
  signedIp: string | null;
  signedUserAgent: string | null;
  /** Shown in the signature block ("Signed in America/Toronto: Oct 11, 2026"). */
  timeZone: string;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);

export function addressLines(a: ServiceAddress): string[] {
  return [a.line1, a.line2 ?? "", `${a.city}, ${a.province} ${a.postalCode}`, a.country === "US" ? "United States" : "Canada"].filter((l) => l.trim().length > 0);
}

export function loaAuthorizationText(businessName: string): string {
  return (
    `I authorize Twilio Inc., the new service provider, and its designated agents to act on behalf of ${businessName} ` +
    "to port the telephone number(s) listed below from the current carrier, and to notify the current carrier of this " +
    "change. I am the account holder, or am authorized by the account holder to make this request, and the information " +
    "below matches the current carrier's records. I understand that the current carrier's service for these numbers " +
    "ends when the port completes, and that other services on the account (long distance, features) may be affected."
  );
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildLoaPdf(input: LoaInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Letter of Authorization - number port");
  doc.setSubject(`Port of ${input.numbers.join(", ")}`);
  doc.setCreationDate(new Date(input.signedAtIso));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const script = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const text = (t: string, size: number, opts: { f?: typeof font; color?: typeof INK; x?: number } = {}) => {
    page.drawText(pdfSafe(t), { x: opts.x ?? MARGIN, y, size, font: opts.f ?? font, color: opts.color ?? INK });
  };
  const row = (label: string, value: string) => {
    text(label, 9, { color: MUTED });
    text(value, 11, { x: MARGIN + 150 });
    y -= 18;
  };

  text("Letter of Authorization", 20, { f: bold });
  y -= 18;
  text("Local number port - United States / Canada", 10, { color: MUTED });
  y -= 30;

  row("Business name", input.businessName);
  row("Authorized person", input.authorizedName);
  const addr = addressLines(input.serviceAddress);
  text("Service address", 9, { color: MUTED });
  for (const line of addr) {
    text(line, 11, { x: MARGIN + 150 });
    y -= 15;
  }
  y -= 3;
  row("Current carrier", input.carrier);
  text("Number(s) to port", 9, { color: MUTED });
  for (const n of input.numbers) {
    text(prettyPhone(n), 11, { x: MARGIN + 150, f: bold });
    y -= 15;
  }
  y -= 3;
  row("Account number / PIN", "Provided separately to the porting agent");
  y -= 12;

  for (const line of wrap(loaAuthorizationText(input.businessName), 95)) {
    text(line, 10);
    y -= 14;
  }
  y -= 26;

  text(input.signedName, 24, { f: script });
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + 260, y }, thickness: 0.8, color: MUTED });
  y -= 14;
  text(`Signature of authorized person: ${input.authorizedName}`, 9, { color: MUTED });
  y -= 22;

  const signedAt = new Date(input.signedAtIso);
  const localDate = signedAt.toLocaleDateString("en-CA", { timeZone: input.timeZone, year: "numeric", month: "long", day: "numeric" });
  row("Date", localDate);
  y -= 6;
  text("Electronic signature record", 9, { f: bold, color: MUTED });
  y -= 13;
  for (const line of [
    `Typed name: ${input.signedName}`,
    `Signed at: ${signedAt.toISOString()}`,
    `IP address: ${input.signedIp ?? "unknown"}`,
    ...wrap(`Browser: ${input.signedUserAgent ?? "unknown"}`, 110),
  ]) {
    text(line, 8, { color: MUTED });
    y -= 11;
  }

  return doc.save();
}
