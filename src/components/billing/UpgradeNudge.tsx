import { useNavigate } from "react-router-dom";
import { Lock, Sparkles } from "lucide-react";

import { useOrg } from "@/lib/org-context";
import { useBilling } from "@/lib/api-hooks";

/**
 * Whether the current org may use a billing-gated feature. Optimistic (returns
 * true) while billing is still loading or unavailable — the server enforces the
 * real boundary via requireFeature, so this only drives UX (locks / nudges),
 * never security.
 */
export function useCanUseFeature(feature: string): boolean {
  const { organizationId } = useOrg();
  const { data: billing } = useBilling(organizationId);
  return billing?.gating?.[feature] ?? true;
}

/** Full-panel upgrade prompt shown in place of a gated feature's UI. */
export function UpgradeNudge({
  title = "Not included in your plan",
  description = "This feature isn't part of your current plan. Upgrade to unlock it.",
}: {
  title?: string;
  description?: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center text-center p-10 rounded-2xl border border-dashed border-primary/30 bg-primary/5">
      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
        <Lock className="w-5 h-5 text-primary" />
      </div>
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-sm mt-1">{description}</p>
      <button
        onClick={() => navigate("/settings/billing")}
        className="mt-4 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
      >
        <Sparkles className="w-4 h-4" /> View plans
      </button>
    </div>
  );
}
