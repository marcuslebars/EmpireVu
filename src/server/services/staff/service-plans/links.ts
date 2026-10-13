/**
 * Public links: the plans page and a customer's own renewal page, both on the company's generated
 * site (/s/<slug>/plans…, or <PAGES_BASE_URL>/<slug>/plans… on the pages host). No published site →
 * no link (the callers say so / fall back).
 */
import { isDoneForYou } from "@/lib/product-line";
import { siteUrl } from "@/server/services/dfy/site-url";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";
import type { PlanCompany } from "./settings";

export async function publishedSlug(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<string | null> {
  const { data } = await (admin as Db)
    .from("company_sites")
    .select("slug, status")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("status", "published")
    .limit(1);
  return ((data ?? []) as Array<{ slug: string | null }>)[0]?.slug ?? null;
}

function base(slug: string, company: Pick<PlanCompany, "platformBrand">): string {
  return siteUrl(slug, isDoneForYou(company.platformBrand) ? "crankleads" : "empirevu");
}

export function plansUrlFor(slug: string, company: Pick<PlanCompany, "platformBrand">): string {
  return `${base(slug, company)}/plans`;
}

export function renewalUrlFor(slug: string, company: Pick<PlanCompany, "platformBrand">, token: string): string {
  return `${base(slug, company)}/plans/renew/${token}`;
}

export async function plansPageUrl(admin: AdminClient, company: PlanCompany): Promise<string | null> {
  const slug = await publishedSlug(admin, company).catch(() => null);
  return slug ? plansUrlFor(slug, company) : null;
}
