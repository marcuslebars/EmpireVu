import { NextResponse } from "next/server";

import { verifyIntakeSignature } from "@/server/services/lead-intake/hmac";
import { handleLeadIntake } from "@/server/services/lead-intake/intake";

export const dynamic = "force-dynamic";

/**
 * Public lead intake. HMAC-authed (not session auth — the middleware matcher excludes
 * /api/*). Never drops a lead: an authenticated request always gets 200 with a leadId,
 * and the response echoes no data (write-only in effect).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.LEAD_INTAKE_SECRET;
  const rawBody = await request.text();

  if (!secret) {
    console.error("[intake] LEAD_INTAKE_SECRET not configured — rejecting");
    return NextResponse.json({ error: "Intake not configured." }, { status: 503 });
  }

  // Auth over the exact bytes. Bad/missing signature -> 401, and no write happens.
  const signature = request.headers.get("x-empirevu-signature");
  if (!verifyIntakeSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  // Parse may fail; a null parsedBody is still handled (stored raw, never dropped).
  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  try {
    const result = await handleLeadIntake(rawBody, parsedBody);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // Only the durable write failing reaches here -> 500 so the spoke retries. The
    // spoke treats EmpireVu as best-effort, so the customer is never affected.
    console.error("[intake] durable write failed:", err);
    return NextResponse.json({ error: "Could not record the lead." }, { status: 500 });
  }
}
