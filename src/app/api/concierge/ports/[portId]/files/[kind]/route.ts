import { NextResponse } from "next/server";
import { z } from "zod";

// SANCTIONED EXCEPTION (service role) — the signed LOA / phone bill of one port, for the operator
// to upload to Twilio's form. Operator-only (requireOperator → 404 for everyone else). Each
// download is audited in operator_actions (the bill shows the account number), then answered
// with a 2-minute signed download URL ({ data: { url } } - the console opens it).
import { handleRoute } from "@/server/api/route";
import { ConciergeNotFoundError, requireOperator } from "@/server/services/concierge/auth";
import { loadPortForOperator } from "@/server/services/staff/porting/operator";
import { markOperatorOpened } from "@/server/services/staff/porting/service";
import { supabasePortingStorage } from "@/server/services/staff/porting/storage";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { portId: string; kind: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const operator = await requireOperator(request);
    const kind = context.params.kind;
    if (!z.string().uuid().safeParse(context.params.portId).success || (kind !== "loa" && kind !== "bill")) throw new ConciergeNotFoundError();
    const admin = createSupabaseAdminClient();
    const port = await loadPortForOperator(admin, context.params.portId);
    const path = kind === "loa" ? port?.loa_path : port?.bill_path;
    if (!port || !path) throw new ConciergeNotFoundError();

    const { error: auditError } = await admin.from("operator_actions").insert({
      operator_email: operator.email,
      organization_id: port.organization_id,
      company_id: port.company_id,
      action: kind === "loa" ? "port_download_loa" : "port_download_bill",
      detail: { status: "ok", portId: port.id },
    });
    if (auditError) throw new Error(`concierge: audit write failed: ${auditError.message}`);
    // The operator is working it now: the owner's form locks.
    await markOperatorOpened(admin, { organizationId: port.organization_id, companyId: port.company_id }, port.id);

    const ext = path.slice(path.lastIndexOf(".") + 1);
    const url = await supabasePortingStorage(admin).signedUrl(path, `${kind === "loa" ? "LOA" : "phone-bill"}-${port.numbers[0]?.replace(/\D/g, "") ?? port.id}.${ext}`);
    if (!url) throw new ConciergeNotFoundError();
    return NextResponse.json({ data: { url } }, { headers: { "Cache-Control": "no-store" } });
  }, request);
}
