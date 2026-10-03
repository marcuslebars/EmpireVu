// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): CrankLeads purchase staging.
// crankleads_purchases is written BEFORE any organization exists (the buyer has no
// account when they submit the crankleads.com form), so there is no RLS identity and no
// tenant to scope by. The table has RLS on with NO policies; only this module (via the
// public checkout endpoint and the billing worker / re-run job) touches it with the
// service-role client. Rows are keyed by the server-generated purchase id and the Stripe
// Checkout Session id — never by anything a later request can choose — and the public
// status endpoint exposes only status, business name and a MASKED email.
// Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import type { Inserts, Json, Tables, Updates } from "@/server/db/database.types";
import type { CrankleadsTier } from "@/server/services/crankleads/config";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

export type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
export type CrankleadsPurchase = Tables<"crankleads_purchases">;

export const PURCHASE_STATUSES = ["checkout_created", "paid", "provisioning", "provisioned", "failed"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

/** Statuses in which the org does not exist YET but will (billing events for it should wait). */
export const PENDING_PURCHASE_STATUSES: readonly string[] = ["checkout_created", "paid", "provisioning"];

/** A `provisioning` claim older than this is presumed crashed and may be re-claimed. */
export const PROVISIONING_STALE_MS = 10 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

export interface NewPurchaseInput {
  tier: CrankleadsTier;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  businessName: string;
  businessType: string;
  founding: boolean;
  utm: Record<string, string>;
}

/** Durable-first: stage the purchase BEFORE the Stripe Checkout Session is created. */
export async function insertPurchase(admin: AdminClient, input: NewPurchaseInput): Promise<CrankleadsPurchase> {
  const utm: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(input.utm)) utm[key] = value;
  const row: Inserts<"crankleads_purchases"> = {
    status: "checkout_created",
    tier: input.tier,
    owner_name: input.ownerName,
    owner_email: input.ownerEmail,
    owner_phone: input.ownerPhone,
    business_name: input.businessName,
    business_type: input.businessType,
    founding: input.founding,
    utm,
  };
  const { data, error } = await admin.from("crankleads_purchases").insert(row).select("*").single();
  if (error || !data) {
    throw new Error(`Could not stage the purchase: ${error?.message ?? "no row returned"}`);
  }
  return data as CrankleadsPurchase;
}

export async function updatePurchase(
  admin: AdminClient,
  purchaseId: string,
  patch: Updates<"crankleads_purchases">,
): Promise<void> {
  const { error } = await admin.from("crankleads_purchases").update(patch).eq("id", purchaseId);
  if (error) throw new Error(`crankleads_purchases update failed: ${error.message}`);
}

async function findOne(
  admin: AdminClient,
  column: "id" | "stripe_checkout_session_id" | "stripe_customer_id",
  value: string,
): Promise<CrankleadsPurchase | null> {
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select("*")
    .eq(column, value)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`crankleads_purchases lookup failed: ${error.message}`);
  return (data as CrankleadsPurchase | null) ?? null;
}

export function findPurchaseById(admin: AdminClient, id: string): Promise<CrankleadsPurchase | null> {
  return findOne(admin, "id", id);
}

export function findPurchaseBySession(admin: AdminClient, sessionId: string): Promise<CrankleadsPurchase | null> {
  return findOne(admin, "stripe_checkout_session_id", sessionId);
}

export function findPurchaseByCustomer(admin: AdminClient, customerId: string): Promise<CrankleadsPurchase | null> {
  return findOne(admin, "stripe_customer_id", customerId);
}

/**
 * Optimistic-concurrency claim: move the purchase to `provisioning` only if it is still in
 * the status we read (and, for a stale `provisioning`, still carries the same start stamp).
 * Two workers / a worker and the re-run job can never both win. Returns the claimed row,
 * or null if the purchase is already provisioned, freshly being provisioned elsewhere, or
 * the race was lost.
 */
export async function claimPurchaseForProvisioning(
  admin: AdminClient,
  purchase: CrankleadsPurchase,
  now: Date = new Date(),
): Promise<CrankleadsPurchase | null> {
  const status = purchase.status;
  if (status === "provisioned" || status === "checkout_created") return null;
  if (status === "provisioning") {
    const started = purchase.provisioning_started_at ? Date.parse(purchase.provisioning_started_at) : 0;
    if (now.getTime() - started < PROVISIONING_STALE_MS) return null;
  }

  let query = admin
    .from("crankleads_purchases")
    .update({
      status: "provisioning",
      provisioning_started_at: now.toISOString(),
      provision_attempts: (purchase.provision_attempts ?? 0) + 1,
    })
    .eq("id", purchase.id)
    .eq("status", status);
  if (status === "provisioning" && purchase.provisioning_started_at) {
    query = query.eq("provisioning_started_at", purchase.provisioning_started_at);
  }
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new Error(`crankleads_purchases claim failed: ${error.message}`);
  return (data as CrankleadsPurchase | null) ?? null;
}

export async function markPurchaseFailed(admin: AdminClient, purchaseId: string, reason: string): Promise<void> {
  await updatePurchase(admin, purchaseId, {
    status: "failed",
    failed_at: nowIso(),
    last_error: reason.slice(0, 2000),
  });
}

/** `jane@example.com` → `j***@example.com`. Never returns more than the first character + domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
