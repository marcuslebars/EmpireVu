import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Package, Pencil, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Purchasing (docs/ai-staff.md → "Purchasing"): on/off, lead days,
 * questions per day, pickup or delivery, the AI estimate, suppliers (owners/admins) and a simple
 * recipe editor (what one unit of each price-list service takes). Self-contained.
 */

type Fulfilment = "pickup" | "delivery";

export interface PurchasingSettingsView {
  enabled: boolean;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  leadDays: number;
  maxPerDay: number;
  defaultFulfilment: Fulfilment;
  aiEstimate: boolean;
}

export interface PurchasingSupplier {
  id: string;
  name: string;
  branch: string | null;
  email: string | null;
  phone: string | null;
  accountNumber: string | null;
  preferred: boolean;
  notes: string | null;
}

export interface PurchasingRecipeLine {
  label: string;
  qtyPerUnit: number;
  unit: string | null;
  estUnitCostCents: number | null;
  supplierId: string | null;
}

export interface PurchasingView {
  companyId: string;
  companyName: string;
  settings: PurchasingSettingsView;
  ownerPhoneOnFile: boolean;
  replyToEmail: string | null;
  aiAvailable: boolean;
  suppliers: PurchasingSupplier[] | null;
  catalog: Array<{ id: string; label: string; unitLabel: string | null; recipe: PurchasingRecipeLine[] }>;
  orders: Array<{ id: string; poNumber: string; status: string; job: string | null; jobDay: string | null; supplier: string | null; fulfilment: Fulfilment; estTotalCents: number; estimate: boolean; items: string[] }>;
}

type Patch = { enabled?: boolean; leadDays?: number; maxPerDay?: number; defaultFulfilment?: Fulfilment; aiEstimate?: boolean };
type Action =
  | { action: "save_supplier"; supplier: Partial<Omit<PurchasingSupplier, "id">> & { id?: string } }
  | { action: "remove_supplier"; supplierId: string }
  | { action: "save_recipe"; catalogItemId: string; lines: PurchasingRecipeLine[] };

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/purchasing`;
const LEAD_DAYS = [1, 2, 3, 4, 5, 7, 10, 14];
const PER_DAY = [1, 2, 3, 4, 5, 8, 10, 15, 20];
const STATUS: Record<string, string> = {
  draft: "Waiting on your Y/N",
  approved: "To call in",
  sent: "Emailed",
  confirmed: "Confirmed",
  ready: "Ready",
  picked_up: "Picked up",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;
const inputCls = "h-8 rounded-md border border-border bg-background px-2 text-sm";

function SupplierForm({ initial, busy, onSave, onCancel }: { initial: Partial<PurchasingSupplier>; busy: boolean; onSave: (s: Partial<PurchasingSupplier>) => void; onCancel: () => void }) {
  const [s, setS] = useState<Partial<PurchasingSupplier>>(initial);
  const field = (key: keyof PurchasingSupplier, label: string, type = "text") => (
    <input
      aria-label={label}
      placeholder={label}
      type={type}
      value={(s[key] as string | null | undefined) ?? ""}
      onChange={(e) => setS({ ...s, [key]: e.target.value })}
      className={cn(inputCls, "w-full")}
    />
  );
  return (
    <div className="rounded-lg border border-border p-2.5 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {field("name", "Supplier name")}
        {field("branch", "Branch (e.g. Barrie)")}
        {field("email", "Order email", "email")}
        {field("phone", "Phone", "tel")}
        {field("accountNumber", "Account number")}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-primary w-4 h-4" checked={Boolean(s.preferred)} onChange={(e) => setS({ ...s, preferred: e.target.checked })} />
        Main supplier (used when a recipe doesn't name one)
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !s.name?.trim()} onClick={() => onSave(s)} className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">
          Save
        </button>
        <button type="button" onClick={onCancel} className="h-8 px-3 rounded-md border border-border text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

function RecipeEditor({ view, busy, onSave }: { view: PurchasingView; busy: boolean; onSave: (catalogItemId: string, lines: PurchasingRecipeLine[]) => void }) {
  const [itemId, setItemId] = useState<string>("");
  const [lines, setLines] = useState<Array<{ label: string; qty: string; unit: string; cost: string; supplierId: string }>>([]);
  const item = view.catalog.find((i) => i.id === itemId);
  const pick = (id: string) => {
    setItemId(id);
    const next = view.catalog.find((i) => i.id === id);
    setLines(
      (next?.recipe ?? []).map((l) => ({ label: l.label, qty: String(l.qtyPerUnit), unit: l.unit ?? "", cost: l.estUnitCostCents != null ? (l.estUnitCostCents / 100).toFixed(2) : "", supplierId: l.supplierId ?? "" })),
    );
  };
  const save = () => {
    const out: PurchasingRecipeLine[] = [];
    for (const l of lines) {
      if (!l.label.trim()) continue;
      const qty = Number(l.qty);
      if (!(qty > 0)) return toast.error(`${l.label}: enter how many per unit.`);
      const cost = l.cost.trim() ? Math.round(Number(l.cost.replace(/[$,]/g, "")) * 100) : null;
      if (cost != null && !(cost >= 0)) return toast.error(`${l.label}: the cost looks off.`);
      out.push({ label: l.label.trim(), qtyPerUnit: qty, unit: l.unit.trim() || null, estUnitCostCents: cost, supplierId: l.supplierId || null });
    }
    onSave(itemId, out);
  };
  if (view.catalog.length === 0) return <p className="text-xs text-muted-foreground">Add services to your price list to set what each one takes.</p>;
  return (
    <div className="space-y-2">
      <select aria-label="Price-list service" value={itemId} onChange={(e) => pick(e.target.value)} className={cn(inputCls, "w-full sm:w-auto")}>
        <option value="">Pick a service…</option>
        {view.catalog.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label}
            {i.recipe.length ? ` (${i.recipe.length} materials)` : ""}
          </option>
        ))}
      </select>
      {item && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Materials for one {item.unitLabel ?? "job"} of {item.label}. Amounts are rounded up when ordering.</p>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_4.5rem] sm:grid-cols-[1fr_4.5rem_6rem_5.5rem_8rem_2rem] gap-1.5 items-center">
              <input aria-label="Material" placeholder="Material (e.g. shingles)" value={l.label} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={inputCls} />
              <input aria-label="Per unit" placeholder="Qty" inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} className={inputCls} />
              <input aria-label="Unit" placeholder="bundles" value={l.unit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} className={inputCls} />
              <input aria-label="Cost each" placeholder="$ each" inputMode="decimal" value={l.cost} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} className={inputCls} />
              <select aria-label="Supplier" value={l.supplierId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, supplierId: e.target.value } : x)))} className={inputCls}>
                <option value="">Main supplier</option>
                {(view.suppliers ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.branch ? ` (${s.branch})` : ""}
                  </option>
                ))}
              </select>
              <button type="button" aria-label="Remove material" onClick={() => setLines(lines.filter((_, j) => j !== i))} className="h-8 w-8 grid place-items-center text-muted-foreground hover:text-foreground">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button type="button" onClick={() => setLines([...lines, { label: "", qty: "1", unit: "", cost: "", supplierId: "" }])} className="h-8 px-3 rounded-md border border-border text-sm flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> Material
            </button>
            <button type="button" disabled={busy} onClick={save} className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">
              Save recipe
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PurchasingSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["purchasing-settings", orgId, companyId];
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<PurchasingView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const onDone = (view: PurchasingView) => {
    qc.setQueryData(queryKey, view);
    toast.success("Saved");
  };
  const onError = (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save");
  const update = useMutation({ mutationFn: (patch: Patch) => apiFetch<PurchasingView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }), onSuccess: onDone, onError });
  const act = useMutation({
    mutationFn: (body: Action) => apiFetch<PurchasingView>(path(orgId, companyId), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (view) => {
      onDone(view);
      setEditing(null);
    },
    onError,
  });

  const title = "Purchasing";
  const description = "Orders materials for booked jobs: a list from each quote, your OK by text, then an email to your supplier. Reminds you to pick it up.";
  const icon = <Package className="w-4 h-4" />;

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
  const locked = !canManage || update.isPending;
  const supplierPayload = (x: Partial<PurchasingSupplier>, id?: string) => ({
    ...(id ? { id } : {}),
    name: x.name?.trim() || null,
    branch: x.branch?.trim() || null,
    email: x.email?.trim() || null,
    phone: x.phone?.trim() || null,
    accountNumber: x.accountNumber?.trim() || null,
    preferred: Boolean(x.preferred),
  });

  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title={title}
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input type="checkbox" checked={s.enabled} disabled={locked} onChange={(e) => update.mutate({ enabled: e.target.checked })} className="accent-primary w-4 h-4" aria-label="Purchasing on" />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className="space-y-4">
        <fieldset className={cn("space-y-3", !s.enabled && "opacity-60")} disabled={locked || !s.enabled}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              Order for jobs at least
              <select aria-label="Lead days" value={s.leadDays} onChange={(e) => update.mutate({ leadDays: Number(e.target.value) })} className={inputCls}>
                {LEAD_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d} {d === 1 ? "day" : "days"}
                  </option>
                ))}
              </select>
              out
            </label>
            <label className="flex items-center gap-2">
              Up to
              <select aria-label="Questions per day" value={s.maxPerDay} onChange={(e) => update.mutate({ maxPerDay: Number(e.target.value) })} className={inputCls}>
                {PER_DAY.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              orders to OK a day
            </label>
            <label className="flex items-center gap-2">
              Usually
              <select aria-label="Pickup or delivery" value={s.defaultFulfilment} onChange={(e) => update.mutate({ defaultFulfilment: e.target.value as Fulfilment })} className={inputCls}>
                <option value="pickup">pick up</option>
                <option value="delivery">get it delivered</option>
              </select>
            </label>
          </div>
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="accent-primary mt-0.5 w-4 h-4" checked={s.aiEstimate} onChange={(e) => update.mutate({ aiEstimate: e.target.checked })} />
            <span>
              <span className="block font-medium text-foreground">Estimate materials when there's no recipe</span>
              <span className="block text-xs text-muted-foreground">An AI list from the quote, marked "estimate" in the text so you can check it.{!data.aiAvailable && " (AI isn't set up on this server, so only recipes are used.)"}</span>
            </span>
          </label>
        </fieldset>

        {data.suppliers && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-foreground">Suppliers</h4>
            {data.suppliers.length === 0 && editing !== "new" && <p className="text-xs text-muted-foreground">No suppliers yet. Without one, approved lists are texted to you to call in.</p>}
            <ul className="space-y-1.5">
              {data.suppliers.map((sup) =>
                editing === sup.id ? (
                  <li key={sup.id}>
                    <SupplierForm initial={sup} busy={act.isPending} onSave={(x) => act.mutate({ action: "save_supplier", supplier: supplierPayload(x, sup.id) })} onCancel={() => setEditing(null)} />
                  </li>
                ) : (
                  <li key={sup.id} className="flex items-start justify-between gap-2 rounded-lg border border-border px-2.5 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">
                        {sup.name}
                        {sup.branch ? ` (${sup.branch})` : ""}
                      </span>
                      {sup.preferred && <span className="ml-2 text-[10px] uppercase tracking-wide text-primary">Main</span>}
                      <span className="block text-xs text-muted-foreground truncate">
                        {[sup.email ?? "no email - lists are texted to you", sup.phone, sup.accountNumber ? `acct ${sup.accountNumber}` : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {canManage && (
                      <span className="flex gap-1 shrink-0">
                        <button type="button" aria-label={`Edit ${sup.name}`} onClick={() => setEditing(sup.id)} className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" aria-label={`Remove ${sup.name}`} onClick={() => act.mutate({ action: "remove_supplier", supplierId: sup.id })} className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    )}
                  </li>
                ),
              )}
            </ul>
            {canManage &&
              (editing === "new" ? (
                <SupplierForm initial={{ preferred: data.suppliers.length === 0 }} busy={act.isPending} onSave={(x) => act.mutate({ action: "save_supplier", supplier: supplierPayload(x) })} onCancel={() => setEditing(null)} />
              ) : (
                <button type="button" onClick={() => setEditing("new")} className="h-8 px-3 rounded-md border border-border text-sm flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add supplier
                </button>
              ))}
            {data.suppliers.some((x) => x.email) && (
              <p className="text-xs text-muted-foreground">{data.replyToEmail ? `Orders are emailed from ${data.companyName}; replies go to ${data.replyToEmail}.` : "Add your email to the business profile so supplier replies reach you."}</p>
            )}
          </div>
        )}

        {canManage && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-foreground">Recipes</h4>
            <RecipeEditor view={data} busy={act.isPending} onSave={(catalogItemId, lines) => act.mutate({ action: "save_recipe", catalogItemId, lines })} />
          </div>
        )}

        {data.orders.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-foreground">Recent orders</h4>
            <ul className="rounded-lg border border-border divide-y divide-border text-sm">
              {data.orders.map((o) => (
                <li key={o.id} className="px-2.5 py-2">
                  <span className="flex justify-between gap-2">
                    <span className="font-medium text-foreground truncate">
                      {o.poNumber} · {o.job ?? "no job"} {o.jobDay ? `(${o.jobDay})` : ""}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{STATUS[o.status] ?? o.status}</span>
                  </span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {o.supplier ?? "no supplier"} · {o.fulfilment} · {o.estTotalCents > 0 ? `~${money(o.estTotalCents)}${o.estimate ? " (estimate)" : ""}` : "no prices"} · {o.items.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Text your assistant "materials status", "PO-12 ready" or "picked up the Jones materials". Real costs come from your receipts, so nothing is counted twice.</p>
        {!data.ownerPhoneOnFile && s.enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to OK orders by text.</p>}
        {!s.enabled && s.enabledIsDefault && !s.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn it on to have materials ordered for quoted jobs.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}
