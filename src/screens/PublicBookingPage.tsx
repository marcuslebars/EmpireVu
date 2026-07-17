import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Calendar, Clock, CheckCircle2, Loader2, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface AvailableSlot {
  startsAt: string;
  durationMinutes: number;
}

interface Availability {
  company: { id: string; name: string };
  timezone: string;
  slots: AvailableSlot[];
}

type Status = "loading" | "ready" | "error";

export default function PublicBookingPage() {
  const { companyId } = useParams();

  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [availability, setAvailability] = useState<Availability | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    (async () => {
      try {
        const res = await fetch(`/api/public/booking/${companyId}`);
        if (!res.ok) {
          if (active) {
            setStatus("error");
            setErrorMsg(res.status === 404 ? "This booking link isn't valid." : "Couldn't load available times.");
          }
          return;
        }
        const json = await res.json();
        if (active) {
          setAvailability(json.data as Availability);
          setStatus("ready");
        }
      } catch {
        if (active) {
          setStatus("error");
          setErrorMsg("Couldn't load available times. Please try again.");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [companyId]);

  const tz = availability?.timezone ?? "America/Toronto";

  const { dayFormatter, timeFormatter, tzLabel } = useMemo(() => {
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    });
    let label = tz;
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date());
      label = parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
    } catch {
      /* keep IANA name */
    }
    return { dayFormatter: day, timeFormatter: time, tzLabel: label };
  }, [tz]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; slots: AvailableSlot[] }>();
    for (const slot of availability?.slots ?? []) {
      const label = dayFormatter.format(new Date(slot.startsAt));
      if (!map.has(label)) map.set(label, { label, slots: [] });
      map.get(label)!.slots.push(slot);
    }
    return Array.from(map.values());
  }, [availability, dayFormatter]);

  const canSubmit = Boolean(selected) && name.trim().length > 0 && email.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`/api/public/booking/${companyId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
          startsAt: selected,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError((json as { error?: string })?.error || "Couldn't submit your request. Please try again.");
        setSubmitting(false);
        return;
      }
      setConfirmedAt((json as { data?: { scheduledFor?: string } })?.data?.scheduledFor ?? selected);
    } catch {
      setSubmitError("Couldn't submit your request. Please try again.");
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <div className="min-h-screen w-full bg-background text-foreground flex items-start sm:items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-lg">
        {status === "loading" && (
          <div className="flex items-center justify-center gap-2 text-muted-foreground py-24">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading available times…
          </div>
        )}

        {status === "error" && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center">
            <p className="text-sm text-foreground">{errorMsg}</p>
          </div>
        )}

        {status === "ready" && availability && confirmedAt && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center space-y-3">
            <CheckCircle2 className="w-10 h-10 text-[hsl(var(--success))] mx-auto" />
            <h1 className="text-lg font-semibold">Request sent</h1>
            <p className="text-sm text-muted-foreground">
              Thanks, {name.trim().split(" ")[0]}. We&rsquo;ll confirm your{" "}
              <span className="text-foreground font-medium">
                {dayFormatter.format(new Date(confirmedAt))} at {timeFormatter.format(new Date(confirmedAt))} ({tzLabel})
              </span>{" "}
              request shortly at {email.trim()}.
            </p>
          </div>
        )}

        {status === "ready" && availability && !confirmedAt && (
          <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-2xl shadow-black/20">
            <div className="px-6 py-5 border-b border-border">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Book with</p>
              <h1 className="text-xl font-bold text-foreground mt-0.5">{availability.company.name}</h1>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> 60-minute appointment · times in {tzLabel}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-5">
              {/* Slot picker */}
              {!selected ? (
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" /> Choose a time
                  </label>
                  {groups.length === 0 ? (
                    <p className="text-sm text-muted-foreground bg-secondary rounded-lg p-4 text-center">
                      No open times in the next two weeks. Please check back soon.
                    </p>
                  ) : (
                    <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
                      {groups.map((group) => (
                        <div key={group.label}>
                          <p className="text-xs font-semibold text-foreground mb-1.5">{group.label}</p>
                          <div className="flex flex-wrap gap-2">
                            {group.slots.map((slot) => (
                              <button
                                key={slot.startsAt}
                                type="button"
                                onClick={() => setSelected(slot.startsAt)}
                                className="px-3 py-1.5 text-sm rounded-lg border border-border bg-secondary hover:border-primary/50 hover:bg-surface-3 transition-colors"
                              >
                                {timeFormatter.format(new Date(slot.startsAt))}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="w-4 h-4 text-primary" />
                    <span className="font-medium text-foreground">
                      {dayFormatter.format(new Date(selected))} at {timeFormatter.format(new Date(selected))}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" /> Change
                  </button>
                </div>
              )}

              {/* Details — only once a slot is picked */}
              {selected && (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Your name <span className="text-destructive">*</span></label>
                    <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Jane Smith" className={inputCls} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Email <span className="text-destructive">*</span></label>
                      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="jane@example.com" className={inputCls} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Phone</label>
                      <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">What do you need? </label>
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Optional — tell us about the job (boat type, service, etc.)" className={`${inputCls} resize-none`} />
                  </div>

                  {submitError && (
                    <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-xs text-destructive">{submitError}</div>
                  )}

                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : "Request this time"}
                  </button>
                  <p className="text-[11px] text-muted-foreground/70 text-center">You&rsquo;ll get a confirmation once we approve your request.</p>
                </div>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
