import type { AdminClient } from "@/server/services/front-desk/contracts";

/**
 * Conversation hand-over between the AI and the owner (sms_conversations.state).
 *
 * MINIMAL VERSION written by the owner-channel part so owner commands can call it; the SMS
 * agent part owns the full implementation under these exact names/signatures (the lead
 * reconciles the two). Both are upserts keyed on (company_id, contact_id).
 */

async function organizationOf(admin: AdminClient, companyId: string): Promise<string | null> {
  const { data } = await admin.from("companies").select("organization_id").eq("id", companyId).maybeSingle();
  return (data as { organization_id: string } | null)?.organization_id ?? null;
}

/** A human texted this customer: the AI goes quiet (state 'owner', owner_takeover_at = now). */
export async function markOwnerTakeover(admin: AdminClient, input: { companyId: string; contactId: string }): Promise<void> {
  const organizationId = await organizationOf(admin, input.companyId);
  if (!organizationId) return;
  const { error } = await admin.from("sms_conversations").upsert(
    {
      organization_id: organizationId,
      company_id: input.companyId,
      contact_id: input.contactId,
      state: "owner",
      owner_takeover_at: new Date().toISOString(),
    },
    { onConflict: "company_id,contact_id" },
  );
  if (error) throw error;
}

/** "AI back on for Dana" / "AI off for Dana": state 'ai' or 'paused' for one customer. */
export async function setConversationAi(
  admin: AdminClient,
  input: { companyId: string; contactId: string; on: boolean },
): Promise<void> {
  const organizationId = await organizationOf(admin, input.companyId);
  if (!organizationId) return;
  const { error } = await admin.from("sms_conversations").upsert(
    {
      organization_id: organizationId,
      company_id: input.companyId,
      contact_id: input.contactId,
      state: input.on ? "ai" : "paused",
      ...(input.on ? { owner_takeover_at: null } : {}),
    },
    { onConflict: "company_id,contact_id" },
  );
  if (error) throw error;
}
