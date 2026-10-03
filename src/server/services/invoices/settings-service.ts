/**
 * Read / write a brand's invoice settings under the caller's RLS client.
 * The route layer restricts writes to owners and admins.
 */
import { toJson } from "@/server/db/json";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { loadCompanyForInvoice } from "./common";
import { InvoiceValidationError } from "./errors";
import { invoiceSettingsSchema, parseInvoiceSettings, type InvoiceSettings, type InvoiceSettingsInput } from "./settings";

export interface CompanyInvoiceSettings {
  companyId: string;
  companyName: string;
  taxRegistrationNumber: string | null;
  businessAddress: string | null;
  settings: InvoiceSettings;
  /** Online payments need the brand's Stripe account connected and able to charge. */
  stripeReady: boolean;
}

export async function getCompanyInvoiceSettings(ctx: TenantServiceContext, companyId: string): Promise<CompanyInvoiceSettings> {
  await assertCompanyInOrganization(ctx, companyId);
  const company = await loadCompanyForInvoice(ctx.supabase, ctx.organizationId, companyId);
  if (!company) throw new InvoiceValidationError("Company not found.");
  return {
    companyId,
    companyName: company.name,
    taxRegistrationNumber: company.tax_registration_number,
    businessAddress: company.business_address,
    settings: parseInvoiceSettings(company.invoice_settings),
    stripeReady: Boolean(company.stripe_connected_account_id && company.stripe_charges_enabled),
  };
}

export interface UpdateCompanyInvoiceSettingsInput {
  taxRegistrationNumber?: string | null;
  businessAddress?: string | null;
  settings?: InvoiceSettingsInput;
}

export async function updateCompanyInvoiceSettings(
  ctx: TenantServiceContext,
  companyId: string,
  input: UpdateCompanyInvoiceSettingsInput,
): Promise<CompanyInvoiceSettings> {
  await assertCompanyInOrganization(ctx, companyId);
  const company = await loadCompanyForInvoice(ctx.supabase, ctx.organizationId, companyId);
  if (!company) throw new InvoiceValidationError("Company not found.");

  let nextSettings: Record<string, unknown> | undefined;
  if (input.settings) {
    // Validate only the keys the caller sent: the schema turns a missing text field
    // into null, which must not wipe a saved value on a partial update.
    const shape = invoiceSettingsSchema.shape;
    const sent = Object.keys(input.settings).filter((k): k is keyof typeof shape => k in shape);
    const parsed = invoiceSettingsSchema.pick(Object.fromEntries(sent.map((k) => [k, true])) as never).parse(input.settings) as Record<string, unknown>;
    const current =
      company.invoice_settings && typeof company.invoice_settings === "object" && !Array.isArray(company.invoice_settings)
        ? (company.invoice_settings as Record<string, unknown>)
        : {};
    nextSettings = { ...current };
    for (const [k, v] of Object.entries(parsed)) {
      if (v === undefined) continue;
      nextSettings[k] = v;
    }
    const s = parseInvoiceSettings(nextSettings);
    if (nextSettings.acceptEtransfer === true && !s.etransferEmail) {
      throw new InvoiceValidationError("Add the email address customers should send e-Transfers to.");
    }
  }

  const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
  const { error } = await ctx.supabase
    .from("companies")
    .update({
      ...(input.taxRegistrationNumber !== undefined ? { tax_registration_number: clean(input.taxRegistrationNumber) } : {}),
      ...(input.businessAddress !== undefined ? { business_address: clean(input.businessAddress) } : {}),
      ...(nextSettings ? { invoice_settings: toJson(nextSettings) } : {}),
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId);
  if (error) throw error;
  return getCompanyInvoiceSettings(ctx, companyId);
}
