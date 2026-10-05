/**
 * One visit — /v/:token
 *
 * Opened from the reminder text: confirm the visit, move it to another open time, or
 * cancel it. Everything on it is the BRAND's (logo, colour, phone); the platform behind it
 * is never named. Mobile-first.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, CalendarDays, CalendarX2, CheckCircle2, Clock, Loader2, MapPin, Phone } from "lucide-react";

import { ApiError } from "@/lib/api-client";
import { inkOnWhite, textOn } from "@/lib/brand-colors";
import { cancelVisit, confirmVisit, fetchOpenTimes, fetchVisit, rescheduleVisit, type OpenTime, type Visit } from "@/lib/visits-api";

const DEFAULT_PRIMARY = "#1f2937";
const INK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";

type Mode = "view" | "move" | "cancel";

const STATE_TEXT: Record<Visit["state"], string> = {
  scheduled: "Booked",
  confirmed: "Confirmed",
  on_the_way: "On the way",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  missed: "Missed",
  past: "Past",
};

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return err.message;
    if (err.status === 429) return "That's a lot of changes — please call or text us instead.";
  }
  return "Something went wrong. Please try again.";
}

export default function PublicVisitPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [visit, setVisit] = useState<Visit | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [mode, setMode] = useState<Mode>("view");
  const [times, setTimes] = useState<OpenTime[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [picked, setPicked] = useState<OpenTime | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | "confirmed" | "moved" | "cancelled">(null);

  useEffect(() => {
    let cancelled = false;
    fetchVisit(token)
      .then((v) => {
        if (cancelled) return;
        setVisit(v);
        setStatus("ready");
      })
      .catch((err) => !cancelled && setStatus(err instanceof ApiError && err.status === 404 ? "notfound" : "error"));
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!visit) return;
    const previous = document.title;
    document.title = visit.brand.name ? `Your visit — ${visit.brand.name}` : "Your visit";
    return () => {
      document.title = previous;
    };
  }, [visit]);

  const days = useMemo(() => {
    const map = new Map<string, { day: string; label: string; times: OpenTime[] }>();
    for (const t of times ?? []) {
      const d = map.get(t.day) ?? { day: t.day, label: t.dayLabel, times: [] };
      d.times.push(t);
      map.set(t.day, d);
    }
    return [...map.values()];
  }, [times]);

  const run = async (fn: () => Promise<Visit>, after: typeof done) => {
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      setVisit(v);
      setDone(after);
      setMode("view");
      setPicked(null);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError && err.status === 409 && mode === "move") {
        // The time was taken: refresh the list.
        fetchOpenTimes(token).then(setTimes).catch(() => undefined);
        setPicked(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const openMove = async () => {
    setMode("move");
    setError(null);
    setDone(null);
    if (times === null) {
      try {
        const t = await fetchOpenTimes(token);
        setTimes(t);
        setDay(t[0]?.day ?? null);
      } catch (err) {
        setError(errorText(err));
        setTimes([]);
      }
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (status !== "ready" || !visit) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
        <div className="max-w-sm text-center space-y-2">
          <AlertCircle className="w-8 h-8 mx-auto text-gray-400" />
          <p className="text-base font-semibold" style={{ color: INK }}>
            {status === "notfound" ? "This link isn't active" : "Couldn't load your visit"}
          </p>
          <p className="text-sm" style={{ color: MUTED }}>
            {status === "notfound" ? "Please contact the business for an up-to-date link." : "Please refresh the page in a moment."}
          </p>
        </div>
      </div>
    );
  }

  const { brand } = visit;
  const primary = brand.primaryColor || DEFAULT_PRIMARY;
  const onPrimary = textOn(primary);
  const accent = inkOnWhite(primary);
  const live = visit.state === "scheduled" || visit.state === "confirmed";
  const primaryBtn = "w-full rounded-xl px-5 py-3.5 text-base font-semibold disabled:opacity-50";
  const secondaryBtn = "w-full rounded-xl px-5 py-3 text-sm font-semibold border bg-white disabled:opacity-50";
  const pickedDay = days.find((d) => d.day === day) ?? days[0];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b" style={{ borderColor: BORDER }}>
        <div className="max-w-lg mx-auto px-5 py-4 flex items-center gap-3">
          {brand.logoUrl ? (
            <img src={brand.logoUrl} alt={brand.name} className="h-9 w-auto max-w-[160px] object-contain" />
          ) : (
            <span className="text-lg font-bold" style={{ color: accent }}>
              {brand.name}
            </span>
          )}
        </div>
      </header>

      <main className="max-w-lg mx-auto px-5 py-6 space-y-4">
        <h1 className="text-2xl font-bold" style={{ color: INK }}>
          Hi {visit.customerName}
        </h1>

        {done && (
          <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 flex items-start gap-2 text-sm text-emerald-800">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            {done === "confirmed" && "Thanks — you're confirmed. See you then!"}
            {done === "moved" && "Done — your visit has been moved. We've let the team know."}
            {done === "cancelled" && "Your visit has been cancelled. We'll be in touch if anything's needed."}
          </div>
        )}

        <section className="rounded-2xl bg-white border p-5 space-y-3" style={{ borderColor: BORDER }}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-base font-semibold" style={{ color: INK }}>
              {visit.title}
            </p>
            <span
              className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
                visit.state === "confirmed" || visit.state === "done"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : visit.state === "cancelled" || visit.state === "missed"
                    ? "bg-gray-50 text-gray-600 border-gray-200"
                    : "bg-blue-50 text-blue-700 border-blue-200"
              }`}
            >
              {STATE_TEXT[visit.state]}
            </span>
          </div>
          <p className="flex items-center gap-2 text-sm" style={{ color: visit.state === "cancelled" ? MUTED : INK }}>
            <CalendarDays className="w-4 h-4 shrink-0" style={{ color: accent }} />
            <span className={visit.state === "cancelled" ? "line-through" : undefined}>{visit.date}</span>
          </p>
          <p className="flex items-center gap-2 text-sm" style={{ color: visit.state === "cancelled" ? MUTED : INK }}>
            <Clock className="w-4 h-4 shrink-0" style={{ color: accent }} />
            <span className={visit.state === "cancelled" ? "line-through" : undefined}>{visit.windowLabel ? `${visit.time} (${visit.windowLabel})` : visit.time}</span>
          </p>
          {visit.location && (
            <p className="flex items-center gap-2 text-sm" style={{ color: MUTED }}>
              <MapPin className="w-4 h-4 shrink-0" /> {visit.location}
            </p>
          )}
        </section>

        {error && (
          <p role="alert" className="text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3">
            {error}
          </p>
        )}

        {live && mode === "view" && (
          <div className="space-y-2.5">
            {visit.canConfirm && (
              <button type="button" disabled={busy} onClick={() => void run(() => confirmVisit(token), "confirmed")} className={primaryBtn} style={{ background: primary, color: onPrimary }}>
                {busy ? "Confirming…" : "Yes, I'll be there"}
              </button>
            )}
            {visit.canReschedule && (
              <button type="button" disabled={busy} onClick={() => void openMove()} className={secondaryBtn} style={{ borderColor: BORDER, color: INK }}>
                Change the time
              </button>
            )}
            {visit.canCancel && (
              <button type="button" disabled={busy} onClick={() => { setMode("cancel"); setError(null); setDone(null); }} className="w-full py-2 text-sm font-medium" style={{ color: MUTED }}>
                Cancel this visit
              </button>
            )}
          </div>
        )}

        {live && mode === "move" && (
          <section className="rounded-2xl bg-white border p-5 space-y-4" style={{ borderColor: BORDER }}>
            <p className="text-sm font-semibold" style={{ color: INK }}>
              Pick a new time
            </p>
            {times === null ? (
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            ) : days.length === 0 ? (
              <p className="text-sm" style={{ color: MUTED }}>
                No open times right now — please call or text us and we'll sort it out.
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
                        onClick={() => { setDay(d.day); setPicked(null); }}
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
                    const active = picked?.startsAt === t.startsAt && picked?.windowKey === t.windowKey;
                    return (
                      <button
                        key={`${t.startsAt}-${t.windowKey ?? ""}`}
                        onClick={() => setPicked(t)}
                        aria-pressed={active}
                        className="rounded-xl border px-3 py-2.5 text-sm font-medium"
                        style={active ? { background: primary, color: onPrimary, borderColor: primary } : { borderColor: BORDER, color: INK }}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="space-y-2">
              <button
                type="button"
                disabled={!picked || busy}
                onClick={() => picked && void run(() => rescheduleVisit(token, picked), "moved")}
                className={primaryBtn}
                style={{ background: primary, color: onPrimary }}
              >
                {busy ? "Moving…" : picked ? `Move to ${picked.dayLabel.split(",")[0]}, ${picked.label}` : "Pick a time"}
              </button>
              <button type="button" onClick={() => setMode("view")} className="w-full py-2 text-sm font-medium" style={{ color: MUTED }}>
                Keep my current time
              </button>
            </div>
          </section>
        )}

        {live && mode === "cancel" && (
          <section className="rounded-2xl bg-white border p-5 space-y-3" style={{ borderColor: BORDER }}>
            <p className="flex items-center gap-2 text-sm font-semibold" style={{ color: INK }}>
              <CalendarX2 className="w-4 h-4" /> Cancel this visit?
            </p>
            <textarea
              aria-label="Anything we should know? (optional)"
              placeholder="Anything we should know? (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="w-full rounded-xl border px-3 py-2.5 text-sm"
              style={{ borderColor: BORDER, color: INK }}
            />
            <button type="button" disabled={busy} onClick={() => void run(() => cancelVisit(token, reason.trim() || null), "cancelled")} className={`${primaryBtn} bg-red-600 text-white`}>
              {busy ? "Cancelling…" : "Yes, cancel it"}
            </button>
            <button type="button" onClick={() => setMode("view")} className="w-full py-2 text-sm font-medium" style={{ color: MUTED }}>
              Keep my visit
            </button>
          </section>
        )}

        {live && visit.lockedReason && mode === "view" && (
          <p className="text-sm" style={{ color: MUTED }}>
            {visit.lockedReason}
          </p>
        )}

        {brand.replyPhone && (
          <a href={`tel:${brand.replyPhone}`} className="flex items-center justify-center gap-2 text-sm font-medium pt-2" style={{ color: accent }}>
            <Phone className="w-4 h-4" /> Call or text {brand.name || "us"}
          </a>
        )}
      </main>
    </div>
  );
}
