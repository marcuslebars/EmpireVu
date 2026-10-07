/**
 * Shared class names and small helpers for the staff invoice screens.
 * Matches the form styling used across the app's dialogs (Tasks / Calendar).
 */
import { toast } from "@/components/ui/sonner";
import type { DeliveryOutcome } from "@/lib/invoices-api";

export const inputCls =
  "w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60";

export const selectCls = `${inputCls} appearance-none cursor-pointer`;

export const labelCls = "text-xs font-medium text-muted-foreground mb-1.5 block";

export const sectionLabelCls = "text-[10px] font-bold text-muted-foreground uppercase tracking-wider";

export const primaryBtnCls =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]";

export const secondaryBtnCls =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/** Compact action button used in the detail sheet. */
export const actionBtnCls =
  "flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * "$1,234.50" / "-20" / "12.5" → integer cents. Returns null for blank or
 * unparseable input (callers decide whether blank means 0).
 */
export function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Integer cents → "1234.50" for an editable input. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Today in the browser's time zone as YYYY-MM-DD. */
export function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The ApiError (or any Error) message, falling back to a generic line. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Toast the outcome of a send (shared with the one-click "Text link" action). */
export function toastDeliveryOutcomes(label: string, email: DeliveryOutcome | null, sms: DeliveryOutcome | null, copy?: DeliveryOutcome | null): void {
  const delivered: string[] = [];
  if (email?.delivered) delivered.push(`emailed${email.to ? ` to ${email.to}` : ""}`);
  if (sms?.delivered) delivered.push(`texted${sms.to ? ` to ${sms.to}` : ""}`);
  toast.success(delivered.length > 0 ? `${label} ${delivered.join(" and ")}` : `${label} marked as sent`);
  if (email && !email.delivered) {
    toast.warning(`Email not delivered: ${email.reason ?? "unknown reason"}. The invoice is still sent — share the pay link another way.`);
  }
  if (sms && !sms.delivered) {
    toast.warning(`Text not delivered: ${sms.reason ?? "unknown reason"}.`);
  }
  if (copy?.delivered) toast.message(`Copy sent to ${copy.to ?? "your inbox"}`);
  else if (copy && !copy.delivered) toast.warning(`Your copy didn't send: ${copy.reason ?? "unknown reason"}.`);
}
