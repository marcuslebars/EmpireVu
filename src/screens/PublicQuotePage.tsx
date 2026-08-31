/**
 * Public quote page — /q/:token
 *
 * The customer-facing surface. Everything on it is the BRAND's: logo, colours,
 * policy text, reply contact. EmpireVu is the backend and is never named here.
 *
 * Mobile-first, because almost every open is a phone tap from an email or text.
 *
 * Money rule: the client sends WHICH optional lines are ticked and the server
 * returns the amounts. Nothing here computes a price, and nothing here is
 * trusted at approval — the server recomputes from stored inputs and freezes the
 * result. So a customer editing this page can change their selection (theirs to
 * choose) but never a price.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

interface PublicLine {
  serviceId: string;
  label: string;
  description: string;
  amountCents: number;
  optional: boolean;
  selected: boolean;
  custom: boolean;
}

interface Brand {
  name: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  websiteUrl: string | null;
  replyEmail: string | null;
  replyPhone: string | null;
  termsText: string | null;
  cancellationPolicy: string | null;
}

interface PublicQuote {
  token: string;
  quoteNumber: string | null;
  title: string | null;
  introMessage: string | null;
  currency: string;
  state: "active" | "expired" | "replaced" | "confirmed" | "cancelled";
  sentAt: string | null;
  validUntil: string | null;
  lineItems: PublicLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
  taxRateBps: number;
  depositRateBps: number;
  approvedByName: string | null;
  depositPaidAt: string | null;
  brand: Brand;
}

interface Totals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
  lineItems: PublicLine[];
}

const DEFAULT_PRIMARY = "#1f2937";

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);
}

function longDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
}

/** Stable key for a line — `custom:{i}` for hand-priced lines, service id otherwise. */
function lineKey(line: PublicLine, index: number) {
  return line.custom ? `custom:${index}` : line.serviceId;
}

export default function PublicQuotePage() {
  const { token = "" } = useParams();
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [terms, setTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/quotes/${encodeURIComponent(token)}`);
        if (!res.ok) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const { data } = await res.json();
        if (cancelled) return;
        setQuote(data as PublicQuote);
        const initial = new Set<string>(
          (data.lineItems as PublicLine[])
            .map((l, i) => (l.optional && l.selected ? lineKey(l, i) : null))
            .filter((v): v is string => v !== null),
        );
        setSelected(initial);
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Reprice on every toggle. The server is the only thing that knows what a
  // selection costs.
  const reprice = useCallback(
    async (next: Set<string>) => {
      try {
        const res = await fetch(`/api/public/quotes/${encodeURIComponent(token)}/reprice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected: [...next] }),
        });
        if (!res.ok) return;
        const { data } = await res.json();
        setTotals(data as Totals);
      } catch {
        // Leave the last known totals on screen rather than flashing a wrong number.
      }
    },
    [token],
  );

  const brand = quote?.brand;
  const primary = brand?.primaryColor || DEFAULT_PRIMARY;

  /**
   * The tab says the COMPANY's name, not the platform's.
   *
   * index.html ships a single static <title>EmpireVu</title> for the whole SPA,
   * which is right for the hub and wrong here: this is the one page a customer
   * sees, on the company's own domain, at the moment they are about to enter a
   * card. A tab reading the name of a business they have never heard of
   * undermines exactly the trust the rest of this page is built to earn.
   *
   * Restored on unmount so navigating back into the hub does not leave a
   * customer's company name on the operator's tab.
   */
  useEffect(() => {
    if (!brand?.name) return;
    const previous = document.title;
    document.title = quote?.quoteNumber
      ? `Quote ${quote.quoteNumber} — ${brand.name}`
      : `Your quote — ${brand.name}`;
    return () => {
      document.title = previous;
    };
  }, [brand?.name, quote?.quoteNumber]);
  const view = totals ?? quote;
  const lines = (totals?.lineItems ?? quote?.lineItems ?? []) as PublicLine[];
  const canApprove = quote?.state === "active";
  const depositPct = useMemo(
    () => Math.round((quote?.depositRateBps ?? 2500) / 100),
    [quote?.depositRateBps],
  );

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
    void reprice(next);
  }

  async function approve() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/quotes/${encodeURIComponent(token)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: name.trim(), termsAccepted: terms, selected: [...selected] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Something went wrong. Please try again.");
        return;
      }
      // Straight to Stripe — no interstitial. The customer taps Approve and the
      // next thing they see is the card form.
      window.location.href = body.data.checkoutUrl;
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <Shell primary={DEFAULT_PRIMARY}><p style={{ color: "#6b7280" }}>Loading…</p></Shell>;
  }

  if (notFound || !quote || !view) {
    return (
      <Shell primary={DEFAULT_PRIMARY}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 8px" }}>Quote not found</h1>
        <p style={{ color: "#6b7280", margin: 0 }}>
          This link may have expired or been mistyped. Please check the link in your email.
        </p>
      </Shell>
    );
  }

  return (
    <Shell primary={primary}>
      {/* Brand header — the customer's supplier, never the platform. */}
      <header style={{ marginBottom: 24 }}>
        {brand?.logoUrl ? (
          <img src={brand.logoUrl} alt={brand.name ?? ""} style={{ height: 44, width: "auto" }} />
        ) : (
          brand?.name && <div style={{ fontSize: 20, fontWeight: 700, color: primary }}>{brand.name}</div>
        )}
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{quote.title ?? "Your quote"}</h1>
          {quote.quoteNumber && (
            <p style={{ margin: "4px 0 0", color: "#6b7280", fontSize: 14 }}>{quote.quoteNumber}</p>
          )}
        </div>
        <div style={{ textAlign: "right", fontSize: 13, color: "#6b7280" }}>
          {longDate(quote.sentAt) && <div>Sent {longDate(quote.sentAt)}</div>}
          {longDate(quote.validUntil) && <div>Valid until {longDate(quote.validUntil)}</div>}
        </div>
      </div>

      <StateBanner quote={quote} primary={primary} />

      {quote.introMessage && (
        <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, margin: "0 0 24px" }}>{quote.introMessage}</p>
      )}

      <section style={{ borderTop: "1px solid #e5e7eb" }}>
        {lines.map((line, i) => {
          const key = lineKey(line, i);
          const isOn = line.optional ? selected.has(key) : true;
          return (
            <div
              key={key}
              style={{
                display: "flex",
                gap: 12,
                padding: "14px 0",
                borderBottom: "1px solid #e5e7eb",
                opacity: line.optional && !isOn ? 0.55 : 1,
              }}
            >
              {line.optional && (
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={!canApprove}
                  onChange={() => toggle(key)}
                  aria-label={`Include ${line.label}`}
                  style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0, accentColor: primary }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{line.label}</div>
                {line.description && line.description !== line.label && (
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{line.description}</div>
                )}
                {line.optional && (
                  <div style={{ fontSize: 12, color: primary, marginTop: 4, fontWeight: 600 }}>Optional</div>
                )}
              </div>
              <div style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {money(line.amountCents, quote.currency)}
              </div>
            </div>
          );
        })}
      </section>

      <section style={{ padding: "16px 0", fontVariantNumeric: "tabular-nums" }}>
        <Row label="Subtotal" value={money(view.subtotalCents, quote.currency)} />
        <Row label={`HST (${(quote.taxRateBps / 100).toFixed(0)}%)`} value={money(view.taxCents, quote.currency)} />
        <Row label="Total" value={money(view.totalCents, quote.currency)} bold />
      </section>

      <div style={{ background: "#f9fafb", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <strong>Due today</strong>
          <strong style={{ fontSize: 20, color: primary }}>{money(view.depositCents, quote.currency)}</strong>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#6b7280" }}>
          {depositPct}% deposit locks in your spot. The balance is due later.
        </p>
      </div>

      {brand?.cancellationPolicy && (
        <p style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>{brand.cancellationPolicy}</p>
      )}

      {canApprove && (
        <section style={{ marginTop: 24, borderTop: "1px solid #e5e7eb", paddingTop: 24 }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }} htmlFor="approve-name">
            Type your full name to approve
          </label>
          <input
            id="approve-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="Your full name"
            style={{
              width: "100%", padding: "12px 14px", fontSize: 16, borderRadius: 8,
              border: "1px solid #d1d5db", boxSizing: "border-box",
            }}
          />

          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "14px 0" }}>
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0, accentColor: primary }}
            />
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>
              {brand?.termsText ?? "I approve this quote and agree to the terms above."}
            </span>
          </label>

          {error && (
            <p role="alert" style={{ color: "#b91c1c", fontSize: 14, margin: "0 0 12px" }}>{error}</p>
          )}

          <button
            type="button"
            onClick={approve}
            disabled={submitting || name.trim().length < 2 || !terms}
            style={{
              width: "100%", padding: "16px", fontSize: 17, fontWeight: 700, color: "#fff",
              background: primary, border: "none", borderRadius: 10,
              opacity: submitting || name.trim().length < 2 || !terms ? 0.5 : 1,
              cursor: submitting ? "wait" : "pointer",
            }}
          >
            {submitting ? "Starting secure checkout…" : `Approve & pay ${money(view.depositCents, quote.currency)}`}
          </button>
          <p style={{ fontSize: 12, color: "#6b7280", textAlign: "center", margin: "10px 0 0" }}>
            Card payment is handled securely by Stripe.
          </p>
        </section>
      )}

      <footer style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid #e5e7eb", fontSize: 13, color: "#6b7280" }}>
        {brand?.name && <div style={{ fontWeight: 600, color: "#374151" }}>{brand.name}</div>}
        {brand?.replyPhone && <div>{brand.replyPhone}</div>}
        {brand?.replyEmail && <div>{brand.replyEmail}</div>}
        {brand?.websiteUrl && (
          <div><a href={brand.websiteUrl} style={{ color: primary }}>{brand.websiteUrl.replace(/^https:\/\//, "")}</a></div>
        )}
      </footer>
    </Shell>
  );
}

function Shell({ children, primary }: { children: React.ReactNode; primary: string }) {
  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#111827" }}>
      <div style={{ height: 4, background: primary }} />
      <main
        style={{
          maxWidth: 640, margin: "0 auto", padding: "24px 20px 64px",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        {children}
      </main>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontWeight: bold ? 700 : 400 }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The non-active states. Each says plainly what happened and what to do next. */
function StateBanner({ quote, primary }: { quote: PublicQuote; primary: string }) {
  if (quote.state === "active") return null;

  const box = (bg: string, border: string, children: React.ReactNode) => (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
      {children}
    </div>
  );
  const contact = quote.brand.replyPhone
    ? `text or call us at ${quote.brand.replyPhone}`
    : "reply to our email";

  if (quote.state === "expired") {
    return box("#fffbeb", "#fde68a", (
      <>
        <strong>This quote has expired.</strong>
        <p style={{ margin: "6px 0 0", fontSize: 14 }}>
          Prices change between seasons, so we can&apos;t take it as-is — but {contact} and we&apos;ll refresh it for you.
        </p>
      </>
    ));
  }

  if (quote.state === "replaced") {
    return box("#eff6ff", "#bfdbfe", (
      <>
        <strong>This quote has been replaced.</strong>
        <p style={{ margin: "6px 0 0", fontSize: 14 }}>
          We sent you an updated one — please check your email for the newest version.
        </p>
      </>
    ));
  }

  if (quote.state === "cancelled") {
    return box("#f9fafb", "#e5e7eb", (
      <>
        <strong>This quote is no longer active.</strong>
        <p style={{ margin: "6px 0 0", fontSize: 14 }}>If that&apos;s unexpected, {contact}.</p>
      </>
    ));
  }

  // confirmed
  return box("#f0fdf4", "#bbf7d0", (
    <>
      <strong style={{ color: primary }}>
        {quote.depositPaidAt ? "Deposit received — you're booked in." : "Thanks — this quote is approved."}
      </strong>
      <p style={{ margin: "6px 0 0", fontSize: 14 }}>
        {quote.approvedByName && <>Approved by {quote.approvedByName}. </>}
        {quote.depositPaidAt
          ? "We'll be in touch to schedule your drop-off."
          : "We're just waiting on the deposit to confirm your spot."}
      </p>
    </>
  ));
}
