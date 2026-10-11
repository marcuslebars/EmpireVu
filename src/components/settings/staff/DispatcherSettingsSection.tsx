import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CloudRain, Loader2, Truck, Users } from "lucide-react";

import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Settings → AI front desk → Dispatcher (docs/ai-staff.md → "Dispatcher"): weather moves (you OK
 * the list by text), "on our way" texts, crew schedule texts and filling gaps. Self-contained:
 * own query + mutation against /ai-settings/dispatch.
 */

type Sensitivity = "all" | "none" | string[];

export interface DispatchSettingsView {
  companyId: string;
  companyName: string;
  settings: {
    weather: {
      enabled: boolean;
      sensitive: Sensitivity;
      sensitiveIsDefault: boolean;
      thresholds: { rainProbability: number; rainMm: number; windKmh: number; minTempC: number; maxTempC: number };
      checkAt: string;
    };
    onOurWay: { enabled: boolean; from: string; until: string };
    crewTexts: { enabled: boolean; time: string };
    fillGap: { enabled: boolean };
    customerHours: { from: string; until: string };
    defaultEnabled: boolean;
  };
  tradeDefaultSensitivity: "all" | "none";
  services: Array<{ key: string; label: string }>;
  location: { known: boolean; source: string | null; canLookUp: boolean };
  crew: { members: number; withPhone: number };
  onOurWayAutomationActive: boolean;
  last30d: { onOurWay: number; crewTexts: number; jobsMoved: number; gapOffers: number };
}

export interface DispatchPatch {
  weather?: {
    enabled?: boolean;
    sensitive?: Sensitivity | null;
    rainProbability?: number;
    rainMm?: number;
    windKmh?: number;
    minTempC?: number;
    maxTempC?: number;
  };
  onOurWay?: { enabled?: boolean };
  crewTexts?: { enabled?: boolean; time?: string };
  fillGap?: { enabled?: boolean };
}

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/dispatch`;

const CREW_TIMES = ["16:00", "17:00", "18:00", "19:00", "20:00"];

/** "18:00" → "6 p.m." */
function hourLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "p.m." : "a.m.";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${suffix}`;
}

function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <label className={cn("flex items-center gap-2 shrink-0", disabled ? "cursor-default" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-primary w-4 h-4" aria-label={label} />
      <span className="text-sm font-medium text-foreground">{checked ? "On" : "Off"}</span>
    </label>
  );
}

function Row({ icon, title, body, control, children }: { icon: ReactNode; title: string; body: string; control: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{body}</p>
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

function NumberField({ label, value, unit, onChange, disabled, step = 1 }: { label: string; value: number; unit: string; onChange: (n: number) => void; disabled: boolean; step?: number }) {
  return (
    <label className="text-xs text-muted-foreground space-y-1">
      <span className="block">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          value={Number.isFinite(value) ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 px-2 py-1 text-sm bg-secondary border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <span>{unit}</span>
      </span>
    </label>
  );
}

export function DispatcherSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["dispatch-settings", orgId, companyId];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => apiFetch<DispatchSettingsView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: DispatchPatch) => apiFetch<DispatchSettingsView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const [limits, setLimits] = useState<DispatchSettingsView["settings"]["weather"]["thresholds"] | null>(null);
  useEffect(() => {
    if (data) setLimits(data.settings.weather.thresholds);
  }, [data]);

  const frame = (children: ReactNode) => (
    <AiFrontDeskSectionCard
      icon={<Truck className="w-4 h-4" />}
      title="Dispatcher"
      description="Moves jobs when bad weather is coming (you OK the list by text first), tells customers when the crew is on the way, texts your crew their next day, and offers freed-up spots to other customers."
    >
      {children}
    </AiFrontDeskSectionCard>
  );

  if (isLoading) {
    return frame(
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>,
    );
  }
  if (isError || !data) return frame(<p className="text-sm text-muted-foreground">Couldn't load these settings.</p>);

  const s = data.settings;
  const disabled = !canManage || update.isPending;
  const save = (patch: DispatchPatch) => update.mutate(patch);
  const mode: "all" | "none" | "some" = Array.isArray(s.weather.sensitive) ? "some" : s.weather.sensitive;
  const picked = Array.isArray(s.weather.sensitive) ? s.weather.sensitive : [];
  const limitsChanged = limits && JSON.stringify(limits) !== JSON.stringify(s.weather.thresholds);

  return frame(
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">{data.last30d.jobsMoved}</span> customers told about a move
        </span>
        <span>
          <span className="font-semibold text-foreground">{data.last30d.onOurWay}</span> "on our way" texts
        </span>
        <span>
          <span className="font-semibold text-foreground">{data.last30d.crewTexts}</span> crew schedule texts
        </span>
        <span>
          <span className="font-semibold text-foreground">{data.last30d.gapOffers}</span> open spots offered
        </span>
        <span className="w-full">Last 30 days.</span>
      </div>

      <Row
        icon={<CloudRain className="w-4 h-4" />}
        title="Weather check"
        body={`Every day at ${hourLabel(s.weather.checkAt)}, jobs in the next 48 hours that bad weather would hit get a new open time. You get one text with the list; nothing moves until you reply Y. Then each customer gets their new time and a link to change it.`}
        control={<Toggle checked={s.weather.enabled} disabled={disabled} onChange={(on) => save({ weather: { enabled: on } })} label="Weather check on" />}
      >
        {s.weather.enabled && (
          <div className="space-y-3 pl-7">
            <p className="text-[11px] text-muted-foreground">Forecasts: Data Source: Environment and Climate Change Canada.</p>
            {!data.location.known && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {data.location.canLookUp
                  ? "We'll work out where you are from your Google listing, address or town before the first check."
                  : "We don't know where your business is yet. Add your address (Organization settings) so we can check the weather."}
              </p>
            )}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Which jobs does weather affect?</p>
              <div role="radiogroup" aria-label="Weather-sensitive jobs" className="flex flex-wrap gap-2">
                {(
                  [
                    ["all", "All jobs"],
                    ["some", "Only some services"],
                    ["none", "None"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={mode === value}
                    disabled={disabled}
                    onClick={() => save({ weather: { sensitive: value === "some" ? (picked.length ? picked : data.services.slice(0, 1).map((x) => x.key)) : value } })}
                    className={cn("px-3 py-1.5 rounded-lg border text-xs", mode === value ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:bg-secondary/60")}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {s.weather.sensitiveIsDefault && <p className="text-xs text-muted-foreground">This is the usual setting for your trade.</p>}
              {!s.weather.sensitiveIsDefault && (
                <button type="button" disabled={disabled} onClick={() => save({ weather: { sensitive: null } })} className="text-xs text-primary hover:underline">
                  Use the usual setting for my trade ({data.tradeDefaultSensitivity === "all" ? "all jobs" : "none"})
                </button>
              )}
              {mode === "some" && (
                <div className="grid sm:grid-cols-2 gap-1 pt-1">
                  {data.services.length === 0 && <p className="text-xs text-muted-foreground">Add services to your price list first.</p>}
                  {data.services.map((svc) => (
                    <label key={svc.key} className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        disabled={disabled}
                        checked={picked.includes(svc.key)}
                        onChange={(e) => {
                          const next = e.target.checked ? [...picked, svc.key] : picked.filter((k) => k !== svc.key);
                          save({ weather: { sensitive: next.length ? next : "none" } });
                        }}
                      />
                      {svc.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {limits && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Move a job when the forecast for its time shows</p>
                <div className="flex flex-wrap gap-4">
                  <NumberField label="Rain chance at least" unit="%" value={limits.rainProbability} disabled={disabled} onChange={(n) => setLimits({ ...limits, rainProbability: n })} />
                  <NumberField label="and rain of at least" unit="mm" step={0.5} value={limits.rainMm} disabled={disabled} onChange={(n) => setLimits({ ...limits, rainMm: n })} />
                  <NumberField label="or wind of" unit="km/h" value={limits.windKmh} disabled={disabled} onChange={(n) => setLimits({ ...limits, windKmh: n })} />
                  <NumberField label="or colder than" unit="°C" value={limits.minTempC} disabled={disabled} onChange={(n) => setLimits({ ...limits, minTempC: n })} />
                  <NumberField label="or hotter than" unit="°C" value={limits.maxTempC} disabled={disabled} onChange={(n) => setLimits({ ...limits, maxTempC: n })} />
                </div>
                {limitsChanged && canManage && (
                  <button
                    type="button"
                    disabled={update.isPending}
                    onClick={() => save({ weather: { ...limits } })}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Save limits
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </Row>

      <Row
        icon={<Truck className="w-4 h-4" />}
        title={'"On our way" texts'}
        body={`When your crew taps "On my way" on a job, the customer gets a text from your number (with the ETA if they pick one). Sent between ${hourLabel(s.onOurWay.from)} and ${hourLabel(s.onOurWay.until)}.`}
        control={<Toggle checked={s.onOurWay.enabled} disabled={disabled} onChange={(on) => save({ onOurWay: { enabled: on } })} label="On our way texts on" />}
      >
        {s.onOurWay.enabled && data.onOurWayAutomationActive && (
          <p className="text-xs text-muted-foreground pl-7">Your "On my way" automation is on, so it sends this text instead - customers never get two.</p>
        )}
      </Row>

      <Row
        icon={<Users className="w-4 h-4" />}
        title="Crew schedule texts"
        body="Each crew member gets tomorrow's jobs by text: time, customer, job, address and a map link. If their day changes after that, they get an update."
        control={<Toggle checked={s.crewTexts.enabled} disabled={disabled} onChange={(on) => save({ crewTexts: { enabled: on } })} label="Crew schedule texts on" />}
      >
        {s.crewTexts.enabled && (
          <div className="pl-7 space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Send at
              <select
                value={s.crewTexts.time}
                disabled={disabled}
                onChange={(e) => save({ crewTexts: { time: e.target.value } })}
                className="px-2 py-1 text-xs bg-secondary border border-border rounded-md text-foreground"
              >
                {[...new Set([...CREW_TIMES, s.crewTexts.time])].sort().map((t) => (
                  <option key={t} value={t}>
                    {hourLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <p className={cn("text-xs", data.crew.withPhone === 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              {data.crew.withPhone} of {data.crew.members} team members have a cell on file. Add numbers under Settings → Members.
            </p>
          </div>
        )}
      </Row>

      <Row
        icon={<CalendarClock className="w-4 h-4" />}
        title="Fill open spots"
        body="When a job in the next two days is cancelled or moved, we suggest offering the spot to a customer booked later. You reply Y, and they get a text with a link to switch."
        control={<Toggle checked={s.fillGap.enabled} disabled={disabled} onChange={(on) => save({ fillGap: { enabled: on } })} label="Fill open spots on" />}
      />

      <p className="text-xs text-muted-foreground">
        Customer texts about moves and open spots go out between {hourLabel(s.customerHours.from)} and {hourLabel(s.customerHours.until)}.
        {!canManage && " Only owners and admins can change these."}
      </p>
    </div>,
  );
}

export default DispatcherSettingsSection;
