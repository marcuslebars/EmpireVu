import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext, type OrganizationContext } from "@/server/organizations/context";
import { InvoiceConflictError, InvoiceNotFoundError } from "@/server/services/invoices/errors";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Shared wrapper for the authed invoice / business-account routes: resolves the
 * member's org context under RLS and maps the invoice errors to HTTP —
 * not found → 404, wrong state → 409 (with the existing invoice id when the
 * conflict is "already invoiced"). Everything else falls through to handleRoute.
 */
export function invoiceRoute(
  organizationId: string,
  handler: (ctx: TenantServiceContext, org: OrganizationContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, organizationId);
    try {
      return await handler({ organizationId: org.organizationId, actorProfileId: org.user.id, supabase }, org);
    } catch (err) {
      if (err instanceof InvoiceNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      if (err instanceof InvoiceConflictError) {
        return NextResponse.json({ error: err.message, existingInvoiceId: err.existingInvoiceId }, { status: 409 });
      }
      throw err;
    }
  });
}
