/**
 * Online booking — /book/:companyId
 *
 * The brand's own booking page: pick a service (from its price list), pick one of its real
 * open times (its booking windows, or its bookable hours), leave your details — and, when
 * the brand takes deposits, pay one to hold the slot. Everything on it is the BRAND's (logo,
 * colour, phone); the platform behind it is never named. Mobile-first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, ArrowLeft, CalendarDays, CheckCircle2, Clock, Loader2, Phone } from "lucide-react";

import TurnstileWidget from "@/components/TurnstileWidget";
import { inkOnWhite, textOn } from "@/lib/brand-colors";
import type { PortalBrand } from "@/lib/portal-api";
import { useDocumentTitle } from "@/lib/use-document-title";

const DEFAULT_PRIMARY = "#1f2937";
const INK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";

interface Service {
  id: string;
  label: string;
  description: string | null;
  priceCents: number | null;
  priceLabel: string | null;
  depositCents: number | null;
}

interface OpenTime {
  startsAt: string;
  day: string;
  dayLabel: string;
  label: string;
  windowKey: string | null;
  durationMinutes: number;
}

interface BookingPage {
  company: { id: string; name: string };
  brand: PortalBrand;
  timezone: string;
  mode: "windows" | "hourly";
  services: Service[];
  requireService: boolean;
  times: OpenTime[];
}

interface Booked {
  scheduledFor: string;
  dayLabel: string;
  label: string;
  status: "confirmed" | "pending";
  manageUrl: string | null;
  deposit: { cents: number; payUrl: string; holdUntil: string } | null;
}

type Step = "service" | "time" | "details";

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export default function PublicBookingPage() {
  const { companyId = "" } = useParams<{ companyId: string }>();
  const [status, setStatus] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [page, setPage] = useState<BookingPage | null>(null);
  const [step, setStep] = useState<Step>("time");
  const [service, setService] = useState<Service | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<OpenTime | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);

  // Abuse controls: a honeypot the visitor never sees, a "form opened at" timestamp (a
  // sub-3s submit is a bot), and a Turnstile token when configured.
  const websiteRef = useRef<HTMLInputElement>(null);
  const [formStartedAt] = useState(() => Date.now());
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const handleTurnstileToken = useCallback((token: string | null) => setTurnstileToken(token), []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(companyId)}`);
      if (!res.ok) {
        setStatus(res.status === 404 ? "notfound" : "error");
        return;
      }
      const json = (await res.json()) as { data: BookingPage };
      setPage(json.data);
      setStatus("ready");
      return json.data;
    } catch {
      setStatus("error");
    }
  }, [companyId]);

  useEffect(() => {
    void load().then((p) => {
      if (p && p.services.length > 0) setStep("service");
    });
  }, [load]);

  useDocumentTitle(page?.brand.name ? `Book with ${page.brand.name}` : page ? `Book with ${page.company.name}` : null);

  const days = useMemo(() => {
    const map = new Map<string, { day: string; label: string; times: OpenTime[] }>();
    for (const t of page?.times ?? []) {
      const d = map.get(t.day) ?? { day: t.day, label: t.dayLabel, times: [] };
      d.times.push(t);
      map.set(t.day, d);
    }
    return [...map.values()];
  }, [page]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!time || !name.trim() || !email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(companyId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          location: location.trim() || undefined,
          notes: notes.trim() || undefined,
          serviceId: service?.id ?? null,
          startsAt: time.startsAt,
          windowKey: time.windowKey,
          website: websiteRef.current?.value || undefined,
          formStartedAt,
          turnstileToken: turnstileToken ?? undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: Booked; error?: string };
      if (!res.ok || !json.data) {
        setError(json.error || "Couldn't book that. Please try again.");
        if (res.status === 400 && /no longer available/i.test(json.error ?? "")) {
          setTime(null);
          setStep("time");
          void load();
        }
        return;
      }
      setBooked(json.data);
    } catch {
      setError("Couldn't book that. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (status !== "ready" || !page) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
        <div className="max-w-sm text-center space-y-2">
          <AlertCircle className="w-8 h-8 mx-auto text-gray-400" />
          <p className="text-base font-semibold" style={{ color: INK }}>
            {status === "notfound" ? "Online booking isn't available" : "Couldn't load the booking page"}
          </p>
          <p className="text-sm" style={{ color: MUTED }}>
            {status === "notfound" ? "Please contact the business to book." : "Please refresh the page in a moment."}
          </p>
        </div>
      </div>
    );
  }

  const { brand } = page;
  const brandName = brand.name || page.company.name;
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const onPrimary = textOn(primary);
  const accent = inkOnWhite(primary);
  const primaryBtn = "w-full rounded-xl px-5 py-3.5 text-base font-semibold disabled:opacity-50";
  const inputCls = "w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-2";
  const pickedDay = days.find((d) => d.day === day) ?? days[0];
  const chosenDeposit = service?.depositCents ?? null;

  const header = (
    <header className="bg-white border-b" style={{ borderColor: BORDER }}>
      <div className="max-w-lg mx-auto px-5 py-4 flex items-center gap-3">
        {brand.logoUrl ? (
          <img src={brand.logoUrl} alt={brandName} className="h-9 w-auto max-w-[160px] object-contain" />
        ) : (
          <span className="text-lg font-bold" style={{ color: accent }}>
            {brandName}
          </span>
        )}
      </div>
    </header>
  );

  if (booked) {
    return (
      <div className="min-h-screen bg-gray-50">
        {header}
        <main className="max-w-lg mx-auto px-5 py-8 space-y-4">
          {booked.deposit ? (
            <section className="rounded-2xl bg-white border p-6 space-y-4" style={{ borderColor: BORDER }}>
              <h1 className="text-xl font-bold" style={{ color: INK }}>
                One more step: pay the deposit
              </h1>
              <p className="text-sm" style={{ color: MUTED }}>
                We're holding <span className="font-semibold" style={{ color: INK }}>{booked.dayLabel}, {booked.label}</span> for you. Pay the{" "}
                {dollars(booked.deposit.cents)} deposit by{" "}
                {new Date(booked.deposit.holdUntil).toLocaleTimeString("en-CA", { timeZone: page.timezone, hour: "numeric", minute: "2-digit" })} to confirm it. It comes off your final bill.
              </p>
              <a href={booked.deposit.payUrl} className={`${primaryBtn} block text-center`} style={{ background: primary, color: onPrimary }}>
                Pay {dollars(booked.deposit.cents)} deposit
              </a>
            </section>
          ) : (
            <section className="rounded-2xl bg-white border p-6 space-y-3 text-center" style={{ borderColor: BORDER }}>
              <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-600" />
              <h1 className="text-xl font-bold" style={{ color: INK }}>
                {booked.status === "confirmed" ? "You're booked" : "Request sent"}
              </h1>
              <p className="text-sm" style={{ color: MUTED }}>
                {booked.dayLabel}, {booked.label}.{" "}
                {booked.status === "confirmed" ? "See you then!" : `${brandName} will confirm shortly.`}
              </p>
            </section>
          )}
          {booked.manageUrl && (
            <a href={booked.manageUrl} className="block text-center text-sm font-medium" style={{ color: accent }}>
              View or change your booking
            </a>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {header}
      <main className="max-w-lg mx-auto px-5 py-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: INK }}>
            Book with {brandName}
          </h1>
          {(service || time) && (
            <p className="text-sm mt-1" style={{ color: MUTED }}>
              {[service?.label, time ? `${time.dayLabel}, ${time.label}` : null].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3">
            {error}
          </p>
        )}

        {step === "service" && (
          <section className="rounded-2xl bg-white border p-5 space-y-3" style={{ borderColor: BORDER }}>
            <p className="text-sm font-semibold" style={{ color: INK }}>
              What do you need?
            </p>
            <ul className="space-y-2">
              {page.services.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => { setService(s); setStep("time"); }}
                    className="w-full text-left rounded-xl border px-4 py-3 hover:bg-gray-50"
                    style={service?.id === s.id ? { borderColor: primary } : { borderColor: BORDER }}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="text-sm font-semibold" style={{ color: INK }}>
                        {s.label}
                      </span>
                      {s.priceLabel && (
                        <span className="text-sm whitespace-nowrap" style={{ color: INK }}>
                          {s.priceLabel}
                        </span>
                      )}
                    </span>
                    {s.description && (
                      <span className="block text-xs mt-1 line-clamp-2" style={{ color: MUTED }}>
                        {s.description}
                      </span>
                    )}
                    {s.depositCents && (
                      <span className="block text-xs mt-1" style={{ color: MUTED }}>
                        {dollars(s.depositCents)} deposit to book
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {!page.requireService && (
              <button type="button" onClick={() => { setService(null); setStep("time"); }} className="w-full py-2 text-sm font-medium" style={{ color: MUTED }}>
                Not sure — just book a time
              </button>
            )}
          </section>
        )}

        {step === "time" && (
          <section className="rounded-2xl bg-white border p-5 space-y-4" style={{ borderColor: BORDER }}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold flex items-center gap-2" style={{ color: INK }}>
                <CalendarDays className="w-4 h-4" style={{ color: accent }} /> Pick a time
              </p>
              {page.services.length > 0 && (
                <button type="button" onClick={() => setStep("service")} className="text-xs flex items-center gap-1" style={{ color: MUTED }}>
                  <ArrowLeft className="w-3.5 h-3.5" /> Service
                </button>
              )}
            </div>
            {days.length === 0 ? (
              <p className="text-sm" style={{ color: MUTED }}>
                No open times right now — please call or text us to book.
              </p>
            ) : (
              <>
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="tablist" aria-label="Day">
                  {days.map((d) => {
                    const active = d.day === pickedDay?.day;
                    return (
                      <button
                        key={d.day}
                        role="tab"
                        aria-selected={active}
                        onClick={() => { setDay(d.day); setTime(null); }}
                        className="shrink-0 rounded-xl border px-3 py-2 text-xs font-semibold text-left"
                        style={active ? { background: primary, color: onPrimary, borderColor: primary } : { borderColor: BORDER, color: INK }}
                      >
                        {d.label.split(",")[0]}
                        <span className="block font-normal opacity-80">{d.label.split(",")[1]?.trim()}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {pickedDay?.times.map((t) => {
                    const active = time?.startsAt === t.startsAt && time?.windowKey === t.windowKey;
                    return (
                      <button
                        key={`${t.startsAt}-${t.windowKey ?? ""}`}
                        onClick={() => setTime(t)}
                        aria-pressed={active}
                        className="rounded-xl border px-3 py-2.5 text-sm font-medium"
                        style={active ? { background: primary, color: onPrimary, borderColor: primary } : { borderColor: BORDER, color: INK }}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs flex items-center gap-1" style={{ color: MUTED }}>
                  <Clock className="w-3.5 h-3.5" /> Times are {page.timezone.replace("_", " ").split("/").pop()} time
                </p>
              </>
            )}
            <button type="button" disabled={!time} onClick={() => setStep("details")} className={primaryBtn} style={{ background: primary, color: onPrimary }}>
              {time ? `Continue with ${time.dayLabel.split(",")[0]}, ${time.label}` : "Pick a time"}
            </button>
          </section>
        )}

        {step === "details" && time && (
          <form onSubmit={(e) => void submit(e)} className="rounded-2xl bg-white border p-5 space-y-3" style={{ borderColor: BORDER }}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold" style={{ color: INK }}>
                Your details
              </p>
              <button type="button" onClick={() => setStep("time")} className="text-xs flex items-center gap-1" style={{ color: MUTED }}>
                <ArrowLeft className="w-3.5 h-3.5" /> Time
              </button>
            </div>
            <input aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Your name" className={inputCls} style={{ borderColor: BORDER, color: INK }} />
            <input aria-label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="Email" className={inputCls} style={{ borderColor: BORDER, color: INK }} />
            <input aria-label="Mobile number" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Mobile number (for reminders)" className={inputCls} style={{ borderColor: BORDER, color: INK }} />
            <input aria-label="Where" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Where? (address, marina, dock…)" className={inputCls} style={{ borderColor: BORDER, color: INK }} />
            <textarea aria-label="Anything we should know" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Anything we should know? (optional)" className={`${inputCls} resize-none`} style={{ borderColor: BORDER, color: INK }} />

            {/* Honeypot — hidden from real users, catches bots that fill every field. */}
            <input ref={websiteRef} type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }} />
            <TurnstileWidget onToken={handleTurnstileToken} />

            {chosenDeposit && (
              <p className="text-xs rounded-xl bg-gray-50 border px-3 py-2" style={{ borderColor: BORDER, color: MUTED }}>
                A {dollars(chosenDeposit)} deposit holds this time — you'll pay it next. It comes off your final bill.
              </p>
            )}
            <button type="submit" disabled={submitting || !name.trim() || !email.trim()} className={primaryBtn} style={{ background: primary, color: onPrimary }}>
              {submitting ? "Booking…" : chosenDeposit ? "Continue to deposit" : "Book it"}
            </button>
          </form>
        )}

        {brand.replyPhone && (
          <a href={`tel:${brand.replyPhone}`} className="flex items-center justify-center gap-2 text-sm font-medium pt-2" style={{ color: accent }}>
            <Phone className="w-4 h-4" /> Rather call? {brand.replyPhone}
          </a>
        )}
      </main>
    </div>
  );
}
