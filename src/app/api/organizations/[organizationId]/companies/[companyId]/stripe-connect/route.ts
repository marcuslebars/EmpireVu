/**
 * Stripe Connect onboarding for one company.
 *
 *   GET  → the connection status the settings screen renders
 *   POST → a fresh Account Link to send the operator to Stripe
 *
 * Until this existed the only way to connect a tenant was to create the account
 * in the Stripe dashboard by hand and write `stripe_connected_account_id` with
 * SQL. That worked, but it skipped account creation with our metadata on it and
 * did not scale past the first tenant.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import {
  ConnectError,
  getConnectStatus,
  onboardingUrls,
  refreshConnectedAccount,
  startConnectOnboarding,
} from "@/server/services/quotes/connect";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/**
 * Connecting a Stripe account decides where a business's money lands, so it sits
 * with the people who can already manage the organization — not with every
 * member who can read a quote.
 */
function assertCanManagePayments(role: string): void {
  if (role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only an owner or admin can connect a payment account.");
  }
}

/** Matches the quotes routes: the feature is invisible, not merely disabled. */
function disabledResponse(): NextResponse | null {
  return getQuotesConfig().enabled
    ? null
    : NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });
}

/** ConnectError carries an operator-meaningful code; map it to a status. */
function statusForConnectError(err: ConnectError): number {
  return err.code === "company_not_found" ? 404 : 409;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const off = disabledResponse();
    if (off) return off;

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManagePayments(org.membership.role);

    // ?sync=1 asks Stripe rather than trusting the mirrored columns. Costs an API
    // call, so it is opt-in: the webhook normally keeps them current, and this is
    // for when someone has just finished onboarding and does not want to wait.
    const sync = new URL(request.url).searchParams.get("sync") === "1";

    try {
      if (sync) {
        await refreshConnectedAccount(context.params.companyId, org.organizationId);
      }
      const data = await getConnectStatus(context.params.companyId, org.organizationId);
      return NextResponse.json({ data });
    } catch (err) {
      // A sync failure must not blank the page. The mirrored state is still the
      // best answer we have, so fall back to it rather than returning an error
      // that hides a perfectly good status.
      if (sync && !(err instanceof ConnectError)) {
        console.error(`[connect] live sync failed for company ${context.params.companyId}:`, err);
        const data = await getConnectStatus(context.params.companyId, org.organizationId);
        return NextResponse.json({ data, warning: "Could not reach Stripe; showing last known state." });
      }
      if (err instanceof ConnectError) {
        return NextResponse.json({ error: err.message }, { status: statusForConnectError(err) });
      }
      throw err;
    }
  });
}

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const off = disabledResponse();
    if (off) return off;

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManagePayments(org.membership.role);

    try {
      const link = await startConnectOnboarding(
        context.params.companyId,
        org.organizationId,
        onboardingUrls(org.organizationId, context.params.companyId),
      );
      // The URL is single-use and short-lived — returned for an immediate
      // redirect, never stored or emailed.
      return NextResponse.json({ data: link });
    } catch (err) {
      if (err instanceof ConnectError) {
        return NextResponse.json({ error: err.message }, { status: statusForConnectError(err) });
      }
      throw err;
    }
  });
}
