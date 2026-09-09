import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization } from "@/server/services/shared";
import { uploadBrandingLogo } from "@/server/services/onboarding-storage";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * Company logo upload (Business step). Multipart `file` + `companyId`. Authed org member →
 * the file is stored server-side (service-role) in the `branding` bucket under the org id;
 * the public URL is returned for the caller to save as brand_logo_url.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };

    const form = await request.formData();
    const companyId = String(form.get("companyId") ?? "");
    const file = form.get("file");
    if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "A file is required." }, { status: 400 });

    await assertCompanyInOrganization(ctx, companyId);

    const result = await uploadBrandingLogo({
      organizationId: organization.organizationId,
      companyId,
      contentType: file.type,
      bytes: await file.arrayBuffer(),
    });

    return NextResponse.json({ data: result });
  });
}
