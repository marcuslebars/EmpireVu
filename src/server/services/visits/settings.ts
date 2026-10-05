/**
 * Confirm & reschedule — staff side, under the caller's session (RLS; every query also
 * filters organization_id). Settings per brand, the visit link for a job, and adding the
 * link to the brand's existing reminder automations.
 */
import { z } from "zod";

import { toJson } from "@/server/db/json";
import { ValidationError } from "@/server/organizations/context";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { parseVisitSettings, visitSettingsSchema, type VisitSettings } from "./rules";

export const LINK_TOKEN = "{{booking.manage_url}}";
const OLD_LINE = /\s*Reply if you need to change it\.?/;
const LINK_SENTENCE = `Confirm or change it here: ${LINK_TOKEN}`;

interface ReminderAction {
  type?: string;
  body?: string;
  [k: string]: unknown;
}

export interface ReminderFlow {
  id: string;
  name: string;
  status: string;
  hasLink: boolean;
}

export interface VisitSettingsView {
  companyId: string;
  settings: VisitSettings;
  linkBase: string;
  reminders: ReminderFlow[];
}

function actionsOf(definition: unknown): ReminderAction[] {
  const d = definition && typeof definition === "object" ? (definition as { actions?: unknown }) : {};
  return Array.isArray(d.actions) ? (d.actions as ReminderAction[]) : [];
}

const isSend = (a: ReminderAction) => (a.type === "send_sms" || a.type === "send_email") && typeof a.body === "string";

/** The first customer text/email of a reminder, with the visit link added (pure). */
export function withVisitLink(definition: unknown): { definition: unknown; changed: boolean } {
  const actions = actionsOf(definition);
  if (actions.some((a) => isSend(a) && a.body!.includes("booking.manage_url"))) return { definition, changed: false };
  const i = actions.findIndex((a) => isSend(a) && (a.to === undefined || a.to === "contact"));
  if (i < 0) return { definition, changed: false };
  const body = actions[i].body!;
  const next = OLD_LINE.test(body) ? body.replace(OLD_LINE, ` ${LINK_SENTENCE}`) : `${body.trimEnd()} ${LINK_SENTENCE}`;
  const copy = actions.map((a, k) => (k === i ? { ...a, body: next } : a));
  return { definition: { ...(definition as Record<string, unknown>), actions: copy }, changed: true };
}

async function loadCompany(ctx: TenantServiceContext, companyId: string) {
  await assertCompanyInOrganization(ctx, companyId);
  const { data, error } = await ctx.supabase
    .from("companies")
    .select("id, visit_settings, quote_public_base_url")
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError("Company not found.");
  return data;
}

async function reminderFlows(ctx: TenantServiceContext, companyId: string) {
  const { data, error } = await ctx.supabase
    .from("workflows")
    .select("id, name, status, company_id, definition")
    .eq("organization_id", ctx.organizationId)
    .eq("trigger_event", "booking.upcoming")
    .neq("status", "archived");
  if (error) throw error;
  return (data ?? []).filter((w: { company_id: string | null }) => !w.company_id || w.company_id === companyId) as Array<{
    id: string;
    name: string;
    status: string;
    definition: unknown;
  }>;
}

export async function getVisitSettings(ctx: TenantServiceContext, companyId: string): Promise<VisitSettingsView> {
  const company = await loadCompany(ctx, companyId);
  const flows = await reminderFlows(ctx, companyId);
  return {
    companyId,
    settings: parseVisitSettings(company.visit_settings),
    linkBase: `${quotePublicBaseUrlFor(company)}/v/`,
    reminders: flows.map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
      hasLink: actionsOf(f.definition).some((a) => isSend(a) && a.body!.includes("booking.manage_url")),
    })),
  };
}

export const updateVisitSettingsSchema = visitSettingsSchema.partial();

export async function updateVisitSettings(ctx: TenantServiceContext, companyId: string, input: z.infer<typeof updateVisitSettingsSchema>): Promise<VisitSettingsView> {
  const company = await loadCompany(ctx, companyId);
  const current = company.visit_settings && typeof company.visit_settings === "object" && !Array.isArray(company.visit_settings) ? (company.visit_settings as Record<string, unknown>) : {};
  const { error } = await ctx.supabase
    .from("companies")
    .update({ visit_settings: toJson({ ...current, ...input }) })
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId);
  if (error) throw error;
  return getVisitSettings(ctx, companyId);
}

/** Add {{booking.manage_url}} to the first customer message of each reminder automation. */
export async function addLinkToReminders(ctx: TenantServiceContext, companyId: string): Promise<VisitSettingsView> {
  await loadCompany(ctx, companyId);
  for (const flow of await reminderFlows(ctx, companyId)) {
    const { definition, changed } = withVisitLink(flow.definition);
    if (!changed) continue;
    const { error } = await ctx.supabase
      .from("workflows")
      .update({ definition: toJson(definition) })
      .eq("organization_id", ctx.organizationId)
      .eq("id", flow.id);
    if (error) throw error;
  }
  return getVisitSettings(ctx, companyId);
}

export interface VisitLink {
  url: string | null;
  customerConfirmedAt: string | null;
}

/** The customer's link for one job (staff can copy or text it). */
export async function getVisitLink(ctx: TenantServiceContext, bookingId: string): Promise<VisitLink> {
  const { data: booking, error } = await ctx.supabase
    .from("bookings")
    .select("id, company_id, manage_token, customer_confirmed_at")
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking) throw new ValidationError("Job not found.");
  const { data: company } = await ctx.supabase
    .from("companies")
    .select("quote_public_base_url")
    .eq("organization_id", ctx.organizationId)
    .eq("id", booking.company_id)
    .maybeSingle();
  return {
    url: booking.manage_token ? `${quotePublicBaseUrlFor(company)}/v/${booking.manage_token}` : null,
    customerConfirmedAt: booking.customer_confirmed_at,
  };
}
