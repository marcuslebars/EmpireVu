/**
 * Staff side of the customer portal: get (or create) a customer's link, reset it, send it.
 * Runs under the caller's session — RLS scopes every read and write to their org.
 */
import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import type { TenantServiceContext } from "@/server/services/shared";
import { sendPortalLinkMessage } from "./notify";

type Link = Tables<"customer_portal_links">;

export interface PortalLinkView {
  url: string;
  createdAt: string;
  lastViewedAt: string | null;
  viewCount: number;
}

export const sendPortalSchema = z.object({ channel: z.enum(["sms", "email"]) });

export function newPortalToken(): string {
  return randomBytes(20).toString("hex"); // 40 hex chars, 160 bits
}

export function portalUrl(company: { quote_public_base_url?: string | null } | null, token: string): string {
  return `${quotePublicBaseUrlFor(company)}/p/${token}`;
}

async function contactAndCompany(ctx: TenantServiceContext, contactId: string) {
  const { data: contact, error } = await ctx.supabase
    .from("contacts")
    .select("id, company_id, first_name, last_name, phone, email, sms_opt_out_at, email_opt_out_at")
    .eq("organization_id", ctx.organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw error;
  if (!contact) throw new ValidationError("Contact not found.");
  const { data: company, error: e2 } = await ctx.supabase
    .from("companies")
    .select("id, name, brand_from_name, quote_public_base_url, brand_reply_email")
    .eq("organization_id", ctx.organizationId)
    .eq("id", contact.company_id)
    .maybeSingle();
  if (e2) throw e2;
  if (!company) throw new ValidationError("Company not found.");
  return { contact, company };
}

async function liveLink(ctx: TenantServiceContext, companyId: string, contactId: string): Promise<Link | null> {
  const { data, error } = await ctx.supabase
    .from("customer_portal_links")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", companyId)
    .eq("contact_id", contactId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as Link) ?? null;
}

async function createLink(ctx: TenantServiceContext, companyId: string, contactId: string): Promise<Link> {
  const { data, error } = await ctx.supabase
    .from("customer_portal_links")
    .insert({ organization_id: ctx.organizationId, company_id: companyId, contact_id: contactId, token: newPortalToken(), created_by: ctx.actorProfileId })
    .select("*")
    .single();
  if (error) {
    // Lost a race with another tab creating the link — use theirs.
    if (error.code === "23505") {
      const existing = await liveLink(ctx, companyId, contactId);
      if (existing) return existing;
    }
    throw error;
  }
  return data as Link;
}

function view(link: Link, company: { quote_public_base_url?: string | null }): PortalLinkView {
  return { url: portalUrl(company, link.token), createdAt: link.created_at, lastViewedAt: link.last_viewed_at, viewCount: link.view_count };
}

/** The customer's portal link, created on first use. */
export async function getPortalLink(ctx: TenantServiceContext, contactId: string): Promise<PortalLinkView> {
  const { contact, company } = await contactAndCompany(ctx, contactId);
  const link = (await liveLink(ctx, company.id, contact.id)) ?? (await createLink(ctx, company.id, contact.id));
  return view(link, company);
}

/** Reset: the old link stops working at once; a new one is issued. */
export async function resetPortalLink(ctx: TenantServiceContext, contactId: string): Promise<PortalLinkView> {
  const { contact, company } = await contactAndCompany(ctx, contactId);
  const { error } = await ctx.supabase
    .from("customer_portal_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", company.id)
    .eq("contact_id", contact.id)
    .is("revoked_at", null);
  if (error) throw error;
  return view(await createLink(ctx, company.id, contact.id), company);
}

/** Text or email the link to the customer from the brand. */
export async function sendPortalLink(
  ctx: TenantServiceContext,
  contactId: string,
  channel: "sms" | "email",
): Promise<{ delivered: boolean; reason: string | null; to: string | null }> {
  const { contact, company } = await contactAndCompany(ctx, contactId);
  const link = (await liveLink(ctx, company.id, contact.id)) ?? (await createLink(ctx, company.id, contact.id));
  return sendPortalLinkMessage(ctx, {
    channel,
    companyId: company.id,
    contact,
    brandName: company.brand_from_name?.trim() || company.name,
    replyTo: company.brand_reply_email ?? null,
    url: portalUrl(company, link.token),
  });
}
