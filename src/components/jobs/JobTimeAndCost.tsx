import { useEffect, useState } from "react";
import { AlertTriangle, Clock, Loader2, Package, Plus, Square, TrendingUp, X } from "lucide-react";
import { Link } from "react-router-dom";

import { toast } from "@/components/ui/sonner";
import { parseDollarsToCents } from "@/components/invoices/invoice-ui";
import { formatCents } from "@/lib/invoices-api";
import { useAddMaterial, useClockIn, useClockOut, useDeleteMaterial, useJobProfit, useJobTime, useMaterials, useMyClock } from "@/lib/time-hooks";
import type { TimeEntry } from "@/lib/time-api";
import { hm, timeLabel } from "@/lib/jobs-format";
import { cn } from "@/lib/utils";

const inputCls =
  "bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50";

/** Re-render every 30 s so running clocks tick. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function liveMinutes(e: TimeEntry, now: number): number {
  if (e.endedAt) return e.minutes;
  return Math.max(0, Math.floor((now - Date.parse(e.startedAt)) / 60_000) - e.breakMinutes);
}

/** Time on this job (clock in/out) and materials used. */
export function JobTime({ orgId, bookingId, timeZone, closed }: { orgId: string; bookingId: string; timeZone: string; closed: boolean }) {
  const { data: entries = [] } = useJobTime(orgId, bookingId);
  const { data: myClock } = useMyClock(orgId);
  const clockIn = useClockIn(orgId);
  const clockOut = useClockOut(orgId);
  const onThisJob = myClock?.bookingId === bookingId;
  const now = useTick(entries.some((e) => !e.endedAt) || Boolean(myClock));
  const total = entries.reduce((s, e) => s + liveMinutes(e, now), 0);

  const toggle = async () => {
    try {
      if (onThisJob) await clockOut.mutateAsync();
      else await clockIn.mutateAsync(bookingId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update your clock.");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          Time {total > 0 && <span className="normal-case tracking-normal font-semibold text-foreground">{hm(total)}</span>}
        </h4>
        {!closed && (
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={clockIn.isPending || clockOut.isPending}
            className={cn(
              "flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-60",
              onThisJob ? "bg-destructive/10 border-destructive/30 text-destructive" : "bg-secondary border-border text-foreground hover:bg-secondary/80",
            )}
          >
            {clockIn.isPending || clockOut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : onThisJob ? <Square className="w-3 h-3" /> : <Clock className="w-3.5 h-3.5" />}
            {onThisJob ? "Clock out" : myClock ? "Switch clock here" : "Clock in"}
          </button>
        )}
      </div>
      {myClock && !onThisJob && !closed && (
        <p className="text-[11px] text-muted-foreground">You're clocked in to {myClock.jobTitle ?? "general time"}.</p>
      )}
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No time logged yet{closed ? "." : " — Start job clocks you in automatically."}</p>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border text-sm">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-foreground truncate">{e.personName}</span>
              <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {timeLabel(e.startedAt, timeZone)} – {e.endedAt ? timeLabel(e.endedAt, timeZone) : <span className="text-emerald-600 dark:text-emerald-400 font-medium">now</span>}
                <span className="ml-2 font-semibold text-foreground">{hm(liveMinutes(e, now))}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function JobMaterials({ orgId, bookingId, readOnly }: { orgId: string; bookingId: string; readOnly: boolean }) {
  const { data: materials = [] } = useMaterials(orgId, bookingId);
  const add = useAddMaterial(orgId, bookingId);
  const remove = useDeleteMaterial(orgId, bookingId);
  const [label, setLabel] = useState("");
  const [qty, setQty] = useState("1");
  const [cost, setCost] = useState("");
  const total = materials.reduce((s, m) => s + m.totalCents, 0);

  const onAdd = async () => {
    const unit = parseDollarsToCents(cost);
    const quantity = Number(qty);
    if (!label.trim()) return toast.error("Describe the material.");
    if (!(quantity > 0)) return toast.error("Quantity must be more than 0.");
    if (unit === null || unit < 0) return toast.error("Enter what it cost, like 45 or 45.00.");
    try {
      await add.mutateAsync({ label: label.trim(), quantity, unitCostCents: unit });
      setLabel("");
      setQty("1");
      setCost("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that.");
    }
  };

  return (
    <div className="space-y-2">
      <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Package className="w-3 h-3" />
        Materials {total > 0 && <span className="normal-case tracking-normal font-semibold text-foreground">{formatCents(total)}</span>}
      </h4>
      {materials.length > 0 && (
        <ul className="rounded-lg border border-border divide-y divide-border text-sm">
          {materials.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2 group">
              <span className="text-foreground truncate">
                {m.label}
                {m.quantity !== 1 && <span className="text-muted-foreground"> × {m.quantity}</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-foreground">{formatCents(m.totalCents)}</span>
                {!readOnly && (
                  <button type="button" aria-label={`Remove ${m.label}`} onClick={() => remove.mutate(m.id, { onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't remove.") })} className="text-muted-foreground/60 hover:text-destructive">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex gap-2">
          <input aria-label="Material" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} placeholder="e.g. Shrink wrap roll" className={cn(inputCls, "flex-1 min-w-0")} />
          <input aria-label="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className={cn(inputCls, "w-14 text-center")} />
          <input aria-label="Cost each" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="$ each" className={cn(inputCls, "w-20 text-right")} />
          <button type="button" aria-label="Add material" onClick={() => void onAdd()} disabled={add.isPending} className="px-3 rounded-lg bg-secondary border border-border text-foreground hover:bg-secondary/80 disabled:opacity-50">
            {add.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}

/** Revenue vs. cost for one job (owners/admins only). */
export function JobProfitCard({ orgId, bookingId }: { orgId: string; bookingId: string }) {
  const { data: p, isLoading } = useJobProfit(orgId, bookingId, true);
  if (isLoading || !p) return <div className="h-24 rounded-lg bg-secondary/50 animate-pulse" />;
  const row = (label: string, value: string, sub?: string) => (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">
        {label}
        {sub && <span className="text-[11px] ml-1">{sub}</span>}
      </span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
  return (
    <div className="space-y-2">
      <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <TrendingUp className="w-3 h-3" />
        Job profit <span className="normal-case tracking-normal font-normal">(only owners & admins see this)</span>
      </h4>
      {row("Revenue", formatCents(p.revenueCents), p.revenueSource === "invoice" ? "invoiced, before tax" : p.revenueSource === "estimate" ? "quoted, before tax" : "not priced yet")}
      {row("Labour", `− ${formatCents(p.labourCents)}`, hm(p.labourMinutes) + (p.running ? " · clock running" : ""))}
      {row("Materials", `− ${formatCents(p.materialsCents)}`)}
      {p.expensesCents > 0 && row("Expenses", `− ${formatCents(p.expensesCents)}`, "receipts, before tax")}
      <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
        <span className="text-sm font-semibold text-foreground">Profit</span>
        <span className={cn("text-base font-bold tabular-nums", p.profitCents < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>
          {formatCents(p.profitCents)}
          {p.marginPct !== null && <span className="text-xs font-medium text-muted-foreground ml-1.5">{p.marginPct}%</span>}
        </span>
      </div>
      {p.missingRateNames.length > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            No pay rate for {p.missingRateNames.join(", ")} — their time counts as $0.{" "}
            <Link to="/timesheets?tab=rates" className="underline">
              Set rates
            </Link>
          </span>
        </p>
      )}
    </div>
  );
}
