/** POST …/imports/send-link — text the owner the no-login import link (/import/:token). Owner/admin. */
import { NextResponse } from "next/server";

import { UserFacingError } from "@/server/errors";
import { handleRoute } from "@/server/api/route";
import { defaultImporterDeps } from "@/server/services/staff/importer/deps";
import { sendImportLink } from "@/server/services/staff/importer/links";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { importGuard, type ImportRouteContext } from "../guard";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: ImportRouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { company } = await importGuard(context, true);
    const out = await sendImportLink(createSupabaseAdminClient(), company, defaultImporterDeps);
    if (out.status === "off") throw new UserFacingError("Customer import is off for this business.", { status: 400 });
    if (out.status === "no_phone") throw new UserFacingError("Confirm your cell for owner texts first (Settings > AI front desk).", { status: 400 });
    if (out.status !== "sent") throw new UserFacingError("The text didn't go through - try again in a minute.", { status: 502 });
    return NextResponse.json({ data: { sent: true } });
  });
}
