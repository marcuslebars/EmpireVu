/**
 * The no-login import link (/import/:token) the owner can be texted — same pattern as the
 * done-for-you setup link (/setup/:token): the unguessable token IS the credential and only ever
 * reaches the one company it was minted for. One row per company in import_links (service role
 * only; no client can read a token). A link works for 14 days after it was last sent; an expired
 * one gets a fresh token when it's sent again.
 */
import { isDoneForYou } from "@/lib/product-line";
import { randomBytes } from "node:crypto";

import type { AdminClient } from "@/server/services/front-desk/contracts";
import { appBaseUrlFor } from "@/server/services/platform-brand";
import type { Db, ImportLinkRow } from "./db-types";
import type { ImporterDeps } from "./deps";
import type { ImportCompany } from "./settings";
import { loadImportCompany } from "./settings";

export const LINK_TTL_MS = 14 * 86_400_000;

export function newImportToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isImportToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);
}

export function importUrlFor(platformBrand: string | null, token: string): string {
  return `${appBaseUrlFor(isDoneForYou(platformBrand) ? "crankleads" : "empirevu")}/import/${token}`;
}

/** The company's link, made (or refreshed: 14 more days; a new token if it had expired). */
export async function ensureImportLink(admin: AdminClient, scope: { organizationId: string; companyId: string }, nowMs: number): Promise<ImportLinkRow> {
  const db = admin as Db;
  const expiresAt = new Date(nowMs + LINK_TTL_MS).toISOString();
  const { data: existing, error } = await db.from("import_links").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).maybeSingle();
  if (error) throw error;
  const row = existing as ImportLinkRow | null;
  if (row) {
    const expired = Date.parse(row.expires_at) <= nowMs;
    const patch = expired ? { token: newImportToken(), expires_at: expiresAt } : { expires_at: expiresAt };
    const { data, error: updateError } = await db.from("import_links").update(patch).eq("id", row.id).eq("organization_id", scope.organizationId).select("*").maybeSingle();
    if (updateError) throw updateError;
    return (data as ImportLinkRow | null) ?? { ...row, ...patch };
  }
  const { data, error: insertError } = await db
    .from("import_links")
    .insert({ organization_id: scope.organizationId, company_id: scope.companyId, token: newImportToken(), expires_at: expiresAt })
    .select("*")
    .single();
  if (insertError) {
    // Two requests at once: the other one made it.
    const { data: again } = await db.from("import_links").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).maybeSingle();
    if (again) return again as ImportLinkRow;
    throw insertError;
  }
  return data as ImportLinkRow;
}

/** The company a token belongs to (null for a bad / unknown / expired token — one answer for every miss). */
export async function companyForToken(admin: AdminClient, token: string, nowMs: number): Promise<ImportCompany | null> {
  if (!isImportToken(token)) return null;
  const { data, error } = await (admin as Db).from("import_links").select("organization_id, company_id, expires_at").eq("token", token).maybeSingle();
  if (error) throw error;
  const row = data as Pick<ImportLinkRow, "organization_id" | "company_id" | "expires_at"> | null;
  if (!row || Date.parse(row.expires_at) <= nowMs) return null;
  const company = await loadImportCompany(admin, row.organization_id, row.company_id);
  if (!company || !company.settings.enabled) return null;
  return company;
}

export type SendLinkOutcome = { status: "sent"; url: string } | { status: "no_phone" | "off" | "failed" | "blocked"; url: string | null };

/** Text the owner the import link from the platform number (verified owner cell only). */
export async function sendImportLink(admin: AdminClient, scope: { organizationId: string; companyId: string }, deps: Pick<ImporterDeps, "textOwner" | "now">): Promise<SendLinkOutcome> {
  const company = await loadImportCompany(admin, scope.organizationId, scope.companyId);
  if (!company || !company.settings.enabled) return { status: "off", url: null };
  const nowMs = deps.now();
  const link = await ensureImportLink(admin, scope, nowMs);
  const url = importUrlFor(company.platformBrand, link.token);
  if (!company.ownerPhone) return { status: "no_phone", url };
  const body = `Bring your customer list over: upload a spreadsheet (CSV or Excel) from Jobber, QuickBooks, Housecall Pro, Square or your own. You'll see a preview before anything is saved, and nobody gets texted. ${url}`;
  const status = await deps.textOwner(admin, { to: company.ownerPhone, body, organizationId: scope.organizationId, companyId: scope.companyId, platformBrand: company.platformBrand });
  if (status === "sent") {
    await (admin as Db).from("import_links").update({ sent_at: new Date(nowMs).toISOString() }).eq("id", link.id).eq("organization_id", scope.organizationId);
    return { status: "sent", url };
  }
  return { status, url };
}
