import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Package, AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import {
  describeApplyReport,
  perUnit,
  useApplyIndustryPack,
  useIndustryPacks,
  useSaveCatalogPrices,
} from "@/lib/industry-pack-hooks";
import type { IndustryPackSummary, NeedsPriceItem } from "@/lib/api-client";

/**
 * Industry starter packs in the onboarding wizard (Services step) and Settings.
 * A pack ships services WITHOUT prices — the owner types their own prices here, and an
 * item only switches on for quoting once it has one.
 */

const inputCls =
  "px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30";
const primaryBtn =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]";

/** Cards for choosing a pack. */
export function PackCards({
  packs,
  selectedId,
  appliedId,
  onSelect,
}: {
  packs: IndustryPackSummary[];
  selectedId: string | null;
  appliedId?: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {packs.map((p) => {
        const selected = p.id === selectedId;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            aria-pressed={selected}
            className={cn(
              "text-left rounded-lg border p-3 transition-colors",
              selected ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-secondary/50",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">{p.name}</p>
              {appliedId === p.id ? (
                <span className="text-[10px] font-medium text-emerald-400">applied</span>
              ) : selected ? (
                <Check className="w-4 h-4 text-primary" />
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{p.tagline}</p>
            <p className="text-[11px] text-muted-foreground/80 mt-1.5">
              {p.services.length} services · {p.recipes.length} automations
            </p>
          </button>
        );
      })}
    </div>
  );
}

/** Price entry for catalog items that have none yet. Empty rows are highlighted. */
export function PackPriceList({ orgId, companyId, items }: { orgId: string; companyId: string; items: NeedsPriceItem[] }) {
  const save = useSaveCatalogPrices(orgId);
  const [prices, setPrices] = useState<Record<string, string>>({});

  // Drop entries for items that got priced (they leave the list on refetch).
  useEffect(() => {
    setPrices((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => items.some((i) => i.id === id))));
  }, [items]);

  const entered = items
    .map((i) => ({ id: i.id, dollars: Number.parseFloat(prices[i.id] ?? "") }))
    .filter((e) => Number.isFinite(e.dollars) && e.dollars > 0);

  const submit = async () => {
    if (entered.length === 0) return;
    try {
      await save.mutateAsync({ companyId, items: entered.map((e) => ({ id: e.id, rateCents: Math.round(e.dollars * 100) })) });
      toast.success(`Saved ${entered.length} price${entered.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save prices.");
    }
  };

  if (items.length === 0) {
    return (
      <p className="text-xs text-emerald-400 flex items-center gap-1.5">
        <Check className="w-3.5 h-3.5" /> Every service has a price.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-amber-400 flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5" />
        {items.length} service{items.length === 1 ? "" : "s"} still need{items.length === 1 ? "s" : ""} your price. They stay
        off quotes until priced — your receptionist will take a message instead.
      </p>
      <div className="space-y-1.5">
        {items.map((item) => {
          const missing = !(Number.parseFloat(prices[item.id] ?? "") > 0);
          return (
            <div
              key={item.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border p-2",
                missing ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-card",
              )}
            >
              <span className="flex-1 text-sm text-foreground min-w-0 truncate">{item.label}</span>
              <span className="text-xs text-muted-foreground w-28 text-right shrink-0">{perUnit(item.unit)}</span>
              <span className="text-sm text-muted-foreground">$</span>
              <input
                className={cn(inputCls, "w-28")}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                aria-label={`Price for ${item.label}`}
                value={prices[item.id] ?? ""}
                onChange={(e) => setPrices((p) => ({ ...p, [item.id]: e.target.value }))}
                placeholder="Your price"
              />
            </div>
          );
        })}
      </div>
      <button className={primaryBtn} disabled={entered.length === 0 || save.isPending} onClick={() => void submit()}>
        {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save {entered.length || ""} price
        {entered.length === 1 ? "" : "s"}
      </button>
    </div>
  );
}

/**
 * Wizard Services step: "Start from an industry pack". Applying adds the pack's services
 * (no prices) and records the pack; its automations are tailored at the Automations step.
 */
export function IndustryPackPicker({ orgId, companyId }: { orgId: string; companyId: string | null }) {
  const { data, isLoading } = useIndustryPacks(orgId, companyId);
  const apply = useApplyIndustryPack(orgId);
  const [selected, setSelected] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const applied = data?.applied ?? null;
  const appliedPack = useMemo(() => data?.packs.find((p) => p.id === applied?.id) ?? null, [data, applied]);

  const run = async (packId: string) => {
    if (!companyId) return;
    try {
      const report = await apply.mutateAsync({ companyId, packId, services: true, recipes: "none" });
      toast.success(`${report.pack.name}: ${describeApplyReport(report)}`);
      setChanging(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't apply that pack.");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading industry packs…
      </div>
    );
  }
  if (!data || !companyId) return null;

  if (appliedPack && !changing) {
    return (
      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Package className="w-4 h-4 text-primary" /> {appliedPack.name} pack
          </p>
          <button className="text-xs font-medium text-primary hover:opacity-80" onClick={() => setChanging(true)}>
            Change pack
          </button>
        </div>
        <PackPriceList orgId={orgId} companyId={companyId} items={data.needsPrices} />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <p className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Package className="w-4 h-4 text-primary" /> Start from an industry pack
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Adds a ready-made service list for your trade (you add your own prices), plus texts and receptionist notes written for it.
        </p>
      </div>
      <PackCards packs={data.packs} selectedId={selected} appliedId={applied?.id ?? null} onSelect={setSelected} />
      {selected && (
        <div className="text-xs text-muted-foreground">
          {data.packs
            .find((p) => p.id === selected)
            ?.services.map((s) => `${s.label} (${perUnit(s.unit)})`)
            .join(" · ")}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button className={primaryBtn} disabled={!selected || apply.isPending} onClick={() => selected && void run(selected)}>
          {apply.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Use this pack
        </button>
        {changing && (
          <button className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setChanging(false)}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
