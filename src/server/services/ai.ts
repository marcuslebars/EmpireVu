import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import type { TenantServiceContext } from "@/server/services/shared";
import { analyzeLead, isAIConfigured, type LeadAnalysis } from "@/server/ai/claude";

export async function analyzeContact(
  context: TenantServiceContext,
  contactId: string,
): Promise<LeadAnalysis> {
  if (!isAIConfigured()) {
    throw new ValidationError(
      "AI is not configured. Set ANTHROPIC_API_KEY on the server to enable AI features.",
    );
  }

  const { data, error } = await context.supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const contact = data as Tables<"contacts"> | null;
  if (!contact) {
    throw new ValidationError("Contact not found.");
  }

  let companyName: string | null = null;
  if (contact.company_id) {
    const { data: companyData } = await context.supabase
      .from("companies")
      .select("name")
      .eq("organization_id", context.organizationId)
      .eq("id", contact.company_id)
      .maybeSingle();
    companyName = (companyData as { name: string } | null)?.name ?? null;
  }

  const metadata =
    contact.metadata && typeof contact.metadata === "object" && !Array.isArray(contact.metadata)
      ? (contact.metadata as Record<string, unknown>)
      : {};

  return analyzeLead({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email,
    phone: contact.phone,
    stage: contact.stage,
    notes: contact.notes,
    companyName,
    createdAt: contact.created_at,
    metadata,
  });
}
