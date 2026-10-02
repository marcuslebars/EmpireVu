import type { Tables } from "@/server/db/database.types";
// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): public website lead forms.
// The hosted lead page (/f/:formKey) and the embed script post to
// /api/public/forms/[formKey] with NO session, so there is no RLS identity. This module
// looks a publishable form key up through the service-role client and:
//   • takes the tenant (org + company) FROM THE KEY ROW ONLY — nothing in the request
//     body or headers can choose an org/company;
//   • exposes, for the public GET, only display-safe company fields (name, logo, public
//     reply phone, brand colour) and catalog LABELS — never prices, owner contacts,
//     Stripe ids, or any lead/contact data;
//   • touches last_used_at (telemetry, best-effort).
// The lead write itself goes through handleLeadIntake (the original sanctioned path).
// Management (create/list/update/revoke) is in ./public-form-keys.ts on the caller's RLS
// client, not here. Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import {
  isPublicFormKeyFormat,
  smsConsentText,
  type PublicFormType,
} from "./public-form-envelope";

export interface ResolvedPublicForm {
  id: string;
  organizationId: string;
  companyId: string;
  formType: PublicFormType;
  allowedOrigins: string[];
  company: {
    name: string;
    slug: string | null;
    logoUrl: string | null;
    phone: string | null;
    primaryColor: string | null;
  };
}

/** The display-safe payload for the public GET. Nothing here is secret or priced. */
export interface PublicFormConfig {
  form: {
    formType: PublicFormType;
    smsConsentText: string;
    /** True when the form only works on listed websites (the list itself is not exposed). */
    restrictedToSites: boolean;
  };
  company: {
    name: string;
    logoUrl: string | null;
    phone: string | null;
    primaryColor: string | null;
  };
  /** Catalog service labels only (no keys, no prices), in catalog order. */
  services: string[];
}

const MAX_SERVICES = 40;

function asFormType(value: string): PublicFormType {
  return value === "contact" ? "contact" : "quote";
}

function httpsOrNull(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return /^https:\/\//i.test(v) ? v : null;
}

function hexColorOrNull(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : null;
}

/**
 * An ACTIVE form key → its pinned tenant + display fields, or null when the key is
 * malformed, unknown, revoked, or its company is gone. Never throws for "not found";
 * DB errors propagate (the caller answers 500 — no write happened).
 */
export async function resolvePublicFormKey(key: string): Promise<ResolvedPublicForm | null> {
  const trimmed = (key ?? "").trim();
  if (!isPublicFormKeyFormat(trimmed)) return null;

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("public_form_keys")
    .select("id, organization_id, company_id, form_type, allowed_origins, active")
    .eq("public_key", trimmed)
    .maybeSingle();
  if (error) throw error;

  const row = data as Pick<
    Tables<"public_form_keys">,
    "id" | "organization_id" | "company_id" | "form_type" | "allowed_origins" | "active"
  > | null;
  if (!row || !row.active) return null;

  const { data: companyData, error: companyError } = await admin
    .from("companies")
    .select("id, name, slug, brand_logo_url, brand_reply_phone, brand_primary_color")
    .eq("organization_id", row.organization_id)
    .eq("id", row.company_id)
    .maybeSingle();
  if (companyError) throw companyError;
  const company = companyData as Pick<
    Tables<"companies">,
    "id" | "name" | "slug" | "brand_logo_url" | "brand_reply_phone" | "brand_primary_color"
  > | null;
  if (!company) return null;

  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    formType: asFormType(row.form_type),
    allowedOrigins: Array.isArray(row.allowed_origins) ? row.allowed_origins : [],
    company: {
      name: company.name,
      slug: company.slug ?? null,
      logoUrl: httpsOrNull(company.brand_logo_url),
      phone: (company.brand_reply_phone ?? "").trim() || null,
      primaryColor: hexColorOrNull(company.brand_primary_color),
    },
  };
}

/** Active catalog service labels for the company. Labels only — prices never leave. */
export async function listPublicServiceLabels(form: ResolvedPublicForm): Promise<string[]> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("service_catalog_items")
    .select("label")
    .eq("organization_id", form.organizationId)
    .eq("company_id", form.companyId)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .limit(MAX_SERVICES);
  if (error) throw error;
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const row of (data ?? []) as Array<{ label: string | null }>) {
    const label = (row.label ?? "").trim();
    if (label && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      labels.push(label.slice(0, 120));
    }
  }
  return labels;
}

/** Build the display-safe public config (explicit field picks — no row spreading). */
export function toPublicFormConfig(form: ResolvedPublicForm, services: string[]): PublicFormConfig {
  return {
    form: {
      formType: form.formType,
      smsConsentText: smsConsentText(form.company.name),
      restrictedToSites: form.allowedOrigins.length > 0,
    },
    company: {
      name: form.company.name,
      logoUrl: form.company.logoUrl,
      phone: form.company.phone,
      primaryColor: form.company.primaryColor,
    },
    services,
  };
}

/** last_used_at telemetry. Best-effort: never fails a submission. */
export async function touchPublicFormKey(id: string): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    await admin.from("public_form_keys").update({ last_used_at: new Date().toISOString() }).eq("id", id);
  } catch (err) {
    console.warn("[public-forms] last_used_at update failed (ignored):", err instanceof Error ? err.message : err);
  }
}
