/**
 * Public invoice page — /i/:token
 *
 * The customer-facing invoice + pay surface. Everything on it is the BRAND's:
 * logo, colour, address, reply contact. The platform behind it is never named
 * (see src/test/quote-branding.test.ts).
 *
 * Mobile-first, because most opens are a tap from an email or a text.
 *
 * Money rule: nothing here computes an amount. Every figure comes from the
 * server, and starting a payment sends only the METHOD — the server charges the
 * balance it has on record.
 *
 * Returning from Stripe (`?paid=1`): the URL only says the customer finished
 * checkout, not that money moved. The invoice data is authoritative, so the page
 * re-fetches a few times while the webhook lands and words the banner from the
 * state it gets back.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, Check, CheckCircle2, Copy, Download, FileText, Loader2 } from "lucide-react";

import { ApiError } from "@/lib/api-client";
import { customerSafeMessage } from "@/lib/public-errors";
import {
  fetchPublicInvoice,
  formatCents,
  formatYmd,
  publicInvoicePdfUrl,
  startInvoicePayment,
  type PublicInvoice,
} from "@/lib/invoices-api";

const DEFAULT_PRIMARY = "#1f2937";
const INK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";

/** How often, and how many times, to re-check after a Stripe return. */
const CONFIRM_POLL_MS = 3000;
const CONFIRM_POLL_MAX = 5;

type PayMethod = "card" | "bank_debit";

// ─── Colour helpers ──────────────────────────────────────────────────────────

function parseHex(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Text colour for a button filled with the brand colour: white or near-black,
 * whichever reads better. Unparseable colours are assumed dark.
 */
function textOn(color: string): string {
  const l = luminance(color);
  if (l === null) return "#ffffff";
  const inkL = luminance(INK) ?? 0;
  return contrast(l, 1) >= contrast(l, inkL) ? "#ffffff" : INK;
}

/** The brand colour when it is readable as text on white; near-black otherwise. */
function inkOnWhite(color: string): string {
  const l = luminance(color);
  if (l === null) return color;
  return contrast(l, 1) >= 4.5 ? color : INK;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function longYmd(ymd: string | null): string | null {
  return ymd ? formatYmd(ymd, "long") : null;
}

/** paidAt is a timestamp, not a calendar date. */
function longTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
}

function taxRateLabel(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0$/, "")}%`;
}

function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function isDueOnReceipt(inv: PublicInvoice): boolean {
  return inv.paymentTermsDays === 0 && (!inv.dueDate || inv.dueDate === inv.issueDate);
}

const PAY_FALLBACK = "Something went wrong starting your payment. Please try again, or use one of the other ways to pay below.";

/** Never raw server text: only a message written for the customer, else our own. */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return customerSafeMessage(err.status, err.body, PAY_FALLBACK);
  return PAY_FALLBACK;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PublicInvoicePage() {
  const { token = "" } = useParams();
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Read `?paid=1` once, on first render, before it is stripped from the URL.
  const [returnedFromPay] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("paid") === "1",
  );
  const [pollCount, setPollCount] = useState(0);

  const [starting, setStarting] = useState<PayMethod | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  // Strip `?paid=1` so a refresh or a shared link doesn't replay the thank-you.
  useEffect(() => {
    if (!returnedFromPay) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("paid");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [returnedFromPay]);

  const load = useCallback(async () => {
    try {
      const data = await fetchPublicInvoice(token);
      setInvoice(data);
      setNotFound(false);
      setLoadError(false);
    } catch (err) {
      // Keep whatever is on screen if a background refresh fails.
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setLoadError(true);
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const awaitingConfirmation =
    returnedFromPay &&
    invoice !== null &&
    invoice.state !== "paid" &&
    invoice.state !== "processing" &&
    invoice.state !== "void";
  const stillPolling = awaitingConfirmation && pollCount < CONFIRM_POLL_MAX;

  // After a Stripe return the webhook may not have landed yet: re-check a few times.
  useEffect(() => {
    if (!stillPolling) return;
    const t = window.setTimeout(() => {
      void load().finally(() => setPollCount((n) => n + 1));
    }, CONFIRM_POLL_MS);
    return () => window.clearTimeout(t);
  }, [stillPolling, pollCount, load]);

  const brand = invoice?.brand;
  const primary = brand?.primaryColor || DEFAULT_PRIMARY;
  const onPrimary = textOn(primary);
  const accentText = inkOnWhite(primary);

  /**
   * The tab names the COMPANY, never the platform. Restored on unmount so the
   * operator's tab doesn't keep a customer's company name after navigating back.
   */
  useEffect(() => {
    if (!invoice) return;
    const previous = document.title;
    const label = invoice.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : "Invoice";
    // brand.name falls back to "Invoice" server-side; don't say it twice.
    document.title = invoice.brand.name && invoice.brand.name !== "Invoice" ? `${label} — ${invoice.brand.name}` : label;
    return () => {
      document.title = previous;
    };
  }, [invoice]);

  async function pay(method: PayMethod) {
    setStarting(method);
    setPayError(null);
    try {
      const { url } = await startInvoicePayment(token, method);
      window.location.assign(url);
      // Leave the button in its busy state while the browser navigates away.
    } catch (err) {
      setPayError(errorMessage(err));
      setStarting(null);
    }
  }

  if (loading) {
    return (
      <Shell primary={DEFAULT_PRIMARY}>
        <p role="status" className="flex items-center gap-2" style={{ color: MUTED }}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
        </p>
      </Shell>
    );
  }

  if (notFound || !invoice) {
    return (
      <Shell primary={DEFAULT_PRIMARY}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 8px" }}>
          {notFound || !loadError ? "We couldn't find this invoice" : "We couldn't load this invoice"}
        </h1>
        <p style={{ color: MUTED, margin: 0 }}>
          {notFound || !loadError
            ? "Please check the link in your email or text message."
            : "Please check your connection and refresh the page."}
        </p>
      </Shell>
    );
  }

  const inv = invoice;
  const b = inv.brand;
  const showName = b.name && b.name !== "Invoice" ? b.name : null;
  const isVoid = inv.state === "void";
  const isPaid = inv.state === "paid";
  const canPay = inv.balanceCents > 0 && !isVoid && inv.state !== "processing";
  // While a just-finished checkout is being confirmed, don't invite a second payment.
  const showPay = canPay && !stillPolling;
  const p = inv.payment;
  const anyMethod = p.card || p.bankDebit || Boolean(p.etransfer) || Boolean(p.cheque) || p.cash;
  const busy = starting !== null;

  return (
    <Shell primary={primary}>
      {/* Brand header — the business the customer hired, never the platform. */}
      <header className="mb-6">
        {b.logoUrl ? (
          <img src={b.logoUrl} alt={showName ?? ""} style={{ height: 44, width: "auto", maxWidth: "100%" }} />
        ) : (
          showName && <div style={{ fontSize: 20, fontWeight: 700, color: accentText }}>{showName}</div>
        )}
        {(b.address || b.taxRegistrationNumber) && (
          <div className="mt-2" style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
            {b.address && <div style={{ whiteSpace: "pre-line" }}>{b.address}</div>}
            {b.taxRegistrationNumber && <div>HST/GST #: {b.taxRegistrationNumber}</div>}
          </div>
        )}
      </header>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
            Invoice{inv.invoiceNumber ? ` ${inv.invoiceNumber}` : ""}
          </h1>
          {inv.title && <p style={{ margin: "4px 0 0", color: MUTED, fontSize: 14 }}>{inv.title}</p>}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5" style={{ fontSize: 13, color: MUTED }}>
            {inv.issueDate && (
              <>
                <dt>Issued</dt>
                <dd style={{ margin: 0, color: "#374151" }}>{longYmd(inv.issueDate)}</dd>
              </>
            )}
            <dt>Due</dt>
            <dd style={{ margin: 0, color: "#374151" }}>
              {isDueOnReceipt(inv) ? "Due on receipt" : longYmd(inv.dueDate) ?? "—"}
            </dd>
          </dl>
        </div>
        <StatusBadge invoice={inv} />
      </div>

      {returnedFromPay && <ReturnBanner invoice={inv} polling={stillPolling} />}

      {isPaid && (
        <Panel tone="success">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "#15803d" }} aria-hidden="true" />
            <div>
              <strong>Paid in full</strong>
              <p style={{ margin: "4px 0 0", fontSize: 14 }}>
                {longTimestamp(inv.paidAt) ? `Payment received ${longTimestamp(inv.paidAt)}. ` : ""}
                Thank you for your business.
              </p>
            </div>
          </div>
        </Panel>
      )}

      {isVoid && (
        <Panel tone="neutral">
          <strong>This invoice has been cancelled</strong>
          <p style={{ margin: "4px 0 0", fontSize: 14 }}>
            Nothing is owing on it. If that&apos;s unexpected, please contact {showName ?? "us"}.
          </p>
        </Panel>
      )}

      {/* Bill to */}
      <section aria-labelledby="bill-to" className="mb-6">
        <h2 id="bill-to" style={sectionLabel}>Bill to</h2>
        <div style={{ fontSize: 14, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 600 }}>{inv.billTo.name}</div>
          {inv.billTo.attention && <div>Attn: {inv.billTo.attention}</div>}
          {inv.billTo.address && <div style={{ whiteSpace: "pre-line" }}>{inv.billTo.address}</div>}
          {inv.billTo.email && <div style={{ color: MUTED }}>{inv.billTo.email}</div>}
          {inv.billTo.taxNumber && <div style={{ color: MUTED }}>Tax #: {inv.billTo.taxNumber}</div>}
        </div>
      </section>

      <LineItems invoice={inv} />

      {/* Totals */}
      <section aria-label="Totals" className="py-4" style={{ fontVariantNumeric: "tabular-nums", fontSize: 15 }}>
        <Row label="Subtotal" value={formatCents(inv.subtotalCents, inv.currency)} />
        <Row label={`HST/GST (${taxRateLabel(inv.taxRateBps)})`} value={formatCents(inv.taxCents, inv.currency)} />
        <Row label="Total" value={formatCents(inv.totalCents, inv.currency)} bold />
        {inv.creditCents > 0 && (
          <Row label="Deposit received" value={`−${formatCents(inv.creditCents, inv.currency)}`} />
        )}
        {inv.paidCents > 0 && (
          <Row label="Payments received" value={`−${formatCents(inv.paidCents, inv.currency)}`} />
        )}
        {inv.pendingCents > 0 && (
          <Row label="Bank debit clearing" value={formatCents(inv.pendingCents, inv.currency)} muted />
        )}
      </section>

      <div
        className="mb-6 flex items-baseline justify-between gap-3 rounded-[10px] p-4"
        style={{ background: "#f9fafb", border: `1px solid ${BORDER}` }}
      >
        <strong style={{ fontSize: 16 }}>Balance due</strong>
        <strong style={{ fontSize: 22, color: isVoid ? MUTED : accentText, fontVariantNumeric: "tabular-nums" }}>
          {formatCents(isVoid ? 0 : inv.balanceCents, inv.currency)}
        </strong>
      </div>

      {showPay && (
        <section aria-labelledby="pay-heading" className="mb-6 pt-6" style={{ borderTop: `1px solid ${BORDER}` }}>
          <h2 id="pay-heading" style={{ fontSize: 18, fontWeight: 700, margin: "0 0 14px" }}>
            How to pay
          </h2>

          {payError && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg p-3"
              style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 14 }}
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{payError}</span>
            </div>
          )}

          {(p.card || p.bankDebit) && (
            <div className="mb-5 space-y-4">
              {p.card && (
                <div>
                  <button
                    type="button"
                    onClick={() => void pay("card")}
                    disabled={busy}
                    aria-busy={starting === "card"}
                    className="flex w-full items-center justify-center gap-2 rounded-[10px] px-4 py-4 text-[17px] font-bold outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                    style={{ background: primary, color: onPrimary, ["--tw-ring-color" as string]: accentText }}
                  >
                    {starting === "card" && <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
                    {starting === "card"
                      ? "Starting secure checkout…"
                      : `Pay ${formatCents(inv.balanceCents, inv.currency)} by card`}
                  </button>
                  <p style={{ ...caption, textAlign: "center" }}>Visa, Mastercard, Amex, Apple Pay, Google Pay</p>
                </div>
              )}
              {p.bankDebit && (
                <div>
                  <button
                    type="button"
                    onClick={() => void pay("bank_debit")}
                    disabled={busy}
                    aria-busy={starting === "bank_debit"}
                    className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-white px-4 py-3.5 text-base font-semibold outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                    style={{
                      border: `2px solid ${accentText}`,
                      color: accentText,
                      ["--tw-ring-color" as string]: accentText,
                    }}
                  >
                    {starting === "bank_debit" && <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
                    {starting === "bank_debit" ? "Starting secure checkout…" : "Pay by bank debit"}
                  </button>
                  <p style={{ ...caption, textAlign: "center" }}>
                    Pre-authorized debit from a Canadian bank account. Lower fees; takes a few business days to clear.
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            {p.etransfer && (
              <MethodCard title="Interac e-Transfer">
                <div className="flex flex-wrap items-center gap-2">
                  <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{p.etransfer.email}</span>
                  <CopyButton value={p.etransfer.email} label="Copy e-Transfer email" />
                </div>
                {inv.invoiceNumber && (
                  <p style={{ margin: "6px 0 0" }}>
                    Include <strong>{inv.invoiceNumber}</strong> in the message.
                  </p>
                )}
                {p.etransfer.instructions && (
                  <p style={{ margin: "6px 0 0", color: MUTED, whiteSpace: "pre-line" }}>{p.etransfer.instructions}</p>
                )}
              </MethodCard>
            )}
            {p.cheque && (
              <MethodCard title="Cheque">
                <p style={{ margin: 0 }}>
                  Payable to <strong>{p.cheque.payableTo}</strong>
                </p>
                {p.cheque.mailTo && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ color: MUTED }}>Mail to:</div>
                    <div style={{ whiteSpace: "pre-line" }}>{p.cheque.mailTo}</div>
                  </div>
                )}
              </MethodCard>
            )}
            {p.cash && (
              <MethodCard title="Cash">
                <p style={{ margin: 0 }}>Cash — accepted in person.</p>
              </MethodCard>
            )}
            {!anyMethod && (
              <MethodCard title="Arrange payment">
                <p style={{ margin: 0 }}>Contact {showName ?? "us"} to arrange payment.</p>
                <ContactLines email={b.replyEmail} phone={b.replyPhone} accent={accentText} />
              </MethodCard>
            )}
          </div>
        </section>
      )}

      {inv.notes && (
        <section aria-labelledby="notes-heading" className="mb-5">
          <h2 id="notes-heading" style={sectionLabel}>Notes</h2>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0, fontSize: 14 }}>{inv.notes}</p>
        </section>
      )}

      {inv.footerText && (
        <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 13, color: MUTED, margin: "0 0 20px" }}>
          {inv.footerText}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <a
          href={publicInvoicePdfUrl(token, true)}
          download
          className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ border: `1px solid ${BORDER}`, color: INK, ["--tw-ring-color" as string]: accentText }}
        >
          <Download className="h-4 w-4" aria-hidden="true" /> Download PDF
        </a>
        <a
          href={publicInvoicePdfUrl(token, false)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ border: `1px solid ${BORDER}`, color: INK, ["--tw-ring-color" as string]: accentText }}
        >
          <FileText className="h-4 w-4" aria-hidden="true" /> View PDF
        </a>
      </div>

      <footer className="mt-8 pt-4" style={{ borderTop: `1px solid ${BORDER}`, fontSize: 13, color: MUTED }}>
        {showName && <div style={{ fontWeight: 600, color: "#374151" }}>{showName}</div>}
        <ContactLines email={b.replyEmail} phone={b.replyPhone} accent={accentText} />
        {b.websiteUrl && (
          <div>
            <a href={b.websiteUrl} target="_blank" rel="noopener noreferrer" style={{ color: accentText }}>
              {b.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          </div>
        )}
      </footer>
    </Shell>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const sectionLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: MUTED,
  margin: "0 0 6px",
};

const caption: React.CSSProperties = { fontSize: 12, color: MUTED, margin: "8px 0 0", lineHeight: 1.5 };

function Shell({ children, primary }: { children: React.ReactNode; primary: string }) {
  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: INK }}>
      <div style={{ height: 4, background: primary }} />
      <main
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "24px 20px 64px",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        {children}
      </main>
    </div>
  );
}

function Row({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return (
    <div
      className="flex justify-between gap-3"
      style={{ padding: "5px 0", fontWeight: bold ? 700 : 400, color: muted ? MUTED : undefined }}
    >
      <span>{label}</span>
      <span style={{ whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

function Panel({ tone, children }: { tone: "success" | "info" | "warning" | "neutral"; children: React.ReactNode }) {
  const palette = {
    success: { bg: "#f0fdf4", border: "#bbf7d0" },
    info: { bg: "#eff6ff", border: "#bfdbfe" },
    warning: { bg: "#fffbeb", border: "#fde68a" },
    neutral: { bg: "#f9fafb", border: BORDER },
  }[tone];
  return (
    <div
      className="mb-5 rounded-[10px] p-4"
      style={{ background: palette.bg, border: `1px solid ${palette.border}` }}
    >
      {children}
    </div>
  );
}

function StatusBadge({ invoice }: { invoice: PublicInvoice }) {
  const due = isDueOnReceipt(invoice) ? "Due on receipt" : invoice.dueDate ? `Due ${formatYmd(invoice.dueDate)}` : "Due";
  const map: Record<PublicInvoice["state"], { label: string; bg: string; fg: string; border: string }> = {
    open: { label: due, bg: "#f3f4f6", fg: "#374151", border: "#e5e7eb" },
    overdue: { label: "Overdue", bg: "#fef2f2", fg: "#b91c1c", border: "#fecaca" },
    partially_paid: { label: "Partly paid", bg: "#fffbeb", fg: "#92400e", border: "#fde68a" },
    processing: { label: "Payment processing", bg: "#eff6ff", fg: "#1d4ed8", border: "#bfdbfe" },
    paid: { label: "Paid", bg: "#f0fdf4", fg: "#15803d", border: "#bbf7d0" },
    void: { label: "Void", bg: "#f3f4f6", fg: "#4b5563", border: "#d1d5db" },
  };
  const s = map[invoice.state];
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-[13px] font-semibold"
      style={{ background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {s.label}
    </span>
  );
}

/** Shown once after a Stripe return. Worded from the invoice's actual state. */
function ReturnBanner({ invoice, polling }: { invoice: PublicInvoice; polling: boolean }) {
  if (invoice.state === "void") return null;

  if (invoice.state === "paid") {
    return (
      <Panel tone="success">
        <strong role="status">Thank you — your payment was received.</strong>
      </Panel>
    );
  }

  if (invoice.state === "processing") {
    return (
      <Panel tone="info">
        <strong role="status">Thank you — your bank debit is processing.</strong>
        <p style={{ margin: "4px 0 0", fontSize: 14 }}>
          Bank debits take a few business days to clear. There&apos;s nothing more you need to do.
        </p>
      </Panel>
    );
  }

  if (polling) {
    return (
      <Panel tone="info">
        <div role="status" className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <strong>Your payment is being confirmed — this page will update shortly.</strong>
        </div>
      </Panel>
    );
  }

  return (
    <Panel tone="warning">
      <strong role="status">We haven&apos;t been able to confirm your payment yet.</strong>
      <p style={{ margin: "4px 0 0", fontSize: 14 }}>
        If you completed checkout, it may take a few minutes to show here — please refresh the page shortly before
        trying again.
      </p>
    </Panel>
  );
}

function LineItems({ invoice }: { invoice: PublicInvoice }) {
  const money = (c: number) => formatCents(c, invoice.currency);
  return (
    <section aria-label="Line items" style={{ fontVariantNumeric: "tabular-nums" }}>
      {/* Desktop / tablet: a real table. */}
      <table className="hidden w-full border-collapse sm:table" style={{ fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${BORDER}`, color: MUTED, fontSize: 12 }}>
            <th scope="col" className="py-2 pr-3 text-left font-semibold uppercase tracking-wide">Description</th>
            <th scope="col" className="py-2 px-3 text-right font-semibold uppercase tracking-wide">Qty</th>
            <th scope="col" className="py-2 px-3 text-right font-semibold uppercase tracking-wide">Unit price</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold uppercase tracking-wide">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${BORDER}`, verticalAlign: "top" }}>
              <td className="py-3 pr-3">
                <div style={{ fontWeight: 600 }}>{line.label}</div>
                {line.description && line.description !== line.label && (
                  <div style={{ fontSize: 13, color: MUTED, marginTop: 2, whiteSpace: "pre-line" }}>{line.description}</div>
                )}
              </td>
              <td className="whitespace-nowrap py-3 px-3 text-right">{formatQty(line.quantity)}</td>
              <td className="whitespace-nowrap py-3 px-3 text-right">{money(line.unitPriceCents)}</td>
              <td className="whitespace-nowrap py-3 pl-3 text-right">{money(line.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phone: stacked rows. */}
      <ul className="m-0 list-none p-0 sm:hidden" style={{ borderTop: `1px solid ${BORDER}` }}>
        {invoice.lines.map((line, i) => (
          <li key={i} className="flex gap-3 py-3.5" style={{ borderBottom: `1px solid ${BORDER}` }}>
            <div className="min-w-0 flex-1">
              <div style={{ fontWeight: 600 }}>{line.label}</div>
              {line.description && line.description !== line.label && (
                <div style={{ fontSize: 13, color: MUTED, marginTop: 2, whiteSpace: "pre-line" }}>{line.description}</div>
              )}
              {line.quantity !== 1 && (
                <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
                  {formatQty(line.quantity)} × {money(line.unitPriceCents)}
                </div>
              )}
            </div>
            <div className="whitespace-nowrap">{money(line.amountCents)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MethodCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] p-4" style={{ border: `1px solid ${BORDER}`, fontSize: 14, lineHeight: 1.5 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>{title}</h3>
      {children}
    </div>
  );
}

function ContactLines({ email, phone, accent }: { email: string | null; phone: string | null; accent: string }) {
  if (!email && !phone) return null;
  return (
    <>
      {phone && (
        <div>
          <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} style={{ color: accent }}>{phone}</a>
        </div>
      )}
      {email && (
        <div>
          <a href={`mailto:${email}`} style={{ color: accent, wordBreak: "break-all" }}>{email}</a>
        </div>
      )}
    </>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (insecure context, permissions). The address is
      // on screen and selectable, so failing quietly is fine.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : label}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-400"
      style={{ border: `1px solid ${BORDER}`, color: "#374151" }}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
