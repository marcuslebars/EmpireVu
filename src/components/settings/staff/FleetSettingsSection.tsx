import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Truck } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Fleet & equipment (docs/ai-staff.md → "Fleet & equipment"): on/off,
 * the daily heads-up text, vehicles (odometer, plate sticker, safety inspection, service
 * schedules), equipment (in / out / in the shop, service), rentals (due back, returned), and the
 * vehicle insurance Compliance has on file (read-only). Owners/admins edit; members read.
 */

type Tone = "ok" | "soon" | "late";
type EquipmentStatus = "available" | "out" | "in_shop" | "retired";

export interface FleetView {
  companyId: string;
  companyName: string;
  settings: { enabled: boolean; reminders: boolean; defaultEnabled: boolean; enabledIsDefault: boolean };
  ownerPhoneOnFile: boolean;
  vehicles: Array<{
    id: string;
    name: string;
    year: number | null;
    make: string | null;
    model: string | null;
    plate: string | null;
    vin: string | null;
    driverProfileId: string | null;
    driverName: string | null;
    odometerKm: number | null;
    odometerWords: string;
    plateStickerDue: string | null;
    plateTone: Tone | null;
    safetyInspectionRequired: boolean;
    safetyInspectionDue: string | null;
    safetyTone: Tone | null;
    notes: string | null;
    services: Array<{ id: string; label: string; everyKm: number | null; everyMonths: number | null; lastDoneKm: number | null; lastDoneOn: string | null; words: string; tone: Tone | null }>;
  }>;
  equipment: Array<{
    id: string;
    name: string;
    serial: string | null;
    valueCents: number | null;
    status: EquipmentStatus;
    location: string | null;
    hours: number | null;
    serviceEveryHours: number | null;
    serviceEveryMonths: number | null;
    lastServicedOn: string | null;
    statusWords: string;
    serviceWords: string | null;
    tone: Tone | null;
  }>;
  rentals: Array<{ id: string; item: string; vendor: string | null; vendorPhone: string | null; dueBackAt: string | null; rateCentsPerDay: number | null; returnedAt: string | null; words: string; tone: Tone | null }>;
  vehicleInsurance: Array<{ issuer: string | null; expiresOn: string | null; status: string }>;
  crew: Array<{ profileId: string; name: string }>;
  attention: string[];
}

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/fleet`;
const inputCls = "h-8 rounded-md border border-border bg-background px-2 text-sm";
const btn = "h-8 px-3 rounded-md border border-border text-sm";
const primary = "h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50";
const toneCls = (tone: Tone | null) => (tone === "late" ? "text-red-600 dark:text-red-400" : tone === "soon" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground");
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[$,\s]/g, "")));
const intOrNull = (s: string) => {
  const n = numOrNull(s);
  return n == null || !Number.isFinite(n) ? null : Math.round(n);
};
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { maximumFractionDigits: 2 })}`;

type Fields = Record<string, string>;

function Field({ label, value, onChange, type = "text", className }: { label: string; value: string; onChange: (v: string) => void; type?: string; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-0.5 text-xs text-muted-foreground", className)}>
      {label}
      <input aria-label={label} type={type} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputCls, "w-full text-foreground")} />
    </label>
  );
}

function useFields(initial: Fields) {
  const [f, setF] = useState<Fields>(initial);
  return { f, set: (k: string) => (v: string) => setF((cur) => ({ ...cur, [k]: v })) };
}

function VehicleForm({ view, initial, busy, onSave, onCancel }: { view: FleetView; initial?: FleetView["vehicles"][number]; busy: boolean; onSave: (v: Record<string, unknown>) => void; onCancel: () => void }) {
  const { f, set } = useFields({
    name: initial?.name ?? "",
    year: initial?.year ? String(initial.year) : "",
    make: initial?.make ?? "",
    model: initial?.model ?? "",
    plate: initial?.plate ?? "",
    vin: initial?.vin ?? "",
    km: initial?.odometerKm != null ? String(initial.odometerKm) : "",
    sticker: initial?.plateStickerDue ?? "",
    safety: initial?.safetyInspectionDue ?? "",
    driver: initial?.driverProfileId ?? "",
  });
  const [needsSafety, setNeedsSafety] = useState(initial?.safetyInspectionRequired ?? false);
  const [active, setActive] = useState(true);
  const save = () => {
    const km = intOrNull(f.km);
    onSave({
      ...(initial ? { id: initial.id } : {}),
      name: f.name.trim(),
      year: intOrNull(f.year),
      make: f.make.trim() || null,
      model: f.model.trim() || null,
      plate: f.plate.trim() || null,
      vin: f.vin.trim() || null,
      plateStickerDue: f.sticker || null,
      safetyInspectionRequired: needsSafety,
      safetyInspectionDue: needsSafety ? f.safety || null : null,
      profileId: f.driver || null,
      ...(km != null && km !== initial?.odometerKm ? { odometerKm: km } : {}),
      ...(initial && !active ? { active: false } : {}),
    });
  };
  return (
    <div className="rounded-lg border border-border p-2.5 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Field label="Name" value={f.name} onChange={set("name")} />
        <Field label="Year" value={f.year} onChange={set("year")} />
        <Field label="Make" value={f.make} onChange={set("make")} />
        <Field label="Model" value={f.model} onChange={set("model")} />
        <Field label="Plate" value={f.plate} onChange={set("plate")} />
        <Field label="VIN" value={f.vin} onChange={set("vin")} />
        <Field label="Odometer (km)" value={f.km} onChange={set("km")} />
        <Field label="Plate sticker due" type="date" value={f.sticker} onChange={set("sticker")} />
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          Driver
          <select aria-label="Driver" value={f.driver} onChange={(e) => set("driver")(e.target.value)} className={cn(inputCls, "text-foreground")}>
            <option value="">Nobody in particular</option>
            {view.crew.map((c) => (
              <option key={c.profileId} value={c.profileId}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-primary w-4 h-4" checked={needsSafety} onChange={(e) => setNeedsSafety(e.target.checked)} />
        Needs an annual safety inspection (commercial vehicle)
      </label>
      {needsSafety && <Field className="max-w-[12rem]" label="Safety inspection due" type="date" value={f.safety} onChange={set("safety")} />}
      {initial && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-primary w-4 h-4" checked={!active} onChange={(e) => setActive(!e.target.checked)} />
          Retire this vehicle (stop tracking it)
        </label>
      )}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !f.name.trim()} onClick={save} className={primary}>
          Save
        </button>
        <button type="button" onClick={onCancel} className={btn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ServiceForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (s: Record<string, unknown>) => void; onCancel: () => void }) {
  const { f, set } = useFields({ label: "", km: "", months: "", lastKm: "", lastOn: "" });
  const ok = f.label.trim() && (f.km.trim() || f.months.trim());
  return (
    <div className="rounded-md border border-dashed border-border p-2 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Field label="Service" value={f.label} onChange={set("label")} />
        <Field label="Every km" value={f.km} onChange={set("km")} />
        <Field label="Every months" value={f.months} onChange={set("months")} />
        <Field label="Last done km" value={f.lastKm} onChange={set("lastKm")} />
        <Field label="Last done on" type="date" value={f.lastOn} onChange={set("lastOn")} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !ok}
          onClick={() => onSave({ label: f.label.trim(), everyKm: intOrNull(f.km), everyMonths: intOrNull(f.months), lastDoneKm: intOrNull(f.lastKm), lastDoneOn: f.lastOn || null })}
          className={primary}
        >
          Add service
        </button>
        <button type="button" onClick={onCancel} className={btn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function EquipmentForm({ initial, busy, onSave, onCancel }: { initial?: FleetView["equipment"][number]; busy: boolean; onSave: (e: Record<string, unknown>) => void; onCancel: () => void }) {
  const { f, set } = useFields({
    name: initial?.name ?? "",
    serial: initial?.serial ?? "",
    value: initial?.valueCents != null ? String(initial.valueCents / 100) : "",
    hours: initial?.hours != null ? String(initial.hours) : "",
    everyHours: initial?.serviceEveryHours != null ? String(initial.serviceEveryHours) : "",
    everyMonths: initial?.serviceEveryMonths != null ? String(initial.serviceEveryMonths) : "",
    lastOn: initial?.lastServicedOn ?? "",
  });
  const [retire, setRetire] = useState(false);
  const save = () => {
    const value = numOrNull(f.value);
    onSave({
      ...(initial ? { id: initial.id } : {}),
      name: f.name.trim(),
      serial: f.serial.trim() || null,
      valueCents: value == null || !Number.isFinite(value) ? null : Math.round(value * 100),
      hours: numOrNull(f.hours),
      serviceEveryHours: numOrNull(f.everyHours),
      serviceEveryMonths: intOrNull(f.everyMonths),
      lastServicedOn: f.lastOn || null,
      ...(retire ? { status: "retired" } : {}),
    });
  };
  return (
    <div className="rounded-lg border border-border p-2.5 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Field label="Name" value={f.name} onChange={set("name")} />
        <Field label="Serial" value={f.serial} onChange={set("serial")} />
        <Field label="Value ($)" value={f.value} onChange={set("value")} />
        <Field label="Hour meter" value={f.hours} onChange={set("hours")} />
        <Field label="Service every hours" value={f.everyHours} onChange={set("everyHours")} />
        <Field label="Service every months" value={f.everyMonths} onChange={set("everyMonths")} />
        <Field label="Last serviced" type="date" value={f.lastOn} onChange={set("lastOn")} />
      </div>
      {initial && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-primary w-4 h-4" checked={retire} onChange={(e) => setRetire(e.target.checked)} />
          Retire (sold, scrapped)
        </label>
      )}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !f.name.trim()} onClick={save} className={primary}>
          Save
        </button>
        <button type="button" onClick={onCancel} className={btn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RentalForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (r: Record<string, unknown>) => void; onCancel: () => void }) {
  const { f, set } = useFields({ item: "", vendor: "", phone: "", due: "", rate: "" });
  const save = () => {
    const rate = numOrNull(f.rate);
    onSave({ item: f.item.trim(), vendor: f.vendor.trim() || null, vendorPhone: f.phone.trim() || null, dueBackLocal: f.due || null, rateCentsPerDay: rate == null || !Number.isFinite(rate) ? null : Math.round(rate * 100) });
  };
  return (
    <div className="rounded-lg border border-border p-2.5 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Field label="What" value={f.item} onChange={set("item")} />
        <Field label="From" value={f.vendor} onChange={set("vendor")} />
        <Field label="Their phone" type="tel" value={f.phone} onChange={set("phone")} />
        <Field label="Due back" type="datetime-local" value={f.due} onChange={set("due")} />
        <Field label="$ per day" value={f.rate} onChange={set("rate")} />
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !f.item.trim()} onClick={save} className={primary}>
          Save rental
        </button>
        <button type="button" onClick={onCancel} className={btn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function FleetSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["fleet-settings", orgId, companyId];
  const [editing, setEditing] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<FleetView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const onDone = (view: FleetView) => {
    qc.setQueryData(queryKey, view);
    toast.success("Saved");
  };
  const onError = (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save");
  const update = useMutation({ mutationFn: (patch: { enabled?: boolean; reminders?: boolean }) => apiFetch<FleetView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }), onSuccess: onDone, onError });
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch<FleetView>(path(orgId, companyId), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (view) => {
      onDone(view);
      setEditing(null);
    },
    onError,
  });

  const title = "Fleet & equipment";
  const description = "Keeps track of your trucks, equipment and rentals: oil changes by km, plate stickers, safety inspections and rentals due back. One heads-up text a day.";
  const icon = <Truck className="w-4 h-4" />;

  if (isLoading) {
    return (
      <AiFrontDeskSectionCard icon={icon} title={title} description={description}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </AiFrontDeskSectionCard>
    );
  }
  if (error || !data) {
    return (
      <AiFrontDeskSectionCard icon={icon} title={title} description={description}>
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      </AiFrontDeskSectionCard>
    );
  }

  const s = data.settings;
  const busy = act.isPending;
  const open = data.rentals.filter((r) => !r.returnedAt);
  const returned = data.rentals.filter((r) => r.returnedAt);

  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title={title}
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input type="checkbox" checked={s.enabled} disabled={!canManage || update.isPending} onChange={(e) => update.mutate({ enabled: e.target.checked })} className="accent-primary w-4 h-4" aria-label="Fleet on" />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className={cn("space-y-4", !s.enabled && "opacity-60")}>
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" className="accent-primary mt-0.5 w-4 h-4" aria-label="Daily heads-up text" checked={s.reminders} disabled={!canManage || !s.enabled || update.isPending} onChange={(e) => update.mutate({ reminders: e.target.checked })} />
          <span>
            <span className="block font-medium text-foreground">Daily heads-up text</span>
            <span className="block text-xs text-muted-foreground">One text between 9am and 8pm when something's due: service by date or km, plate stickers and safety inspections (30 and 7 days before), equipment service, rentals due back.</span>
          </span>
        </label>

        {data.attention.length > 0 && (
          <div className="rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20 px-2.5 py-2 text-sm">
            <h4 className="text-xs font-semibold text-foreground mb-1">Needs attention</h4>
            <ul className="list-disc pl-4 space-y-0.5 text-xs text-foreground">
              {data.attention.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">Vehicles</h4>
          {data.vehicles.length === 0 && editing !== "vehicle:new" && <p className="text-xs text-muted-foreground">No vehicles yet.</p>}
          <ul className="space-y-2">
            {data.vehicles.map((v) =>
              editing === `vehicle:${v.id}` ? (
                <li key={v.id}>
                  <VehicleForm view={data} initial={v} busy={busy} onSave={(vehicle) => act.mutate({ action: "save_vehicle", vehicle })} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <li key={v.id} className="rounded-lg border border-border px-2.5 py-2 text-sm space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{v.name}</span>
                      <span className="text-xs text-muted-foreground"> {[[v.year, v.make, v.model].filter(Boolean).join(" "), v.plate, v.driverName ? `driver: ${v.driverName}` : null].filter(Boolean).join(" · ")}</span>
                      <span className="block text-xs text-muted-foreground">{v.odometerWords}</span>
                      <span className={cn("block text-xs", toneCls(v.plateTone))}>Plate sticker: {v.plateStickerDue ?? "no date"}</span>
                      {v.safetyInspectionRequired && <span className={cn("block text-xs", toneCls(v.safetyTone))}>Safety inspection: {v.safetyInspectionDue ?? "no date"}</span>}
                    </span>
                    {canManage && (
                      <button type="button" aria-label={`Edit ${v.name}`} onClick={() => setEditing(`vehicle:${v.id}`)} className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground shrink-0">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {v.services.length > 0 && (
                    <ul className="space-y-0.5">
                      {v.services.map((svc) => (
                        <li key={svc.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className={toneCls(svc.tone)}>{svc.words}</span>
                          {canManage && (
                            <span className="flex gap-1 shrink-0">
                              <button type="button" disabled={busy} onClick={() => act.mutate({ action: "service_done", vehicleId: v.id, label: svc.label })} className="h-6 px-2 rounded border border-border">
                                Done today
                              </button>
                              <button type="button" disabled={busy} onClick={() => act.mutate({ action: "save_service_item", vehicleId: v.id, item: { id: svc.id, active: false } })} className="h-6 px-2 rounded border border-border">
                                Remove
                              </button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage &&
                    (editing === `service:${v.id}` ? (
                      <ServiceForm busy={busy} onSave={(item) => act.mutate({ action: "save_service_item", vehicleId: v.id, item })} onCancel={() => setEditing(null)} />
                    ) : (
                      <button type="button" onClick={() => setEditing(`service:${v.id}`)} className="text-xs text-primary flex items-center gap-1">
                        <Plus className="w-3 h-3" /> Service schedule
                      </button>
                    ))}
                </li>
              ),
            )}
          </ul>
          {canManage &&
            (editing === "vehicle:new" ? (
              <VehicleForm view={data} busy={busy} onSave={(vehicle) => act.mutate({ action: "save_vehicle", vehicle })} onCancel={() => setEditing(null)} />
            ) : (
              <button type="button" onClick={() => setEditing("vehicle:new")} className={cn(btn, "flex items-center gap-1")}>
                <Plus className="w-3.5 h-3.5" /> Add vehicle
              </button>
            ))}
          <p className="text-xs text-muted-foreground">
            Vehicle insurance (kept by Compliance):{" "}
            {data.vehicleInsurance.length
              ? data.vehicleInsurance.map((d) => `${d.issuer ?? "policy"}${d.expiresOn ? ` - ${d.status === "expired" ? "expired" : "expires"} ${d.expiresOn}` : ""}`).join("; ")
              : "none on file. Text a photo of the policy or add it under Compliance."}
          </p>
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">Equipment</h4>
          {data.equipment.length === 0 && editing !== "equipment:new" && <p className="text-xs text-muted-foreground">No equipment yet.</p>}
          <ul className="space-y-1.5">
            {data.equipment.map((e) =>
              editing === `equipment:${e.id}` ? (
                <li key={e.id}>
                  <EquipmentForm initial={e} busy={busy} onSave={(equipment) => act.mutate({ action: "save_equipment", equipment })} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <li key={e.id} className="flex items-start justify-between gap-2 rounded-lg border border-border px-2.5 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{e.name}</span>
                    <span className="text-xs text-muted-foreground"> {[e.serial ? `#${e.serial}` : null, e.valueCents != null ? money(e.valueCents) : null].filter(Boolean).join(" · ")}</span>
                    <span className="block text-xs text-muted-foreground">{e.statusWords}</span>
                    {e.serviceWords && <span className={cn("block text-xs", toneCls(e.tone))}>{e.serviceWords}</span>}
                  </span>
                  {canManage && (
                    <span className="flex flex-wrap gap-1 shrink-0 justify-end">
                      {e.status !== "out" && (
                        <button type="button" disabled={busy} onClick={() => act.mutate({ action: "equipment_status", equipmentId: e.id, status: "out" })} className="h-6 px-2 rounded border border-border text-xs">
                          Out
                        </button>
                      )}
                      {e.status !== "available" && (
                        <button type="button" disabled={busy} onClick={() => act.mutate({ action: "equipment_status", equipmentId: e.id, status: "available" })} className="h-6 px-2 rounded border border-border text-xs">
                          Back
                        </button>
                      )}
                      {e.status !== "in_shop" && (
                        <button type="button" disabled={busy} onClick={() => act.mutate({ action: "equipment_status", equipmentId: e.id, status: "in_shop" })} className="h-6 px-2 rounded border border-border text-xs">
                          In shop
                        </button>
                      )}
                      <button type="button" disabled={busy} onClick={() => act.mutate({ action: "service_done", equipmentId: e.id, label: "service" })} className="h-6 px-2 rounded border border-border text-xs">
                        Serviced
                      </button>
                      <button type="button" aria-label={`Edit ${e.name}`} onClick={() => setEditing(`equipment:${e.id}`)} className="h-6 w-6 grid place-items-center text-muted-foreground hover:text-foreground">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
          {canManage &&
            (editing === "equipment:new" ? (
              <EquipmentForm busy={busy} onSave={(equipment) => act.mutate({ action: "save_equipment", equipment })} onCancel={() => setEditing(null)} />
            ) : (
              <button type="button" onClick={() => setEditing("equipment:new")} className={cn(btn, "flex items-center gap-1")}>
                <Plus className="w-3.5 h-3.5" /> Add equipment
              </button>
            ))}
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">Rentals</h4>
          {open.length === 0 && editing !== "rental:new" && <p className="text-xs text-muted-foreground">Nothing rented right now.</p>}
          <ul className="space-y-1.5">
            {open.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-2 text-sm">
                <span className={cn("min-w-0 text-xs", toneCls(r.tone))}>{r.words}</span>
                {canManage && (
                  <button type="button" disabled={busy} onClick={() => act.mutate({ action: "return_rental", rentalId: r.id })} className="h-6 px-2 rounded border border-border text-xs shrink-0">
                    Returned
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManage &&
            (editing === "rental:new" ? (
              <RentalForm busy={busy} onSave={(rental) => act.mutate({ action: "save_rental", rental })} onCancel={() => setEditing(null)} />
            ) : (
              <button type="button" onClick={() => setEditing("rental:new")} className={cn(btn, "flex items-center gap-1")}>
                <Plus className="w-3.5 h-3.5" /> Add rental
              </button>
            ))}
          {returned.length > 0 && <p className="text-xs text-muted-foreground">Returned lately: {returned.map((r) => r.words.split(",")[0]).join("; ")}</p>}
        </div>

        <p className="text-xs text-muted-foreground">Or text your assistant: "truck 2 at 84,200", "oil change done on truck 2", "rented a mini-ex from Sunbelt, $380/day, back Thursday 5pm", "mini-ex is back", "fleet".</p>
        {!data.ownerPhoneOnFile && s.enabled && s.reminders && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to get the heads-up texts.</p>}
        {!s.enabled && s.enabledIsDefault && !s.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn it on to track vehicles, equipment and rentals.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}
