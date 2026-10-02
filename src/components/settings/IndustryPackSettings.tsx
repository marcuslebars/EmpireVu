import { useEffect, useState } from "react";
import { Loader2, Package, RefreshCw } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { useAuth } from "@/lib/auth-context";
import { useCompanies } from "@/lib/api-hooks";
import { describeApplyReport, useApplyIndustryPack, useIndustryPacks } from "@/lib/industry-pack-hooks";
import type { ApplyIndustryPackReport } from "@/lib/api-client";
import { PackCards, PackPriceList } from "@/components/onboarding/IndustryPackPicker";
import { relativeTime } from "@/lib/format";

/**
 * Settings → Industry pack: see which starter pack each company has, apply or re-apply one
 * (idempotent — nothing is duplicated and automations the owner edited are left alone), and
 * enter prices for services that don't have one yet.
 */
function PackCompanyCard({ orgId, companyId, companyName }: { orgId: string; companyId: string; companyName: string }) {
  const { data, isLoading } = useIndustryPacks(orgId, companyId);
  const apply = useApplyIndustryPack(orgId);
  const [selected, setSelected] = useState<string | null>(null);
  const [withServices, setWithServices] = useState(true);
  const [withRecipes, setWithRecipes] = useState(true);
  const [withBooking, setWithBooking] = useState(false);
  const [report, setReport] = useState<ApplyIndustryPackReport | null>(null);

  const applied = data?.applied ?? null;
  useEffect(() => {
    if (applied && selected === null) setSelected(applied.id);
  }, [applied, selected]);

  const appliedPack = data?.packs.find((p) => p.id === applied?.id) ?? null;
  const updateAvailable = Boolean(appliedPack && applied && appliedPack.version > applied.version);
  const isReapply = Boolean(applied && selected === applied.id);
  const selectedPack = data?.packs.find((p) => p.id === selected) ?? null;

  const run = async () => {
    if (!selected) return;
    try {
      const result = await apply.mutateAsync({
        companyId,
        packId: selected,
        services: withServices,
        recipes: withRecipes ? "all" : "none",
        bookingPolicy: withBooking,
      });
      setReport(result);
      toast.success(`${result.pack.name}: ${describeApplyReport(result)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't apply the pack.");
    }
  };

  return (
    <div className="p-4 rounded-xl border border-border bg-card space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          <Package className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{companyName}</p>
          <p className="text-xs text-muted-foreground">
            {applied && appliedPack
              ? `${appliedPack.name} pack v${applied.version}${applied.appliedAt ? ` · applied ${relativeTime(applied.appliedAt)}` : ""}`
              : "No industry pack applied"}
            {updateAvailable && <span className="text-amber-400"> · v{appliedPack?.version} available — re-apply to update</span>}
          </p>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <PackCards packs={data.packs} selectedId={selected} appliedId={applied?.id ?? null} onSelect={setSelected} />
          {selectedPack && <p className="text-xs text-muted-foreground">{selectedPack.description}</p>}

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-primary w-4 h-4" checked={withServices} onChange={(e) => setWithServices(e.target.checked)} />
              Add missing services (no prices)
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-primary w-4 h-4" checked={withRecipes} onChange={(e) => setWithRecipes(e.target.checked)} />
              Install / update automations
            </label>
            {selectedPack?.hasBookingDefaults && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-primary w-4 h-4" checked={withBooking} onChange={(e) => setWithBooking(e.target.checked)} />
                Set booking windows <span className="text-xs text-muted-foreground">(only if none are set)</span>
              </label>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void run()}
              disabled={!selected || apply.isPending || (!withServices && !withRecipes && !withBooking)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]"
            >
              {apply.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isReapply ? <RefreshCw className="w-3.5 h-3.5" /> : null}
              {isReapply ? "Re-apply pack" : applied ? "Switch to this pack" : "Apply pack"}
            </button>
            <span className="text-xs text-muted-foreground">Safe to re-run: nothing is duplicated, and automations you've edited are left alone.</span>
          </div>

          {report && (
            <div className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2 space-y-1">
              <p>{describeApplyReport(report) || "Nothing to change — already up to date."}</p>
              {report.recipes.skippedOwnerEdited.length > 0 && (
                <p>
                  Left alone because you've edited them: {report.recipes.skippedOwnerEdited.map((r) => r.slug).join(", ")}.
                </p>
              )}
              {report.bookingPolicy === "applied" && <p>Booking windows set.</p>}
              {report.bookingPolicy === "kept_existing" && <p>Booking windows already set — kept yours.</p>}
            </div>
          )}

          <div className="pt-1">
            <p className="text-sm font-medium text-foreground mb-2">Prices</p>
            <PackPriceList orgId={orgId} companyId={companyId} items={data.needsPrices} />
          </div>
        </>
      )}
    </div>
  );
}

export function IndustryPackSettings() {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Industry pack</h2>
        <p className="text-sm text-muted-foreground mt-1">
          A starter pack for your trade: a service list (you set the prices), automation texts written for it, and notes that teach
          your receptionist the questions and emergencies that matter. Re-apply after we update a pack. If your phone number is
          already set up, re-run the Phone step in setup so the receptionist picks up the notes.
        </p>
      </div>
      {!canManage ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">Only owners and admins can manage industry packs.</div>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : (companies ?? []).length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">Add a company first.</div>
      ) : (
        <div className="space-y-4">
          {(companies ?? []).map((c) => (
            <PackCompanyCard key={c.id} orgId={organizationId} companyId={c.id} companyName={c.name} />
          ))}
        </div>
      )}
    </div>
  );
}
