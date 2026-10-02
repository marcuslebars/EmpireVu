/**
 * React Query hooks + small helpers for industry starter packs (kept in their own module so the
 * onboarding wizard and Settings can share them without touching api-hooks.ts).
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  applyIndustryPack,
  fetchIndustryPacks,
  saveCatalogPrices,
  type ApplyIndustryPackInput,
  type ApplyIndustryPackReport,
  type IndustryPackListing,
} from "@/lib/api-client";

export function useIndustryPacks(orgId: string, companyId?: string | null) {
  return useQuery<IndustryPackListing>({
    queryKey: ["industry-packs", orgId, companyId ?? null],
    queryFn: () => fetchIndustryPacks(orgId, companyId),
    enabled: Boolean(orgId),
  });
}

export function useApplyIndustryPack(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApplyIndustryPackInput) => applyIndustryPack(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["industry-packs", orgId] });
      void qc.invalidateQueries({ queryKey: ["automations", "recipes", orgId] });
      void qc.invalidateQueries({ queryKey: ["automations", "workflows", orgId] });
      void qc.invalidateQueries({ queryKey: ["onboarding", orgId] });
    },
  });
}

export function useSaveCatalogPrices(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { companyId: string; items: Array<{ id: string; rateCents: number }> }) => saveCatalogPrices(orgId, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["industry-packs", orgId] }),
  });
}

export function perUnit(unit: string | null): string {
  return unit ? `per ${unit}` : "";
}

/** One-line summary of what an apply did. */
export function describeApplyReport(report: ApplyIndustryPackReport): string {
  const parts = [
    `${report.services.created.length} services added`,
    report.services.skipped.length ? `${report.services.skipped.length} already there` : null,
    report.recipes.installed.length + report.recipes.updated.length
      ? `${report.recipes.installed.length + report.recipes.updated.length} automations tailored`
      : null,
    report.recipes.skippedOwnerEdited.length ? `${report.recipes.skippedOwnerEdited.length} of your edited automations left alone` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Wizard Automations step helper: the company's pack (if any) and a function that tailors
 * the chosen pack recipes. Recipes the owner edited are left alone server-side.
 */
export function usePackRecipes(orgId: string, companyId: string | null) {
  const { data } = useIndustryPacks(orgId, companyId);
  const apply = useApplyIndustryPack(orgId);
  const pack = useMemo(() => data?.packs.find((p) => p.id === data?.applied?.id) ?? null, [data]);

  const applyRecipes = async (slugs: string[]): Promise<ApplyIndustryPackReport | null> => {
    if (!pack || !companyId || slugs.length === 0) return null;
    return apply.mutateAsync({ companyId, packId: pack.id, services: false, recipes: slugs });
  };

  return { pack, applyRecipes, isPending: apply.isPending };
}
