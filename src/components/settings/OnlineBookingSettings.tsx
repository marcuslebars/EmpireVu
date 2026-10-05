import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api-client";
import { useCompanies } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";

interface Settings {
  enabled: boolean;
  startHour: number;
  endHour: number;
  workingDays: number[];
  slotMinutes: number;
  minNoticeHours: number;
  horizonDays: number;
  showServices: boolean;
  requireService: boolean;
  autoConfirm: boolean;
  depositMode: "none" | "fixed" | "percent";
  depositFixedCents: number;
  depositPercent: number;
  holdMinutes: number;
}

interface View {
  companyId: string;
  settings: Settings;
  bookingUrl: string;
  mode: "windows" | "hourly";
  windows: Array<{ key: string; label: string; start: string }>;
  stripeReady: boolean;
  services: { active: number; fixedPrice: number };
}

const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const hintCls = "text-xs text-muted-foreground mt-1";
const fieldCls =
  "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number) => (h === 0 || h === 24 ? "12 a.m." : h === 12 ? "12 p.m." : h < 12 ? `${h} a.m.` : `${h - 12} p.m.`);

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {hint && <p className={hintCls}>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Panel({ orgId, companyId, canManage }: { orgId: string; companyId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ["online-booking", orgId, companyId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => apiFetch<View>(`/api/organizations/${orgId}/online-booking-settings/${companyId}`) });
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => apiFetch<View>(`/api/organizations/${orgId}/online-booking-settings/${companyId}`, { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (v) => qc.setQueryData(key, v),
  });
  const [form, setForm] = useState<Settings | null>(null);
  const [depositDollars, setDepositDollars] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (data) {
      setForm(data.settings);
      setDepositDollars(String(data.settings.depositFixedCents / 100));
    }
  }, [data]);

  if (isLoading || !data || !form) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  const persist = async (patch: Partial<Settings>) => {
    setForm({ ...form, ...patch });
    try {
      await save.mutateAsync(patch);
      toast.success("Saved");
    } catch (err) {
      setForm(data.settings);
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the link.");
    }
  };

  const disabled = !canManage || save.isPending;

  return (
    <div className="space-y-6">
      {!canManage && <p className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2">Only owners and admins can change these settings.</p>}

      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <Row title="Take bookings online" hint="Customers book from your page; the job lands on your calendar.">
          <Switch checked={form.enabled} onCheckedChange={(v) => void persist({ enabled: v })} disabled={disabled} aria-label="Take bookings online" />
        </Row>
        <div className="flex items-center gap-2">
          <input readOnly value={data.bookingUrl} onFocus={(e) => e.target.select()} aria-label="Booking page link" className="flex-1 min-w-0 bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground" />
          <button type="button" onClick={() => void copy()} className="px-2.5 py-1.5 rounded-lg border border-border bg-secondary text-foreground" aria-label="Copy link">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <a href={data.bookingUrl} target="_blank" rel="noreferrer" className="px-2.5 py-1.5 rounded-lg border border-border bg-secondary text-foreground" aria-label="Open booking page">
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
        <p className={hintCls}>Put it on your website, Google profile and social bios. Automations can use {"{{company.booking_url}}"}.</p>
      </div>

      <div className="space-y-4">
        <p className="text-sm font-semibold text-foreground">When customers can book</p>
        {data.mode === "windows" ? (
          <p className="text-sm text-muted-foreground bg-secondary rounded-lg px-3 py-2.5">
            You book by window ({data.windows.map((w) => `${w.label} from ${w.start}`).join(", ")}), with the capacity, notice and days set by your industry pack. Customers pick a window.
          </p>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="ob-start" className={labelCls}>First start time</label>
                <select id="ob-start" value={form.startHour} onChange={(e) => void persist({ startHour: Number(e.target.value) })} disabled={disabled} className={fieldCls}>
                  {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                    <option key={h} value={h}>{hourLabel(h)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ob-end" className={labelCls}>Done by</label>
                <select id="ob-end" value={form.endHour} onChange={(e) => void persist({ endHour: Number(e.target.value) })} disabled={disabled} className={fieldCls}>
                  {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                    <option key={h} value={h}>{hourLabel(h)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ob-slot" className={labelCls}>Each booking is</label>
                <select id="ob-slot" value={form.slotMinutes} onChange={(e) => void persist({ slotMinutes: Number(e.target.value) })} disabled={disabled} className={fieldCls}>
                  {[30, 45, 60, 90, 120, 180, 240].map((m) => (
                    <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ob-notice" className={labelCls}>Notice needed</label>
                <select id="ob-notice" value={form.minNoticeHours} onChange={(e) => void persist({ minNoticeHours: Number(e.target.value) })} disabled={disabled} className={fieldCls}>
                  {[0, 1, 2, 4, 12, 24, 48, 72].map((h) => (
                    <option key={h} value={h}>{h === 0 ? "None" : h < 24 ? `${h} hour${h === 1 ? "" : "s"}` : `${h / 24} day${h === 24 ? "" : "s"}`}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <p className={labelCls}>Days</p>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d, i) => {
                  const on = form.workingDays.includes(i);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      disabled={disabled || (on && form.workingDays.length === 1)}
                      onClick={() => void persist({ workingDays: on ? form.workingDays.filter((x) => x !== i) : [...form.workingDays, i].sort() })}
                      className={cn("px-3 py-1.5 rounded-lg text-xs font-medium border", on ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-muted-foreground border-border")}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <p className={hintCls}>Times already taken on your calendar are never offered.</p>
            </div>
          </>
        )}
        <div className="max-w-xs">
          <label htmlFor="ob-horizon" className={labelCls}>How far ahead</label>
          <select id="ob-horizon" value={form.horizonDays} onChange={(e) => void persist({ horizonDays: Number(e.target.value) })} disabled={disabled || data.mode === "windows"} className={fieldCls}>
            {[7, 14, 21, 30, 60, 90].map((d) => (
              <option key={d} value={d}>{d} days</option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-sm font-semibold text-foreground">Services &amp; confirmation</p>
        <Row title="Let customers pick a service" hint={`${data.services.active} active service${data.services.active === 1 ? "" : "s"} on your price list.`}>
          <Switch checked={form.showServices} onCheckedChange={(v) => void persist({ showServices: v })} disabled={disabled} aria-label="Let customers pick a service" />
        </Row>
        {form.showServices && (
          <Row title="Service is required">
            <Switch checked={form.requireService} onCheckedChange={(v) => void persist({ requireService: v })} disabled={disabled} aria-label="Service is required" />
          </Row>
        )}
        <Row title="Confirm bookings automatically" hint="Off: new bookings wait for you to confirm them. Paid deposits always confirm.">
          <Switch checked={form.autoConfirm} onCheckedChange={(v) => void persist({ autoConfirm: v })} disabled={disabled} aria-label="Confirm bookings automatically" />
        </Row>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-semibold text-foreground">Deposit to book</p>
        {!data.stripeReady ? (
          <p className="text-sm text-muted-foreground bg-secondary rounded-lg px-3 py-2.5">Connect Stripe under Settings → Payments to take deposits.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1 bg-secondary/50 rounded-lg p-1 border border-border w-fit" role="radiogroup" aria-label="Deposit">
              {(
                [
                  ["none", "No deposit"],
                  ["fixed", "Fixed amount"],
                  ["percent", "Percent of price"],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={form.depositMode === v}
                  disabled={disabled}
                  onClick={() => void persist({ depositMode: v })}
                  className={cn("px-3 py-1.5 rounded-md text-xs font-medium", form.depositMode === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
                >
                  {l}
                </button>
              ))}
            </div>
            {form.depositMode === "fixed" && (
              <div className="max-w-[10rem]">
                <label htmlFor="ob-dep" className={labelCls}>Amount ($)</label>
                <input
                  id="ob-dep"
                  inputMode="decimal"
                  value={depositDollars}
                  onChange={(e) => setDepositDollars(e.target.value)}
                  onBlur={() => {
                    const c = Math.round(Number(depositDollars) * 100);
                    if (Number.isFinite(c) && c >= 0 && c !== form.depositFixedCents) void persist({ depositFixedCents: c });
                  }}
                  disabled={disabled}
                  className={fieldCls}
                />
              </div>
            )}
            {form.depositMode === "percent" && (
              <div className="max-w-[10rem]">
                <label htmlFor="ob-pct" className={labelCls}>Percent</label>
                <select id="ob-pct" value={form.depositPercent} onChange={(e) => void persist({ depositPercent: Number(e.target.value) })} disabled={disabled} className={fieldCls}>
                  {[10, 15, 20, 25, 30, 40, 50, 100].map((p) => (
                    <option key={p} value={p}>{p}%</option>
                  ))}
                </select>
              </div>
            )}
            {form.depositMode !== "none" && (
              <>
                <div className="max-w-xs">
                  <label htmlFor="ob-hold" className={labelCls}>Hold the time for</label>
                  <select id="ob-hold" value={form.holdMinutes} onChange={(e) => void persist({ holdMinutes: Number(e.target.value) })} disabled={disabled} className={fieldCls}>
                    {[15, 30, 60, 120, 240, 1440].map((m) => (
                      <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 1440 ? "1 day" : `${m / 60} hour${m === 60 ? "" : "s"}`}</option>
                    ))}
                  </select>
                  <p className={hintCls}>Unpaid by then, the time opens up again and the deposit invoice is voided.</p>
                </div>
                <p className={hintCls}>
                  Applies to services with a fixed price ({data.services.fixedPrice} of {data.services.active}). The deposit is paid on your own pay page and comes off the job's invoice.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function OnlineBookingSettings() {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);
  const [picked, setPicked] = useState<string | null>(null);
  const list = companies ?? [];
  const companyId = picked && list.some((c) => c.id === picked) ? picked : (list[0]?.id ?? null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Globe className="w-4 h-4 text-muted-foreground" /> Online booking
        </h2>
        <p className="text-sm text-muted-foreground mt-1">Your booking page: when customers can book, what they can book, and deposits.</p>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">No companies yet. Add a company under the Organization tab first.</div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-1 bg-secondary/50 rounded-lg p-1 border border-border w-fit max-w-full">
              {list.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setPicked(c.id)}
                  className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-all truncate max-w-[200px]", c.id === companyId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {companyId && <Panel key={companyId} orgId={organizationId} companyId={companyId} canManage={canManage} />}
        </>
      )}
    </div>
  );
}
