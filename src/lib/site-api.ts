/** Settings → Your website: the company's generated page (docs/done-for-you.md → "Generated sites"). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export type SiteStatus = "draft" | "published" | "unpublished";
export type SiteMode = "full" | "price_page";

export interface SiteView {
  companyId: string;
  companyName: string;
  hasWebsite: boolean;
  canManage: boolean;
  site: null | {
    slug: string;
    status: SiteStatus;
    mode: SiteMode;
    url: string;
    previewUrl: string;
    generatedAt: string | null;
    publishedAt: string | null;
    copySource: "ai" | "template" | "mixed" | null;
    headline: string;
    subhead: string;
    about: string;
    generated: { headline: string; subhead: string; about: string } | null;
    edited: { headline: boolean; subhead: boolean; about: boolean };
    showPrices: boolean;
    servicesCount: number;
    pricedCount: number;
    factsUsed: string[];
  };
}

export interface SiteEditInput {
  headline?: string | null;
  subhead?: string | null;
  about?: string | null;
  showPrices?: boolean;
  mode?: SiteMode;
}

export type SiteAction = "generate" | "regenerate" | "publish" | "unpublish";

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/site`;
const KEY = "company-site";

export const fetchSite = (orgId: string, companyId: string) => apiFetch<SiteView>(path(orgId, companyId));
export const saveSiteEdits = (orgId: string, companyId: string, body: SiteEditInput) =>
  apiFetch<SiteView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(body) });
export const runSiteAction = (orgId: string, companyId: string, action: SiteAction, publish?: boolean) =>
  apiFetch<SiteView>(path(orgId, companyId), { method: "POST", body: JSON.stringify({ action, ...(publish !== undefined ? { publish } : {}) }) });

export function useSite(orgId: string, companyId: string | null) {
  return useQuery({ queryKey: [KEY, orgId, companyId], queryFn: () => fetchSite(orgId, companyId!), enabled: Boolean(orgId && companyId) });
}

export function useSaveSiteEdits(orgId: string, companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SiteEditInput) => saveSiteEdits(orgId, companyId, body),
    onSuccess: (data) => qc.setQueryData([KEY, orgId, companyId], data),
  });
}

export function useSiteAction(orgId: string, companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { action: SiteAction; publish?: boolean }) => runSiteAction(orgId, companyId, input.action, input.publish),
    onSuccess: (data) => qc.setQueryData([KEY, orgId, companyId], data),
  });
}
