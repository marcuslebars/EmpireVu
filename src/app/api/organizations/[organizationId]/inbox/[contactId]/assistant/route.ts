import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getContactById } from "@/server/services/contacts";
import type { TenantServiceContext } from "@/server/services/shared";
import { getConversationStatus, markOwnerTakeover, setConversationAi } from "@/server/services/sms-agent/takeover";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; contactId: string };
}

/** The contact, resolved under the caller's RLS (a non-member / other org's contact → 403/404). */
async function resolve(params: RouteContext["params"]) {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, params.organizationId);
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  const contact = await getContactById(ctx, params.contactId);
  return { ctx, contact };
}

/** Is the AI answering this customer's texts? (inbox thread header) */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { ctx, contact } = await resolve(context.params);
    const data = await getConversationStatus(ctx.supabase as never, { companyId: contact.company_id, contactId: contact.id });
    return NextResponse.json({ data });
  });
}

const bodySchema = z.object({ ai: z.boolean() }).strict();

/**
 * "Take over" (ai: false → the owner has it for 72h, the AI stays quiet) or "Let AI handle it"
 * (ai: true). Any member may do this — it's the same as replying by hand.
 *
 * SANCTIONED EXCEPTION (service role): sms_conversations isn't client-writable. The contact is
 * resolved first through the caller's RLS session (another org's contact → 403/404), then only
 * that contact's own company + contact id are written (state / owner_takeover_at).
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { ctx, contact } = await resolve(context.params);
    const body = await parseJsonBody(request, bodySchema);
    const admin = createSupabaseAdminClient();
    if (body.ai) await setConversationAi(admin, { companyId: contact.company_id, contactId: contact.id, on: true });
    else await markOwnerTakeover(admin, { companyId: contact.company_id, contactId: contact.id });
    const data = await getConversationStatus(ctx.supabase as never, { companyId: contact.company_id, contactId: contact.id });
    return NextResponse.json({ data });
  });
}
