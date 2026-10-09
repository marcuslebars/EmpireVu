// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): CrankLeads purchase provisioning.
// Runs in the billing worker (on a verified, durably recorded Stripe
// checkout.session.completed) and in the operator re-run job — neither has a user session,
// and the owner account does not exist yet. The tenant is never taken from a request: the
// org is created here from the crankleads_purchases row that the paid Checkout Session
// points at (metadata.purchaseId / client_reference_id / session id), and every tenant write
// after that runs through the normal tenant services (createOrganization, createCompany,
// applyIndustryPack, createPublicFormKey, upsertOnboardingStep) with a context pinned to
// THAT org id. Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import type { Inserts, Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { sendEmail as defaultSendEmail, type SendEmailInput, type SendEmailResult } from "@/server/outbound/email";
import { DeferBillingEventError } from "@/server/services/billing/defer";
import { getAppBaseUrl } from "@/server/services/billing/env";
import { createCompany, listCompanies, updateCompany } from "@/server/services/companies";
import { setOwnerPhoneVerified } from "@/server/services/owner-channel/owner-phone";
import {
  CRANKLEADS_SOURCE,
  CRANKLEADS_TIER_PLAN,
  isCrankleadsTier,
  packIdForBusinessType,
  packRecipesForTier,
  type CrankleadsTier,
} from "@/server/services/crankleads/config";
import {
  renderOperatorFailureEmail,
  renderOperatorNewPurchaseEmail,
  renderWelcomeEmail,
  type RenderedEmail,
} from "@/server/services/crankleads/emails";
import {
  claimPurchaseForProvisioning,
  findPurchaseById,
  findPurchaseBySession,
  markPurchaseFailed,
  maskEmail,
  PENDING_PURCHASE_STATUSES,
  updatePurchase,
  findPurchaseByCustomer,
  type AdminClient,
  type CrankleadsPurchase,
} from "@/server/services/crankleads/purchases";
import { provisionDoneForYouNumber } from "@/server/services/dfy/orchestrator";
import { createPublicFormKey, listPublicFormKeys } from "@/server/services/lead-intake/public-form-keys";
import { upsertOnboardingStep } from "@/server/services/onboarding";
import { createOrganization } from "@/server/services/organizations";
import { getPack } from "@/server/services/packs";
import { applyIndustryPack, listIndustryPacks } from "@/server/services/packs/apply";
import { toE164 } from "@/server/services/retell/payload";
import type { TenantServiceContext } from "@/server/services/shared";
import { createAndSendSetupIntake, ensureSetupIntake } from "@/server/services/dfy/intake";
import { restrictAutomationsToTier } from "@/server/services/crankleads/tier-automations";
import { appBaseUrlFor } from "@/server/services/platform-brand";

/** The timezone every CrankLeads company starts in (Ontario). Editable in Settings. */
export const CRANKLEADS_DEFAULT_TIMEZONE = "America/Toronto";

export interface ProvisionDeps {
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
}

const defaultDeps: ProvisionDeps = { sendEmail: defaultSendEmail };

// Stripe event objects are read defensively (same approach as billing/events.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeObject = Record<string, any>;

/**
 * The buyer's app origin — appBaseUrlFor("crankleads"): CRANKLEADS_APP_BASE_URL once set, else
 * APP_BASE_URL. Every link a buyer gets (set-password, sign-in, form) uses it.
 */
function appUrl(): string {
  return appBaseUrlFor("crankleads");
}

/** Operator-only links (/internal/ops) stay on the house app origin. */
function operatorAppUrl(): string {
  return getAppBaseUrl().replace(/\/+$/, "");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

// ── Stripe object helpers ─────────────────────────────────────────────────────

/** Is this Checkout Session (or subscription/invoice) a CrankLeads purchase? */
export function isCrankleadsObject(object: StripeObject | null | undefined): boolean {
  return crankleadsMetadataOf(object)?.source === CRANKLEADS_SOURCE;
}

/** The CrankLeads metadata on a session, subscription, or invoice (via its subscription details). */
function crankleadsMetadataOf(object: StripeObject | null | undefined): Record<string, unknown> | null {
  if (!object) return null;
  const candidates = [
    object.metadata,
    object.parent?.subscription_details?.metadata,
    object.subscription_details?.metadata,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && candidate.source === CRANKLEADS_SOURCE) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

// ── Purchase resolution from a paid Checkout Session ─────────────────────────

/**
 * Find the staged purchase for a Checkout Session — by session id, then by the purchase id
 * we stamped on the session — and, if it is somehow missing, rebuild it from the session's
 * own metadata so a paid purchase is never lost.
 */
async function resolvePurchaseForSession(admin: AdminClient, session: StripeObject): Promise<CrankleadsPurchase> {
  const sessionId = idOf(session.id);
  if (sessionId) {
    const bySession = await findPurchaseBySession(admin, sessionId);
    if (bySession) return bySession;
  }
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const purchaseId =
    (typeof metadata.purchaseId === "string" && metadata.purchaseId) ||
    (typeof session.client_reference_id === "string" && session.client_reference_id) ||
    null;
  if (purchaseId) {
    const byId = await findPurchaseById(admin, purchaseId);
    if (byId) return byId;
  }

  const tier = metadata.tier;
  const email = session.customer_details?.email ?? session.customer_email;
  if (!isCrankleadsTier(tier) || typeof email !== "string" || !email) {
    throw new Error(`CrankLeads session ${sessionId ?? "(no id)"} has no staged purchase and not enough metadata to rebuild it.`);
  }
  console.error(`[crankleads/provision] purchase row missing for session ${sessionId}; rebuilding it from Stripe metadata`);
  const row: Inserts<"crankleads_purchases"> = {
    status: "checkout_created",
    tier,
    stripe_checkout_session_id: sessionId,
    owner_name: String(metadata.ownerName ?? session.customer_details?.name ?? email).slice(0, 200),
    owner_email: email.toLowerCase(),
    owner_phone: String(metadata.ownerPhone ?? session.customer_details?.phone ?? "").slice(0, 40),
    business_name: String(metadata.businessName ?? session.customer_details?.name ?? email).slice(0, 200),
    business_type: String(metadata.businessType ?? "Other").slice(0, 100),
  };
  const { data, error } = await admin.from("crankleads_purchases").insert(row).select("*").single();
  if (error || !data) throw new Error(`Could not rebuild purchase for ${sessionId}: ${error?.message ?? "no row"}`);
  return data as CrankleadsPurchase;
}

/** Record that Stripe says the session is paid (idempotent; fills ids on later statuses too). */
async function markPaid(admin: AdminClient, purchase: CrankleadsPurchase, session: StripeObject): Promise<CrankleadsPurchase> {
  const customerId = idOf(session.customer);
  const subscriptionId = idOf(session.subscription);
  const sessionId = idOf(session.id);
  const patch: Partial<CrankleadsPurchase> = {};
  if (purchase.status === "checkout_created") {
    patch.status = "paid";
    patch.paid_at = new Date().toISOString();
  }
  if (customerId && !purchase.stripe_customer_id) patch.stripe_customer_id = customerId;
  if (subscriptionId && !purchase.stripe_subscription_id) patch.stripe_subscription_id = subscriptionId;
  if (sessionId && !purchase.stripe_checkout_session_id) patch.stripe_checkout_session_id = sessionId;
  if (Object.keys(patch).length === 0) return purchase;
  await updatePurchase(admin, purchase.id, patch);
  return { ...purchase, ...patch };
}

// ── Owner user ────────────────────────────────────────────────────────────────

interface OwnerUser {
  id: string;
  existing: boolean;
}

async function findProfileIdByEmail(admin: AdminClient, email: string): Promise<string | null> {
  // profiles.email is citext (case-insensitive), kept in sync with auth.users by trigger.
  const { data, error } = await admin.from("profiles").select("id").eq("email", email).limit(1).maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

export interface AuthUserSummary {
  id: string;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
}

async function findAuthUserByEmail(admin: AdminClient, email: string): Promise<AuthUserSummary | null> {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`auth user lookup failed: ${error.message}`);
    const users: Array<AuthUserSummary & { email?: string | null }> = data.users;
    const match = users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match;
    if (users.length < 200) break;
  }
  return null;
}

/** The auth user's confirmation / last sign-in stamps (also used by the setup follow-ups). */
export async function getAuthUser(admin: AdminClient, id: string): Promise<AuthUserSummary | null> {
  const { data, error } = await admin.auth.admin.getUserById(id);
  if (error) throw new Error(`auth user ${id} lookup failed: ${error.message}`);
  const user = data?.user;
  return user ? { id: user.id, email_confirmed_at: user.email_confirmed_at ?? null, last_sign_in_at: user.last_sign_in_at ?? null } : null;
}

/**
 * Someone registered this email but never confirmed it (a squatted signup). The PAYER gets
 * the login: scramble the password, mark the email confirmed, and ban → unban to revoke the
 * account's existing sessions (GoTrue logs a user out when it is banned); the payer then sets
 * their own password from the welcome email.
 */
async function reclaimUnconfirmedUser(admin: AdminClient, id: string): Promise<void> {
  const { error } = await admin.auth.admin.updateUserById(id, {
    password: randomBytes(32).toString("hex"),
    email_confirm: true,
    ban_duration: "876000h",
  });
  if (error) throw new Error(`could not reclaim unconfirmed user ${id}: ${error.message}`);
  const { error: unbanError } = await admin.auth.admin.updateUserById(id, { ban_duration: "none" });
  if (unbanError) throw new Error(`could not unban reclaimed user ${id}: ${unbanError.message}`);
  console.warn(`[crankleads/provision] reclaimed UNCONFIRMED auth user ${id} for the paying buyer (sessions revoked)`);
}

/** Existing + confirmed → attach (existing). Existing + unconfirmed → reclaim (treated as new). */
async function resolveExistingUser(admin: AdminClient, user: AuthUserSummary): Promise<OwnerUser> {
  if (user.email_confirmed_at) return { id: user.id, existing: true };
  await reclaimUnconfirmedUser(admin, user.id);
  return { id: user.id, existing: false };
}

/** Create the owner's login, or reuse the existing EmpireVu user with this email. */
export async function ensureOwnerUser(admin: AdminClient, email: string, fullName: string): Promise<OwnerUser> {
  const normalized = email.trim().toLowerCase();
  const existingProfile = await findProfileIdByEmail(admin, normalized);
  if (existingProfile) {
    const authUser = await getAuthUser(admin, existingProfile);
    if (!authUser) throw new Error(`profile ${existingProfile} has no auth user`);
    return resolveExistingUser(admin, authUser);
  }

  const created = await admin.auth.admin.createUser({
    email: normalized,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  let user: OwnerUser | null = created.data?.user ? { id: created.data.user.id, existing: false } : null;
  if (!user) {
    // Already registered in auth (without a profile row yet).
    const authUser = await findAuthUserByEmail(admin, normalized);
    if (!authUser) throw new Error(`Could not create a login for ${normalized}: ${created.error?.message ?? "unknown error"}`);
    user = await resolveExistingUser(admin, authUser);
  }

  // The on_auth_user_created trigger makes the profile; guarantee the FK target regardless.
  const { error: profileError } = await admin
    .from("profiles")
    .upsert({ id: user.id, email: normalized, full_name: fullName }, { onConflict: "id", ignoreDuplicates: true });
  if (profileError) throw new Error(`profile upsert failed: ${profileError.message}`);
  return user;
}

/**
 * Where the set-password page sends the owner next. `/onboarding` alone redirects an account
 * that already has an org to the dashboard, so the wizard is opened explicitly (`step=resume`
 * → the first unfinished step).
 */
export const DEFAULT_SET_PASSWORD_NEXT = "/onboarding?step=resume";

/**
 * A one-time set-password link for a brand-new user (Supabase recovery link → /update-password),
 * landing on `next` (a same-origin path, e.g. a setup follow-up's wizard step) afterwards.
 */
export async function createSetPasswordUrl(admin: AdminClient, email: string, next: string = DEFAULT_SET_PASSWORD_NEXT): Promise<string> {
  const base = appUrl();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${base}/update-password` },
  });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) {
    throw new Error(`Could not create a set-password link: ${error?.message ?? "no token returned"}`);
  }
  // token_hash flow (not the action_link): the SPA's Supabase client uses PKCE, so the page
  // verifies the hash itself with verifyOtp({ type: "recovery" }) — see UpdatePasswordPage.
  const params = new URLSearchParams({ token_hash: hashed, type: "recovery", next });
  return `${base}/update-password?${params.toString()}`;
}

// ── Organization ──────────────────────────────────────────────────────────────

async function uniqueOrgSlug(admin: AdminClient, name: string): Promise<string> {
  const base = slugify(name).slice(0, 70) || "business";
  const candidates = [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
  for (const candidate of candidates) {
    const { data, error } = await admin.from("organizations").select("id").eq("slug", candidate).maybeSingle();
    if (error) throw new Error(`slug check failed: ${error.message}`);
    if (!data) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadOrganization(admin: AdminClient, column: "id" | "stripe_customer_id", value: string): Promise<Tables<"organizations"> | null> {
  const { data, error } = await admin.from("organizations").select("*").eq(column, value).maybeSingle();
  if (error) throw new Error(`organization lookup failed: ${error.message}`);
  return (data as Tables<"organizations"> | null) ?? null;
}

async function ensureOwnerMembership(admin: AdminClient, organizationId: string, profileId: string): Promise<void> {
  const { data, error } = await admin
    .from("organization_memberships")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId)
    .maybeSingle();
  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  if (data) return;
  const { error: insertError } = await admin
    .from("organization_memberships")
    .insert({ organization_id: organizationId, profile_id: profileId, role: "owner" });
  if (insertError) throw new Error(`owner membership insert failed: ${insertError.message}`);
}

async function ensureOrganization(
  admin: AdminClient,
  purchase: CrankleadsPurchase,
  tier: CrankleadsTier,
  ownerId: string,
  existingUser: boolean,
): Promise<Tables<"organizations">> {
  if (purchase.organization_id) {
    const org = await loadOrganization(admin, "id", purchase.organization_id);
    if (org) return org;
  }
  const customerId = purchase.stripe_customer_id;
  if (!customerId) throw new Error("Paid purchase has no Stripe customer id yet.");
  // organizations.stripe_customer_id is UNIQUE — one org per purchase, even across a crash
  // between creating the org and recording it on the purchase.
  const existing = await loadOrganization(admin, "stripe_customer_id", customerId);
  if (existing) return existing;

  const slug = await uniqueOrgSlug(admin, purchase.business_name);
  return createOrganization(admin, ownerId, ownerId, { name: purchase.business_name, slug }, {
    plan: CRANKLEADS_TIER_PLAN[tier],
    subscriptionStatus: "active",
    stripeCustomerId: customerId,
    billingEmail: purchase.owner_email,
    crankleadsTier: tier,
    // A CrankLeads buyer sees CrankLeads everywhere, never EmpireVu (docs/crankleads-branding.md).
    platformBrand: "crankleads",
    // Never move an existing user's default org out from under them.
    setAsDefaultOrganization: !existingUser,
  });
}

async function upsertSubscriptionMirror(admin: AdminClient, organizationId: string, purchase: CrankleadsPurchase, tier: CrankleadsTier): Promise<void> {
  if (!purchase.stripe_subscription_id) return;
  const row: Inserts<"subscriptions"> = {
    organization_id: organizationId,
    plan: CRANKLEADS_TIER_PLAN[tier],
    status: "active",
    stripe_subscription_id: purchase.stripe_subscription_id,
  };
  const { error } = await admin.from("subscriptions").upsert(row, { onConflict: "stripe_subscription_id" });
  if (error) throw new Error(`subscription mirror upsert failed: ${error.message}`);
}

// ── Company, pack, form, onboarding ───────────────────────────────────────────

async function ensureCompany(ctx: TenantServiceContext, purchase: CrankleadsPurchase): Promise<string> {
  let companyId = purchase.company_id;
  if (!companyId) {
    const [first] = await listCompanies(ctx, { limit: 1 });
    companyId = first?.id ?? null;
  }
  if (!companyId) {
    // Same service the onboarding wizard's Business step uses — installs the recipe catalog.
    const company = await createCompany(ctx, { name: purchase.business_name });
    companyId = company.id;
  }
  await updateCompany(ctx, companyId, {
    ownerEmail: purchase.owner_email,
    timezone: CRANKLEADS_DEFAULT_TIMEZONE,
  });
  // The paying buyer's own number from checkout: the verified owner phone (owner-phone.ts).
  const ownerPhone = toE164(purchase.owner_phone);
  if (ownerPhone) await setOwnerPhoneVerified(ctx.supabase as unknown as Parameters<typeof setOwnerPhoneVerified>[0], { organizationId: ctx.organizationId, companyId, phone: ownerPhone });
  return companyId;
}

async function ensureFormUrl(ctx: TenantServiceContext, companyId: string): Promise<string> {
  const forms = await listPublicFormKeys(ctx, { companyId });
  const form = forms.find((f) => f.active) ?? (await createPublicFormKey(ctx, { companyId, label: "Website form" }));
  return `${appUrl()}/f/${form.publicKey}`;
}

interface WelcomeFacts {
  formUrl: string | null;
  packName: string | null;
  servicesNeedingPrices: number;
}

async function welcomeFacts(ctx: TenantServiceContext, purchase: CrankleadsPurchase, companyId: string): Promise<WelcomeFacts> {
  const packId = packIdForBusinessType(purchase.business_type);
  const pack = packId ? getPack(packId) : null;
  const forms = await listPublicFormKeys(ctx, { companyId });
  const form = forms.find((f) => f.active) ?? null;
  let servicesNeedingPrices = 0;
  try {
    servicesNeedingPrices = (await listIndustryPacks(ctx, companyId)).needsPrices.length;
  } catch {
    servicesNeedingPrices = 0;
  }
  return {
    formUrl: form ? `${appUrl()}/f/${form.publicKey}` : null,
    packName: pack?.name ?? null,
    servicesNeedingPrices,
  };
}

async function sendRendered(deps: ProvisionDeps, to: string, email: RenderedEmail): Promise<string | null> {
  const result = await deps.sendEmail({ to, subject: email.subject, body: email.body, html: email.html, fromName: email.fromName });
  return result?.id ?? null;
}

/** Render + send the buyer's welcome email (fresh set-password link for a new user). */
async function sendWelcome(
  admin: AdminClient,
  ctx: TenantServiceContext,
  purchase: CrankleadsPurchase,
  tier: CrankleadsTier,
  companyId: string,
  existingUser: boolean,
  deps: ProvisionDeps,
): Promise<void> {
  const facts = await welcomeFacts(ctx, purchase, companyId);
  const setPasswordUrl = existingUser ? null : await createSetPasswordUrl(admin, purchase.owner_email);
  // The 60-second quick-setup link (same link the text carries) — docs/done-for-you.md.
  const setupUrl = await ensureSetupIntake(admin, { organizationId: ctx.organizationId, companyId })
    .then((r) => r.url)
    .catch(() => null);
  const email = renderWelcomeEmail({
    ownerName: purchase.owner_name,
    businessName: purchase.business_name,
    tier,
    setPasswordUrl,
    setupUrl,
    appUrl: appUrl(),
    ...facts,
  });
  const messageId = await sendRendered(deps, purchase.owner_email, email);
  // Resend accepted it. If the buyer says it never arrived, look this id up in Resend → Emails
  // (delivered / bounced / suppressed) — the address itself is masked here.
  console.log(
    `[crankleads/provision] welcome email accepted for purchase ${purchase.id} → ${maskEmail(purchase.owner_email)} ` +
      `(resend id ${messageId ?? "unknown"}, ${setPasswordUrl ? "set-password link" : "existing user: log-in link"})`,
  );
}

function operatorEmailAddress(): string | null {
  return process.env.OWNER_EMAIL?.trim() || null;
}

// ── Billing events that arrived before the org existed ───────────────────────

/**
 * After the org exists, give every billing event for this customer that was deferred (or
 * dead-lettered) while provisioning ran another go, now — so invoice.paid /
 * customer.subscription.* resolve to the new org. Best-effort.
 */
export async function requeueDeferredBillingEvents(admin: AdminClient, customerId: string): Promise<number> {
  const { data, error } = await admin
    .from("billing_events")
    .select("id")
    .is("processed_at", null)
    .eq("payload->data->object->>customer", customerId);
  if (error) throw new Error(`billing_events lookup failed: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) return 0;

  const now = new Date().toISOString();
  const { error: failedError } = await admin
    .from("billing_event_jobs")
    .update({ status: "pending", attempt_count: 0, available_at: now, completed_at: null, last_error: null, locked_at: null, locked_by: null })
    .in("billing_event_id", ids)
    .eq("status", "failed");
  if (failedError) throw new Error(`requeue (failed) failed: ${failedError.message}`);
  const { error: pendingError } = await admin
    .from("billing_event_jobs")
    .update({ available_at: now })
    .in("billing_event_id", ids)
    .eq("status", "pending");
  if (pendingError) throw new Error(`requeue (pending) failed: ${pendingError.message}`);
  return ids.length;
}

/**
 * Is there a CrankLeads purchase that WILL own this event's customer once provisioning
 * finishes? Used by the billing processor to retry (not dead-letter) an event for an
 * unknown customer. A `failed` purchase is not pending: those dead-letter, and the re-run
 * job re-queues them after it succeeds.
 */
export async function crankleadsPurchasePendingFor(admin: AdminClient, object: StripeObject): Promise<boolean> {
  const metadata = crankleadsMetadataOf(object);
  const purchaseId = typeof metadata?.purchaseId === "string" ? metadata.purchaseId : null;
  if (purchaseId) {
    const purchase = await findPurchaseById(admin, purchaseId);
    if (purchase) return PENDING_PURCHASE_STATUSES.includes(purchase.status);
  }
  const customerId = idOf(object.customer);
  if (customerId) {
    const purchase = await findPurchaseByCustomer(admin, customerId);
    if (purchase) return PENDING_PURCHASE_STATUSES.includes(purchase.status);
  }
  // Stamped as ours but the purchase row hasn't been linked to the customer yet — the
  // checkout.session.completed for it is still on its way.
  return metadata !== null;
}

// ── Provisioning ──────────────────────────────────────────────────────────────

export interface ProvisionOptions {
  /** Last automatic attempt (or the operator re-run): a failure alerts the operator and is final. */
  finalAttempt: boolean;
  deps?: Partial<ProvisionDeps>;
}

/** The provisioning steps. Every step is idempotent, so a retry after a crash resumes safely. */
async function provisionClaimed(admin: AdminClient, purchase: CrankleadsPurchase, deps: ProvisionDeps): Promise<string> {
  const tier = purchase.tier;
  if (!isCrankleadsTier(tier)) throw new Error(`Unknown CrankLeads tier "${tier}".`);

  // 1) Owner login — create, or attach to the existing EmpireVu user with this email.
  let ownerId = purchase.owner_profile_id;
  let existingUser = purchase.existing_user ?? false;
  if (!ownerId) {
    const user = await ensureOwnerUser(admin, purchase.owner_email, purchase.owner_name);
    ownerId = user.id;
    existingUser = user.existing;
    await updatePurchase(admin, purchase.id, { owner_profile_id: ownerId, existing_user: existingUser });
  }

  // 2) Organization (paid, on the tier's plan) + owner membership.
  const org = await ensureOrganization(admin, purchase, tier, ownerId, existingUser);
  await ensureOwnerMembership(admin, org.id, ownerId);
  if (purchase.organization_id !== org.id) {
    await updatePurchase(admin, purchase.id, { organization_id: org.id });
  }
  await upsertSubscriptionMirror(admin, org.id, purchase, tier);

  // 3) Company — the wizard's own service (installs the recipe catalog).
  const ctx: TenantServiceContext = { actorProfileId: ownerId, organizationId: org.id, supabase: admin };
  const companyId = await ensureCompany(ctx, purchase);
  if (purchase.company_id !== companyId) {
    await updatePurchase(admin, purchase.id, { company_id: companyId });
  }

  // 3b) Done-for-you: every new purchase gets its quick-setup intake row now. It is what marks
  // the company as "done-for-you" for every sweep (legacy companies never have one) — so it
  // must exist even if the text later fails. Idempotent (one per company).
  await ensureSetupIntake(admin, { organizationId: org.id, companyId });

  // 4) Industry pack for the trade, with the tier's automations.
  const packId = packIdForBusinessType(purchase.business_type);
  const pack = packId ? getPack(packId) : null;
  if (pack) {
    await applyIndustryPack(ctx, companyId, pack.id, {
      services: true,
      recipes: packRecipesForTier(tier, pack.recipes.map((r) => r.slug)),
    });
  }
  // 4b) Only the tier's automations may be active: createCompany installed the whole recipe
  // catalog at default status (a Catch buyer must not get stale-lead nudges texting leads).
  await restrictAutomationsToTier(ctx, companyId, tier, { packRecipeSlugs: pack ? pack.recipes.map((r) => r.slug) : [] });

  // 5) Website form (the hosted link works the moment they log in).
  await ensureFormUrl(ctx, companyId);

  // 6) Wizard resumes after what is already done.
  await upsertOnboardingStep(ctx, companyId, "business", {
    completed: true,
    data: { source: CRANKLEADS_SOURCE, tier },
  });
  if (pack) {
    await upsertOnboardingStep(ctx, companyId, "services", { completed: true, data: { packId: pack.id } });
  }

  // 6b) Done-for-you: buy the tier's number now (text-back number for Catch / Close, the AI
  // receptionist's for Front Desk; area code from the checkout phone). Never fails provisioning —
  // a failure is recorded and the done-for-you sweep retries it (docs/done-for-you.md).
  await provisionDoneForYouNumber(admin, { organizationId: org.id, companyId, tier, ownerPhone: purchase.owner_phone });

  // 7) Emails — never fail a provisioned purchase over an email; record and alert instead.
  let welcomeError: string | null = null;
  if (!purchase.welcome_email_sent_at) {
    try {
      await sendWelcome(admin, ctx, purchase, tier, companyId, existingUser, deps);
      await updatePurchase(admin, purchase.id, { welcome_email_sent_at: new Date().toISOString(), welcome_email_error: null });
    } catch (err) {
      welcomeError = errorMessage(err);
      console.error(`[crankleads/provision] WELCOME EMAIL FAILED for purchase ${purchase.id}: ${welcomeError}`);
      await updatePurchase(admin, purchase.id, { welcome_email_error: welcomeError.slice(0, 1000) });
    }
  }
  // Done-for-you: text the quick-setup link (idempotent; never fails provisioning).
  try {
    await createAndSendSetupIntake(admin, { organizationId: org.id, companyId, emailBackup: welcomeError ? "always" : "if_sms_fails" });
  } catch (err) {
    console.error(`[crankleads/provision] setup intake send failed for purchase ${purchase.id}: ${errorMessage(err)}`);
  }

  const operator = operatorEmailAddress();
  if (operator && !purchase.operator_notified_at) {
    try {
      await sendRendered(
        deps,
        operator,
        renderOperatorNewPurchaseEmail({
          businessName: purchase.business_name,
          businessType: purchase.business_type,
          tier,
          ownerName: purchase.owner_name,
          ownerEmail: purchase.owner_email,
          ownerPhone: purchase.owner_phone,
          organizationId: org.id,
          sessionId: purchase.stripe_checkout_session_id,
          existingUser,
          packId: pack?.id ?? null,
          welcomeEmailError: welcomeError,
          appUrl: operatorAppUrl(),
        }),
      );
      await updatePurchase(admin, purchase.id, { operator_notified_at: new Date().toISOString() });
    } catch (err) {
      console.error(`[crankleads/provision] operator notification failed for purchase ${purchase.id}: ${errorMessage(err)}`);
    }
  }

  // 8) Done.
  await updatePurchase(admin, purchase.id, {
    status: "provisioned",
    provisioned_at: new Date().toISOString(),
    last_error: null,
  });

  // 9) Let any billing event that raced ahead of us resolve to the new org now.
  if (purchase.stripe_customer_id) {
    try {
      await requeueDeferredBillingEvents(admin, purchase.stripe_customer_id);
    } catch (err) {
      console.error(`[crankleads/provision] requeue of deferred billing events failed: ${errorMessage(err)}`);
    }
  }

  console.log(`[crankleads/provision] provisioned purchase ${purchase.id} → org ${org.id} company ${companyId} (${tier})`);
  return org.id;
}

/** Raised after the operator has been alerted (final attempt), so nobody alerts twice. */
export class CrankleadsProvisioningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrankleadsProvisioningFailedError";
  }
}

/** Stripe statuses that mean "the buyer owes nothing more" (incl. a 100%-off coupon) — provision. */
export function isProvisionablePaymentStatus(status: unknown): boolean {
  return status === "paid" || status === "no_payment_required";
}

interface FailureContext {
  businessName: string;
  tier: string | null;
  ownerEmail: string;
  sessionId: string | null;
}

/**
 * The ONE failure policy for every CrankLeads provisioning entry point. Any error at all
 * (DB, missing metadata, claim race, a step, even recording the failure):
 *   • not the last attempt → DeferBillingEventError, so the billing queue retries it;
 *   • last attempt → operator "ACTION NEEDED" alert (whatever state the purchase is in),
 *     then CrankleadsProvisioningFailedError (the job dead-letters; the ledger row stays).
 */
async function handleProvisioningFailure(
  err: unknown,
  options: ProvisionOptions,
  deps: ProvisionDeps,
  context: FailureContext,
): Promise<never> {
  if (err instanceof CrankleadsProvisioningFailedError) throw err;
  const reason = errorMessage(err);
  console.error(
    `[crankleads/provision] PROVISIONING FAILED (session ${context.sessionId ?? "-"}, final=${options.finalAttempt}): ${reason}`,
  );
  if (!options.finalAttempt) {
    if (err instanceof DeferBillingEventError) throw err;
    throw new DeferBillingEventError(`CrankLeads provisioning failed (will retry): ${reason}`);
  }
  const operator = operatorEmailAddress();
  if (operator) {
    try {
      await sendRendered(
        deps,
        operator,
        renderOperatorFailureEmail({ ...context, tier: isCrankleadsTier(context.tier) ? context.tier : null, error: reason }),
      );
    } catch (mailErr) {
      console.error(`[crankleads/provision] operator FAILURE alert could not be sent: ${errorMessage(mailErr)}`);
    }
  } else {
    console.error("[crankleads/provision] OWNER_EMAIL is not set — no operator alert for a failed paid purchase!");
  }
  throw new CrankleadsProvisioningFailedError(reason);
}

/** Claim + run the steps. On a step failure records `failed` (best-effort) and rethrows. */
async function provisionPurchaseUnguarded(admin: AdminClient, purchaseId: string, deps: ProvisionDeps): Promise<string> {
  const current = await findPurchaseById(admin, purchaseId);
  if (!current) throw new Error(`CrankLeads purchase ${purchaseId} not found.`);
  if (current.status === "provisioned" && current.organization_id) return current.organization_id;
  if (current.status === "checkout_created") {
    throw new Error(`CrankLeads purchase ${purchaseId} is not paid yet.`);
  }

  const claimed = await claimPurchaseForProvisioning(admin, current);
  if (!claimed) {
    const latest = await findPurchaseById(admin, purchaseId);
    if (latest?.status === "provisioned" && latest.organization_id) return latest.organization_id;
    throw new DeferBillingEventError(`CrankLeads purchase ${purchaseId} is being provisioned by another worker.`);
  }

  try {
    return await provisionClaimed(admin, claimed, deps);
  } catch (err) {
    try {
      await markPurchaseFailed(admin, purchaseId, errorMessage(err));
    } catch (markErr) {
      console.error(`[crankleads/provision] could not record failure on purchase ${purchaseId}: ${errorMessage(markErr)}`);
    }
    throw err;
  }
}

async function failureContextForPurchase(admin: AdminClient, purchaseId: string): Promise<FailureContext> {
  try {
    const p = await findPurchaseById(admin, purchaseId);
    if (p) return { businessName: p.business_name, tier: p.tier, ownerEmail: p.owner_email, sessionId: p.stripe_checkout_session_id };
  } catch {
    // fall through — the alert still goes out with what we know
  }
  return { businessName: `purchase ${purchaseId}`, tier: null, ownerEmail: "(unknown)", sessionId: null };
}

/**
 * Provision a paid purchase exactly once (status-guarded claim + idempotent steps). Failures
 * follow handleProvisioningFailure: retry while attempts remain, operator alert on the last.
 * Re-run: `npm run job:crankleads-provision -- --session cs_...`.
 */
export async function provisionPurchase(
  admin: AdminClient,
  purchaseId: string,
  options: ProvisionOptions,
): Promise<string> {
  const deps: ProvisionDeps = { ...defaultDeps, ...options.deps };
  try {
    return await provisionPurchaseUnguarded(admin, purchaseId, deps);
  } catch (err) {
    return handleProvisioningFailure(err, options, deps, await failureContextForPurchase(admin, purchaseId));
  }
}

/**
 * Billing-worker entry for a CrankLeads `checkout.session.completed` /
 * `checkout.session.async_payment_succeeded`. Returns the org id once provisioned, or null
 * when the session isn't settled yet (async payment methods — the *_succeeded event follows).
 * EVERYTHING in here (resolving/rebuilding the purchase, marking it paid, provisioning) is
 * covered by the same failure policy, so a paid purchase can never dead-letter silently.
 */
export async function handleCrankleadsCheckoutPaid(
  admin: AdminClient,
  session: StripeObject,
  options: ProvisionOptions,
): Promise<string | null> {
  const deps: ProvisionDeps = { ...defaultDeps, ...options.deps };
  if (!isProvisionablePaymentStatus(session.payment_status)) {
    console.log(`[crankleads/provision] session ${idOf(session.id)} not paid yet (${String(session.payment_status)}); waiting`);
    return null;
  }
  try {
    const staged = await resolvePurchaseForSession(admin, session);
    const paid = await markPaid(admin, staged, session);
    return await provisionPurchaseUnguarded(admin, paid.id, deps);
  } catch (err) {
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    return handleProvisioningFailure(err, options, deps, {
      businessName: typeof metadata.businessName === "string" ? metadata.businessName : "(unknown business)",
      tier: typeof metadata.tier === "string" ? metadata.tier : null,
      ownerEmail: String(session.customer_details?.email ?? session.customer_email ?? "(unknown)"),
      sessionId: idOf(session.id),
    });
  }
}

// ── Welcome-page resend ───────────────────────────────────────────────────────

export type ResendOutcome = "sent" | "not_ready" | "not_found" | "use_forgot_password";

/** Stop minting set-password links this long after provisioning. */
const RESEND_LINK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Re-send the welcome email (with a fresh set-password link for a new user). */
export async function resendWelcomeEmail(
  admin: AdminClient,
  sessionId: string,
  depsOverride: Partial<ProvisionDeps> = {},
): Promise<ResendOutcome> {
  const deps: ProvisionDeps = { ...defaultDeps, ...depsOverride };
  const purchase = await findPurchaseBySession(admin, sessionId);
  if (!purchase) return "not_found";
  if (purchase.status !== "provisioned" || !purchase.organization_id || !purchase.company_id || !isCrankleadsTier(purchase.tier)) {
    return "not_ready";
  }
  // A set-password link is a login credential: once the owner has signed in, or a week after
  // setup, stop minting them from this public endpoint — Forgot password still works.
  if (!purchase.existing_user) {
    const provisionedAt = purchase.provisioned_at ? Date.parse(purchase.provisioned_at) : Date.now();
    if (Date.now() - provisionedAt > RESEND_LINK_MAX_AGE_MS) return "use_forgot_password";
    const authUser = purchase.owner_profile_id ? await getAuthUser(admin, purchase.owner_profile_id) : null;
    if (authUser?.last_sign_in_at) return "use_forgot_password";
  }
  const ctx: TenantServiceContext = {
    actorProfileId: purchase.owner_profile_id,
    organizationId: purchase.organization_id,
    supabase: admin,
  };
  await sendWelcome(admin, ctx, purchase, purchase.tier, purchase.company_id, purchase.existing_user ?? false, deps);
  await updatePurchase(admin, purchase.id, { welcome_email_sent_at: new Date().toISOString(), welcome_email_error: null });
  return "sent";
}
