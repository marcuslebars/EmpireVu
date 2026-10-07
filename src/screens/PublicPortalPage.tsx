/**
 * Customer portal — /p/:token
 *
 * The customer's own page with the brand: upcoming visits, quotes, invoices and
 * receipts, pay any balance, and ask for more work. Everything on it is the BRAND's
 * (logo, colour, contact); the platform behind it is never named.
 * Mobile-first: most opens are a tap from a text.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, CalendarDays, CheckCircle2, FileText, Globe, Loader2, Mail, MapPin, Phone, Receipt, Send } from "lucide-react";

import { ApiError } from "@/lib/api-client";
import { inkOnWhite, textOn } from "@/lib/brand-colors";
import { formatCents, formatYmd } from "@/lib/invoices-api";
import { fetchPortal, requestPortalWork, type Portal, type PortalInvoice, type PortalQuote, type PortalVisit } from "@/lib/portal-api";
import { useCustomerFavicon } from "@/lib/brand-context";

const DEFAULT_PRIMARY = "#1f2937";
const INK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";
/** A weekly customer has a long list — show the next few, the rest on request. */
const UPCOMING_PREVIEW = 4;

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white border p-5" style={{ borderColor: BORDER }}>
      <h2 className="flex items-center gap-2 text-sm font-semibold mb-3" style={{ color: INK }}>
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: "green" | "amber" | "red" | "gray" | "blue"; children: React.ReactNode }) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    gray: "bg-gray-50 text-gray-600 border-gray-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  } as const;
  return <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

const VISIT_PILL: Record<PortalVisit["status"], [string, "green" | "amber" | "blue" | "gray"]> = {
  upcoming: ["Booked", "gray"],
  on_the_way: ["On the way", "blue"],
  in_progress: ["In progress", "amber"],
  done: ["Done", "green"],
};

const INVOICE_PILL: Record<PortalInvoice["status"], [string, "green" | "amber" | "red" | "blue"]> = {
  due: ["Due", "amber"],
  overdue: ["Overdue", "red"],
  processing: ["Processing", "blue"],
  paid: ["Paid", "green"],
};

const QUOTE_PILL: Record<PortalQuote["status"], [string, "blue" | "green" | "gray"]> = {
  open: ["Awaiting your OK", "blue"],
  approved: ["Approved", "green"],
  expired: ["Expired", "gray"],
};

function RequestWork({ token, primary, onPrimary, brandName }: { token: string; primary: string; onPrimary: string; brandName: string }) {
  const [message, setMessage] = useState("");
  const [date, setDate] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim().length < 3) return setError("Tell us a little about what you need.");
    setState("sending");
    setError(null);
    try {
      await requestPortalWork(token, message.trim(), date || null);
      setState("sent");
    } catch (err) {
      setState("idle");
      setError(err instanceof ApiError && err.status === 429 ? "You've sent a few requests already — we'll be in touch soon." : "Couldn't send that. Please try again.");
    }
  };

  if (state === "sent") {
    return (
      <p className="flex items-start gap-2 text-sm" style={{ color: INK }}>
        <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" />
        Thanks — {brandName || "we"} got your request and will be in touch.
      </p>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <textarea
        aria-label="What do you need?"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="What do you need done?"
        className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-2"
        style={{ borderColor: BORDER, color: INK }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs" style={{ color: MUTED }}>
          Preferred date (optional)
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="block mt-1 rounded-lg border px-2 py-1.5 text-sm"
            style={{ borderColor: BORDER, color: INK }}
          />
        </label>
        <button
          type="submit"
          disabled={state === "sending"}
          className="ml-auto self-end flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
          style={{ background: primary, color: onPrimary }}
        >
          {state === "sending" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send request
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

export default function PublicPortalPage() {
  const { token = "" } = useParams();
  const [portal, setPortal] = useState<Portal | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [showPast, setShowPast] = useState(false);
  const [allUpcoming, setAllUpcoming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPortal(token)
      .then((p) => {
        if (cancelled) return;
        setPortal(p);
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus(err instanceof ApiError && err.status === 404 ? "notfound" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useCustomerFavicon(portal?.brand.logoUrl);
  // The tab names the company, never the platform.
  useEffect(() => {
    if (!portal) return;
    const previous = document.title;
    document.title = portal.brand.name ? `Your account — ${portal.brand.name}` : "Your account";
    return () => {
      document.title = previous;
    };
  }, [portal]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (status !== "ready" || !portal) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
        <div className="max-w-sm text-center space-y-2">
          <AlertCircle className="w-8 h-8 mx-auto text-gray-400" />
          <p className="text-base font-semibold" style={{ color: INK }}>
            {status === "notfound" ? "This link isn't active" : "Couldn't load your account"}
          </p>
          <p className="text-sm" style={{ color: MUTED }}>
            {status === "notfound" ? "It may have been replaced with a new one. Ask the business to send you a fresh link." : "Please refresh the page in a moment."}
          </p>
        </div>
      </div>
    );
  }

  const { brand } = portal;
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const onPrimary = textOn(primary);
  const accent = inkOnWhite(primary);
  const unpaid = portal.invoices.filter((i) => i.status === "due" || i.status === "overdue");
  const payTarget = unpaid.length === 1 ? unpaid[0].url : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b" style={{ borderColor: BORDER }}>
        <div className="max-w-2xl mx-auto px-5 py-4 flex items-center gap-3">
          {brand.logoUrl ? (
            <img src={brand.logoUrl} alt={brand.name} className="h-9 w-auto max-w-[160px] object-contain" />
          ) : (
            <span className="text-lg font-bold" style={{ color: accent }}>
              {brand.name}
            </span>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: INK }}>
            Hi {portal.customerName}
          </h1>
          <p className="text-sm mt-1" style={{ color: MUTED }}>
            Your visits, quotes and invoices with {brand.name || "us"}.
          </p>
        </div>

        {portal.balanceCents > 0 && (
          <section className="rounded-2xl p-5 flex flex-wrap items-center justify-between gap-3" style={{ background: primary, color: onPrimary }}>
            <div>
              <p className="text-sm opacity-90">Balance owing</p>
              <p className="text-3xl font-bold tabular-nums">{formatCents(portal.balanceCents, portal.currency)}</p>
              {portal.overdueCents > 0 && <p className="text-xs mt-1 opacity-90">{formatCents(portal.overdueCents, portal.currency)} is past due</p>}
            </div>
            <a
              href={payTarget ?? "#invoices"}
              className="rounded-xl px-5 py-3 text-sm font-semibold"
              style={{ background: onPrimary, color: primary === onPrimary ? INK : primary }}
            >
              {payTarget ? "Pay now" : "See invoices"}
            </a>
          </section>
        )}

        <Card title="Upcoming visits" icon={<CalendarDays className="w-4 h-4" style={{ color: accent }} />}>
          {portal.upcoming.length === 0 ? (
            <p className="text-sm" style={{ color: MUTED }}>
              Nothing booked right now.
            </p>
          ) : (
            <ul className="divide-y divide-gray-200">
              {(allUpcoming ? portal.upcoming : portal.upcoming.slice(0, UPCOMING_PREVIEW)).map((v, i) => (
                <li key={i} className="py-3 first:pt-0 last:pb-0 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: INK }}>
                      {v.title}
                    </p>
                    <p className="text-sm" style={{ color: MUTED }}>
                      {v.when}
                    </p>
                    {v.location && (
                      <p className="text-xs flex items-center gap-1 mt-0.5" style={{ color: MUTED }}>
                        <MapPin className="w-3 h-3" /> {v.location}
                      </p>
                    )}
                  </div>
                  <Pill tone={VISIT_PILL[v.status][1]}>{VISIT_PILL[v.status][0]}</Pill>
                </li>
              ))}
            </ul>
          )}
          {portal.upcoming.length > UPCOMING_PREVIEW && (
            <button type="button" onClick={() => setAllUpcoming((a) => !a)} className="mt-3 text-sm font-medium" style={{ color: accent }}>
              {allUpcoming ? "Show fewer" : `Show all ${portal.upcoming.length} visits`}
            </button>
          )}
        </Card>

        {portal.quotes.length > 0 && (
          <Card title="Quotes" icon={<FileText className="w-4 h-4" style={{ color: accent }} />}>
            <ul className="divide-y divide-gray-200">
              {portal.quotes.map((q, i) => (
                <li key={i} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: INK }}>
                      {q.title || "Quote"} {q.number && <span className="font-normal" style={{ color: MUTED }}>· {q.number}</span>}
                    </p>
                    <p className="text-sm tabular-nums" style={{ color: MUTED }}>
                      {formatCents(q.totalCents, portal.currency)}
                      {q.status === "open" && q.validUntil && ` · good until ${formatYmd(q.validUntil, "long")}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Pill tone={QUOTE_PILL[q.status][1]}>{QUOTE_PILL[q.status][0]}</Pill>
                    <a href={q.url} className="text-sm font-semibold" style={{ color: accent }}>
                      {q.status === "open" ? "Review" : "View"}
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div id="invoices">
          <Card title="Invoices & receipts" icon={<Receipt className="w-4 h-4" style={{ color: accent }} />}>
            {portal.invoices.length === 0 ? (
              <p className="text-sm" style={{ color: MUTED }}>
                No invoices yet.
              </p>
            ) : (
              <ul className="divide-y divide-gray-200">
                {portal.invoices.map((inv, i) => (
                  <li key={i} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: INK }}>
                        {inv.number ?? "Invoice"} {inv.title && <span className="font-normal" style={{ color: MUTED }}>· {inv.title}</span>}
                      </p>
                      <p className="text-sm tabular-nums" style={{ color: MUTED }}>
                        {inv.status === "paid"
                          ? `${formatCents(inv.totalCents, portal.currency)} · paid`
                          : `${formatCents(inv.balanceCents, portal.currency)} owing${inv.dueDate ? ` · due ${formatYmd(inv.dueDate, "long")}` : ""}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Pill tone={INVOICE_PILL[inv.status][1]}>{INVOICE_PILL[inv.status][0]}</Pill>
                      <a
                        href={inv.url}
                        className="text-sm font-semibold rounded-lg px-3 py-1.5"
                        style={inv.status === "due" || inv.status === "overdue" ? { background: primary, color: onPrimary } : { color: accent }}
                      >
                        {inv.status === "due" || inv.status === "overdue" ? "Pay" : "View"}
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title="Need something done?" icon={<Send className="w-4 h-4" style={{ color: accent }} />}>
          <RequestWork token={token} primary={primary} onPrimary={onPrimary} brandName={brand.name} />
        </Card>

        {portal.past.length > 0 && (
          <section>
            <button type="button" onClick={() => setShowPast((s) => !s)} className="text-sm font-medium" style={{ color: accent }}>
              {showPast ? "Hide" : "Show"} past visits ({portal.past.length})
            </button>
            {showPast && (
              <ul className="mt-2 rounded-2xl bg-white border border-gray-200 divide-y divide-gray-200">
                {portal.past.map((v, i) => (
                  <li key={i} className="px-5 py-3 flex items-center justify-between gap-3">
                    <span className="text-sm" style={{ color: INK }}>
                      {v.title}
                    </span>
                    <span className="text-xs" style={{ color: MUTED }}>
                      {v.when}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <footer className="pt-4 pb-8 text-sm space-y-1.5" style={{ color: MUTED }}>
          <p className="font-semibold" style={{ color: INK }}>
            {brand.name}
          </p>
          {brand.replyPhone && (
            <a href={`tel:${brand.replyPhone}`} className="flex items-center gap-2">
              <Phone className="w-3.5 h-3.5" /> {brand.replyPhone}
            </a>
          )}
          {brand.replyEmail && (
            <a href={`mailto:${brand.replyEmail}`} className="flex items-center gap-2">
              <Mail className="w-3.5 h-3.5" /> {brand.replyEmail}
            </a>
          )}
          {brand.websiteUrl && (
            <a href={brand.websiteUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2">
              <Globe className="w-3.5 h-3.5" /> {brand.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          )}
          <p className="text-xs pt-2">This page is private to you — please don't share the link.</p>
        </footer>
      </main>
    </div>
  );
}
