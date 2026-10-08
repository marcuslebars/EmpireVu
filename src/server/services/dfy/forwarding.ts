// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): the no-login one-tap forwarding page (/forward/:token).
// Public routes: the unguessable dfy_progress.forward_token is the credential and resolves to
// exactly ONE company; every read/write below is filtered by that row's own organization_id
// + company_id. The page sees only what it needs (business name, the number to forward to,
// the code, verification state) — never contacts, owner email or other tenants' data.
// The automatic forwarding test reuses services/twilio/forwarding-test.ts (rate-limited,
// calling hours, the company's own stored business line). docs/done-for-you.md.
// ─────────────────────────────────────────────────────────────────────────────
import { forwardingPlan, prettyPhone, type ForwardingPlan } from "@/lib/carrier-forwarding";
import { PLATFORM_BRANDS } from "@/lib/platform-brand";
import type { Tables } from "@/server/db/database.types";
import { isCrankleadsTier, type CrankleadsTier } from "@/server/services/crankleads/config";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { phonePathFor, type PhonePath } from "@/server/services/crankleads/setup-checklist";
import { hasFrontDeskForwardingEvidence } from "@/server/services/dfy/front-desk-forwarding";
import { errorMessage, findProgressByForwardToken, patchProgress, type DfyProgress } from "@/server/services/dfy/progress";
import type { TenantServiceContext } from "@/server/services/shared";
import { resolveBusinessLine, startOwnerForwardingTest } from "@/server/services/twilio/forwarding-test";
import { CATCHER_MODE } from "@/server/services/twilio/missed-call";

/** Give the carrier a moment to apply the code before we test-call. */
export const AUTO_TEST_DELAY_MS = 45_000;
/** Automatic tests per company (each tap allows one); the daily retests carry on after that. */
export const MAX_AUTO_TESTS = 5;

type CompanyRow = Pick<
  Tables<"companies">,
  "id" | "organization_id" | "name" | "business_phone_kind" | "business_phone_carrier" | "brand_reply_phone" | "owner_phone_e164"
>;
type NumberRow = Pick<Tables<"voice_numbers">, "id" | "phone_e164" | "mode" | "provider" | "forwarding_verified_at" | "forwarding_last_test_result">;

export interface ForwardTarget {
  company: CompanyRow;
  tier: CrankleadsTier;
  phonePath: PhonePath;
  /** The number calls forward to (catcher or AI), null until it's bought. */
  forwardTo: NumberRow | null;
  verified: boolean;
}

/** Company + tier + the number to forward to, for one progress row. */
export async function loadForwardTarget(admin: AdminClient, row: Pick<DfyProgress, "organization_id" | "company_id">): Promise<ForwardTarget | null> {
  const org = row.organization_id;
  const [company, organization, numbers, calls] = await Promise.all([
    admin
      .from("companies")
      .select("id, organization_id, name, business_phone_kind, business_phone_carrier, brand_reply_phone, owner_phone_e164")
      .eq("organization_id", org)
      .eq("id", row.company_id)
      .maybeSingle(),
    admin.from("organizations").select("crankleads_tier").eq("id", org).maybeSingle(),
    admin
      .from("voice_numbers")
      .select("id, phone_e164, mode, provider, forwarding_verified_at, forwarding_last_test_result")
      .eq("organization_id", org)
      .eq("company_id", row.company_id)
      .eq("active", true),
    admin.from("retell_calls").select("id").eq("organization_id", org).eq("company_id", row.company_id).limit(1),
  ]);
  if (company.error) throw new Error(`company lookup failed: ${company.error.message}`);
  if (organization.error) throw new Error(`organization lookup failed: ${organization.error.message}`);
  if (numbers.error) throw new Error(`numbers lookup failed: ${numbers.error.message}`);
  const companyRow = company.data as CompanyRow | null;
  const tierRaw = (organization.data as { crankleads_tier: string | null } | null)?.crankleads_tier ?? null;
  if (!companyRow || !isCrankleadsTier(tierRaw)) return null;
  const rows = (numbers.data ?? []) as NumberRow[];
  const catcher = rows.find((n) => n.provider === "twilio" && n.mode === CATCHER_MODE) ?? null;
  const ai = rows.find((n) => n.mode === "ai_receptionist") ?? null;
  const phonePath = phonePathFor(tierRaw, { catcherNumber: catcher?.phone_e164 ?? null, aiNumber: ai?.phone_e164 ?? null });
  const forwardTo = phonePath === "ai_receptionist" ? ai : catcher;
  const aiCallSeen = !calls.error && (calls.data ?? []).length > 0;
  // Front Desk: a call that reached the AI number is not enough — it must show forwarding from
  // the business line (dfy/front-desk-forwarding.ts has the exact rule).
  const aiForwarded =
    phonePath === "ai_receptionist" && ai && aiCallSeen && !ai.forwarding_verified_at
      ? await hasFrontDeskForwardingEvidence(admin, {
          organizationId: org,
          companyId: row.company_id,
          aiNumber: ai.phone_e164,
          businessLine: resolveBusinessLine(companyRow),
        })
      : false;
  const verified = Boolean(forwardTo?.forwarding_verified_at) || aiForwarded;
  return { company: companyRow, tier: tierRaw, phonePath, forwardTo, verified };
}

export type ForwardStatus = "number_pending" | "ready" | "testing" | "not_forwarded" | "verified";

export interface ForwardPageView {
  businessName: string;
  brandName: string;
  phonePath: PhonePath;
  /** null while the number is still being bought. */
  plan: ForwardingPlan | null;
  businessLinePretty: string | null;
  status: ForwardStatus;
  /** A short line under the button for the current status (null = nothing to say). */
  statusMessage: string | null;
  tapped: boolean;
  helpRequested: boolean;
}

async function latestTestStatus(admin: AdminClient, target: ForwardTarget): Promise<string | null> {
  if (!target.forwardTo || target.phonePath !== "missed_call_catcher") return null;
  const { data, error } = await admin
    .from("forwarding_tests")
    .select("status")
    .eq("organization_id", target.company.organization_id)
    .eq("voice_number_id", target.forwardTo.id)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) return null;
  return ((data ?? []) as Array<{ status: string }>)[0]?.status ?? null;
}

/** PURE: status + message for the page. */
export function forwardStatusFor(input: {
  hasNumber: boolean;
  verified: boolean;
  phonePath: PhonePath;
  latestTest: string | null;
  tapped: boolean;
}): { status: ForwardStatus; message: string | null } {
  if (!input.hasNumber) return { status: "number_pending", message: "We're still setting up your number — check back in a few minutes." };
  if (input.verified) {
    return {
      status: "verified",
      message:
        input.phonePath === "ai_receptionist"
          ? "Forwarding works — your AI receptionist is answering the calls you miss."
          : "Forwarding works — missed callers now get a text back.",
    };
  }
  if (input.latestTest === "calling") return { status: "testing", message: "Testing it now — we're calling your business line. Let it ring, don't answer." };
  if (input.tapped && input.latestTest === "not_forwarded") {
    return { status: "not_forwarded", message: "Our test call wasn't forwarded yet. Dial the code again from your business phone, or have us set it up." };
  }
  if (input.tapped && input.phonePath === "missed_call_catcher") {
    return { status: "ready", message: "Thanks! We'll call your business line in about a minute to check it — let it ring, don't answer." };
  }
  if (input.tapped) return { status: "ready", message: "Thanks! To check it, call your business line from another phone and let it ring — your AI receptionist should pick up." };
  return { status: "ready", message: null };
}

export async function buildForwardPageView(admin: AdminClient, row: DfyProgress): Promise<ForwardPageView | null> {
  const target = await loadForwardTarget(admin, row);
  if (!target) return null;
  const businessLine = resolveBusinessLine(target.company);
  const plan = target.forwardTo
    ? forwardingPlan({
        forwardTo: target.forwardTo.phone_e164,
        kind: target.company.business_phone_kind,
        carrier: target.company.business_phone_carrier,
      })
    : null;
  const latestTest = await latestTestStatus(admin, target);
  const tapped = Boolean(row.forward_tapped_at);
  const { status, message } = forwardStatusFor({
    hasNumber: Boolean(target.forwardTo),
    verified: target.verified,
    phonePath: target.phonePath,
    latestTest,
    tapped,
  });
  return {
    businessName: target.company.name,
    brandName: PLATFORM_BRANDS.crankleads.name,
    phonePath: target.phonePath,
    plan,
    businessLinePretty: businessLine ? prettyPhone(businessLine) : null,
    status,
    statusMessage: message,
    tapped,
    helpRequested: Boolean(row.forward_help_requested_at),
  };
}

export interface ForwardingDeps {
  /** Places the forwarding test call (default: the owner-test path, rate-limited). */
  startTest?: (ctx: TenantServiceContext, companyId: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * After the owner tapped (or confirmed), place ONE automatic forwarding test once the carrier
 * has had AUTO_TEST_DELAY_MS to apply the code. Catcher path only (the test detects the
 * forwarded leg on our Twilio number; a Front Desk line is verified by the first call that
 * reaches the AI). Guarded so concurrent callers (page poll + sweep) start it once.
 * Never throws. Returns true when a test was placed.
 */
export async function maybeStartAutoForwardingTest(
  admin: AdminClient,
  row: DfyProgress,
  target: ForwardTarget,
  deps: ForwardingDeps = {},
): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  if (!row.forward_tapped_at || target.verified || target.phonePath !== "missed_call_catcher" || !target.forwardTo) return false;
  const tappedMs = Date.parse(row.forward_tapped_at);
  if (!Number.isFinite(tappedMs) || now - tappedMs < AUTO_TEST_DELAY_MS) return false;
  if (row.forward_last_test_at && Date.parse(row.forward_last_test_at) >= tappedMs) return false;
  if ((row.forward_tests_started ?? 0) >= MAX_AUTO_TESTS) return false;
  try {
    let claim = admin
      .from("dfy_progress")
      .update({ forward_last_test_at: new Date(now).toISOString(), forward_tests_started: (row.forward_tests_started ?? 0) + 1 })
      .eq("organization_id", row.organization_id)
      .eq("company_id", row.company_id)
      .eq("forward_tests_started", row.forward_tests_started ?? 0);
    claim = row.forward_last_test_at ? claim.eq("forward_last_test_at", row.forward_last_test_at) : claim.is("forward_last_test_at", null);
    const { data, error } = await claim.select("company_id");
    if (error) throw new Error(error.message);
    if ((data ?? []).length === 0) return false;
    const ctx: TenantServiceContext = { organizationId: row.organization_id, actorProfileId: null, supabase: admin };
    await (deps.startTest ?? startOwnerForwardingTest)(ctx, row.company_id);
    console.log(`[dfy/forwarding] automatic forwarding test placed for company ${row.company_id}`);
    return true;
  } catch (err) {
    // Outside calling hours, no business line, rate limit… — the daily retests pick it up.
    console.warn(`[dfy/forwarding] automatic test not placed for company ${row.company_id}: ${errorMessage(err)}`);
    return false;
  }
}

export type ForwardAction = "opened" | "tapped" | "help";

export interface ForwardActionDeps extends ForwardingDeps {
  /** Operator "call them" email for a help request (sent once). */
  onHelpRequested?: (row: DfyProgress, target: ForwardTarget) => Promise<void>;
}

/** Record what the owner did on the page. Returns the fresh view, or null for an unknown token. */
export async function recordForwardAction(
  admin: AdminClient,
  token: string,
  action: ForwardAction,
  deps: ForwardActionDeps = {},
): Promise<ForwardPageView | null> {
  const row = await findProgressByForwardToken(admin, token);
  if (!row) return null;
  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
  if (action === "opened" && !row.forward_opened_at) {
    await patchProgress(admin, row, { forward_opened_at: nowIso });
  } else if (action === "tapped") {
    await patchProgress(admin, row, { forward_tapped_at: nowIso, forward_opened_at: row.forward_opened_at ?? nowIso });
  } else if (action === "help") {
    const { data, error } = await admin
      .from("dfy_progress")
      .update({ forward_help_requested_at: nowIso })
      .eq("organization_id", row.organization_id)
      .eq("company_id", row.company_id)
      .is("forward_help_requested_at", null)
      .select("company_id");
    if (error) throw new Error(`help request write failed: ${error.message}`);
    if ((data ?? []).length > 0 && deps.onHelpRequested) {
      const target = await loadForwardTarget(admin, row);
      if (target) {
        try {
          await deps.onHelpRequested({ ...row, forward_help_requested_at: nowIso }, target);
        } catch (err) {
          console.error(`[dfy/forwarding] help-request operator email failed: ${errorMessage(err)}`);
        }
      }
    }
  }
  const fresh = await findProgressByForwardToken(admin, token);
  return fresh ? buildForwardPageView(admin, fresh) : null;
}

/** The page's poll: the view, and — when due — the automatic test after a tap. */
export async function pollForwardPage(admin: AdminClient, token: string, deps: ForwardingDeps = {}): Promise<ForwardPageView | null> {
  const row = await findProgressByForwardToken(admin, token);
  if (!row) return null;
  const target = await loadForwardTarget(admin, row);
  if (!target) return null;
  if (await maybeStartAutoForwardingTest(admin, row, target, deps)) {
    const fresh = await findProgressByForwardToken(admin, token);
    return fresh ? buildForwardPageView(admin, fresh) : null;
  }
  return buildForwardPageView(admin, row);
}
