import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { COMPLIANCE_KINDS } from "@/server/services/staff/compliance/kinds";
import {
  createSettingsUpload,
  deleteDocument,
  documentFileUrl,
  fileSettingsUpload,
  getComplianceView,
  revokeShareFromSettings,
  saveSub,
  updateComplianceSettings,
  updateDocument,
  type DocumentPatch,
  type HolderChoice,
} from "@/server/services/staff/compliance/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z.object({ enabled: z.boolean().optional(), reminders: z.boolean().optional(), sharing: z.boolean().optional() }).strict();

const holderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("company") }).strict(),
  z.object({ type: z.literal("crew"), profileId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("subcontractor"), subcontractorId: z.string().uuid() }).strict(),
]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kind = z.enum(COMPLIANCE_KINDS as unknown as [string, ...string[]]);
const subFields = {
  name: z.string().max(80).nullable().optional(),
  businessName: z.string().max(120).nullable().optional(),
  trade: z.string().max(60).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().max(120).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  active: z.boolean().optional(),
};

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upload_url"), contentType: z.string().max(60) }).strict(),
  z.object({ action: z.literal("file_upload"), path: z.string().max(300), contentType: z.string().max(60), holder: holderSchema.nullable().optional(), kind: kind.nullable().optional() }).strict(),
  z
    .object({
      action: z.literal("update_doc"),
      id: z.string().uuid(),
      kind: kind.optional(),
      title: z.string().max(60).nullable().optional(),
      holder: holderSchema.optional(),
      issuer: z.string().max(80).nullable().optional(),
      number: z.string().max(40).nullable().optional(),
      issuedOn: date.nullable().optional(),
      expiresOn: date.nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
    })
    .strict(),
  z.object({ action: z.literal("delete_doc"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("file_url"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("save_sub"), id: z.string().uuid().nullable().optional(), ...subFields }).strict(),
  z.object({ action: z.literal("revoke_share"), id: z.string().uuid() }).strict(),
]);

/** Members read the switches + counts; documents, subs and links are owner/admin only. */
async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; canManage: boolean; actor: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const canManage = role === "owner" || role === "admin";
  if (manage && !canManage) throw new AuthorizationError("Only owners and admins can change this.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, canManage, actor: `profile:${organization.user.id}` };
}

/** Settings → AI front desk → Compliance. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, canManage } = await guard(context, false);
    const data = await getComplianceView(createSupabaseAdminClient(), { organizationId, companyId }, { full: canManage });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.compliance ({ enabled, reminders, sharing }). */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateComplianceSettings(createSupabaseAdminClient(), { organizationId, companyId }, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin actions: upload, file, edit, delete, view a file, subs, turn a customer link off. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, actor } = await guard(context, true);
    const scope = { organizationId, companyId };
    const body = await parseJsonBody(request, actionSchema);
    const admin = createSupabaseAdminClient();
    const view = async (extra: Record<string, unknown> = {}) => NextResponse.json({ data: { ...(await getComplianceView(admin, scope, { full: true })), ...extra } });
    switch (body.action) {
      case "upload_url":
        return NextResponse.json({ data: await createSettingsUpload(admin, scope, body.contentType) });
      case "file_upload": {
        const filed = await fileSettingsUpload(admin, scope, { path: body.path, contentType: body.contentType, holder: (body.holder ?? null) as HolderChoice | null, kind: body.kind ?? null }, actor);
        return view({ message: filed.message, documentId: filed.documentId });
      }
      case "update_doc": {
        const { action: _a, id, ...patch } = body;
        void _a;
        await updateDocument(admin, scope, id, patch as DocumentPatch);
        return view({ message: "Saved" });
      }
      case "delete_doc":
        await deleteDocument(admin, scope, body.id, actor);
        return view({ message: "Deleted" });
      case "file_url":
        return NextResponse.json({ data: { url: await documentFileUrl(admin, scope, body.id, actor) } });
      case "save_sub": {
        const { action: _a, id, ...input } = body;
        void _a;
        await saveSub(admin, scope, id ?? null, input);
        return view({ message: "Saved" });
      }
      case "revoke_share": {
        const n = await revokeShareFromSettings(admin, scope, body.id, actor);
        return view({ message: n ? "Link turned off" : "That link was already off" });
      }
    }
  });
}
