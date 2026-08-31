/**
 * Stripe's `refresh_url` target.
 *
 * Account Links are single-use and expire in minutes. When the tenant lets one
 * go stale — closes the tab, comes back tomorrow, follows an old link — Stripe
 * sends their BROWSER here and expects to be redirected onward to a new link.
 *
 * So this is a GET that redirects, not JSON: Stripe navigates to it, and there is
 * no client code in the loop to read a response body. It reuses the company's
 * existing account — the find-or-create is idempotent, so a refresh arriving
 * before an account exists heals rather than duplicating.
 *
 * EVERY exit is a redirect. Whoever is here is a person in a browser part-way
 * through onboarding; a 401 JSON body would be a dead end, so an expired session
 * goes to sign-in and anything else goes back to settings with a reason.
 */
import { NextResponse } from "next/server";

import {
  AuthenticationError,
  AuthorizationError,
  requireOrganizationContext,
} from "@/server/organizations/context";
import { ConnectError, onboardingUrls, startConnectOnboarding } from "@/server/services/quotes/connect";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/**
 * Redirect targets must be absolute. APP_BASE_URL is the truth in production,
 * but falling back to the request's own origin keeps preview deployments and
 * local runs working instead of throwing on a relative URL.
 */
function baseFrom(request: Request): string {
  const configured = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  return configured || new URL(request.url).origin;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { organizationId, companyId } = context.params;
  const base = baseFrom(request);
  const settings = (reason: string) =>
    NextResponse.redirect(
      `${base}/settings?company=${encodeURIComponent(companyId)}&connect_error=${encodeURIComponent(reason)}`,
      303,
    );

  try {
    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, organizationId);
    if (org.membership.role !== "owner" && org.membership.role !== "admin") {
      throw new AuthorizationError("Only an owner or admin can connect a payment account.");
    }

    const link = await startConnectOnboarding(
      companyId,
      org.organizationId,
      onboardingUrls(org.organizationId, companyId),
    );
    return NextResponse.redirect(link.url, 303);
  } catch (err) {
    console.error(`[connect/refresh] company ${companyId}:`, err);

    // A signed-out browser needs the sign-in page, not "link_failed" on a screen
    // it cannot see. `next` is carried for when SignInPage honours it — today it
    // is ignored and they land on the dashboard, which is still a place they can
    // act from.
    if (err instanceof AuthenticationError) {
      const next = encodeURIComponent(`/settings?company=${companyId}`);
      return NextResponse.redirect(`${base}/signin?next=${next}`, 303);
    }
    if (err instanceof AuthorizationError) return settings("forbidden");
    if (err instanceof ConnectError) return settings(err.code);
    return settings("link_failed");
  }
}
