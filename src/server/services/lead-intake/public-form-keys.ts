import { randomBytes } from "node:crypto";

import type { Inserts, Tables, Updates } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { assertCompanyInOrganization, insertRow, type TenantServiceContext } from "@/server/services/shared";

import { normalizeOrigin, PUBLIC_FORM_KEY_PREFIX, type PublicFormType } from "./public-form-envelope";

/**
 * Management of publishable website-form keys (Settings → Website forms, onboarding
 * "Website leads"). Runs on the CALLER'S RLS client: members read, admins manage (see
 * migration 20261002120000_public_lead_forms.sql). No service role here.
 *
 * Unlike intake keys (secrets, hashed, shown once), a form key is PUBLISHABLE — it lives
 * in the customer's website HTML — so it is stored as-is and can be re-shown any time.
 */

const KEY_BYTES = 24;
const MAX_ORIGINS = 50;

export function generatePublicFormKey(): string {
  return `${PUBLIC_FORM_KEY_PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;
}

export interface PublicFormKeyView {
  id: string;
  companyId: string;
  publicKey: string;
  label: string | null;
  formType: PublicFormType;
  active: boolean;
  allowedOrigins: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

function toView(row: Tables<"public_form_keys">): PublicFormKeyView {
  return {
    id: row.id,
    companyId: row.company_id,
    publicKey: row.public_key,
    label: row.label,
    formType: row.form_type === "contact" ? "contact" : "quote",
    active: row.active,
    allowedOrigins: row.allowed_origins ?? [],
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/** Normalize + dedupe a list of origins; throws a ValidationError naming a bad entry. */
export function normalizeAllowedOrigins(input: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    if (!raw || !raw.trim()) continue;
    const origin = normalizeOrigin(raw);
    if (!origin) {
      throw new ValidationError(`"${raw.trim().slice(0, 80)}" is not a website address (e.g. https://yourbusiness.com).`);
    }
    if (!out.includes(origin)) out.push(origin);
  }
  if (out.length > MAX_ORIGINS) {
    throw new ValidationError(`At most ${MAX_ORIGINS} websites can be listed.`);
  }
  return out;
}

export async function listPublicFormKeys(
  context: TenantServiceContext,
  options: { companyId?: string | null } = {},
): Promise<PublicFormKeyView[]> {
  let query = context.supabase
    .from("public_form_keys")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });
  if (options.companyId) query = query.eq("company_id", options.companyId);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Tables<"public_form_keys">[]).map(toView);
}

export interface CreatePublicFormKeyInput {
  companyId: string;
  label?: string | null;
  formType?: PublicFormType;
  allowedOrigins?: string[] | null;
}

export async function createPublicFormKey(
  context: TenantServiceContext,
  input: CreatePublicFormKeyInput,
): Promise<PublicFormKeyView> {
  await assertCompanyInOrganization(context, input.companyId);
  const row: Inserts<"public_form_keys"> = {
    organization_id: context.organizationId,
    company_id: input.companyId,
    public_key: generatePublicFormKey(),
    label: input.label?.trim() || null,
    form_type: input.formType ?? "quote",
    allowed_origins: normalizeAllowedOrigins(input.allowedOrigins),
    created_by: context.actorProfileId,
    active: true,
  };
  const inserted = await insertRow(context, "public_form_keys", row);
  return toView(inserted);
}

export interface UpdatePublicFormKeyInput {
  label?: string | null;
  formType?: PublicFormType;
  allowedOrigins?: string[] | null;
}

export async function updatePublicFormKey(
  context: TenantServiceContext,
  id: string,
  input: UpdatePublicFormKeyInput,
): Promise<PublicFormKeyView> {
  const patch: Updates<"public_form_keys"> = {};
  if (input.label !== undefined) patch.label = input.label?.trim() || null;
  if (input.formType !== undefined) patch.form_type = input.formType;
  if (input.allowedOrigins !== undefined) patch.allowed_origins = normalizeAllowedOrigins(input.allowedOrigins);

  const { data, error } = await context.supabase
    .from("public_form_keys")
    .update(patch)
    .eq("organization_id", context.organizationId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError("Form not found.");
  return toView(data as Tables<"public_form_keys">);
}

/** Revoke = deactivate. The hosted link + every embed stop accepting leads at once. */
export async function revokePublicFormKey(context: TenantServiceContext, id: string): Promise<void> {
  const { error } = await context.supabase
    .from("public_form_keys")
    .update({ active: false })
    .eq("organization_id", context.organizationId)
    .eq("id", id);
  if (error) throw error;
}
