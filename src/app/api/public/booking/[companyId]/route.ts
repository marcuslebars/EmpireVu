import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import {
  createPublicBookingRequest,
  getPublicAvailability,
  publicBookingRequestSchema,
} from "@/server/services/public-booking";
import { clientIp, enforceRateLimit } from "@/server/services/rate-limit";
import { assessFormSignals, verifyTurnstile } from "@/server/services/turnstile";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    companyId: string;
  };
}

function readField(raw: unknown, key: string): unknown {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
}

/**
 * Public, unauthenticated. The middleware matcher excludes /api/*, so no session
 * is required. The company is resolved server-side from the URL; the request can
 * never choose which org/company it touches.
 *
 * Abuse controls (Task 5): GET is rate-limited per IP; POST is rate-limited per IP
 * AND per company, screened by a honeypot + minimum fill time, and (once configured)
 * by Cloudflare Turnstile.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const limited = await enforceRateLimit(request, {
      scope: "public_booking_get",
      limit: 60,
      windowSeconds: 600,
      keyParts: [clientIp(request)],
      logContext: { companyId: context.params.companyId },
    });
    if (limited) return limited;

    const data = await getPublicAvailability(context.params.companyId);
    if (!data) {
      return NextResponse.json({ error: "This booking link is not valid." }, { status: 404 });
    }
    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const companyId = context.params.companyId;

    // 5 per 10 min per IP, and 60 per hour per company — the IP limit stops one abuser,
    // the company limit caps total spam into a single tenant's CRM.
    const ipLimited = await enforceRateLimit(request, {
      scope: "public_booking_post",
      limit: 5,
      windowSeconds: 600,
      keyParts: [clientIp(request)],
      logContext: { companyId },
    });
    if (ipLimited) return ipLimited;

    const companyLimited = await enforceRateLimit(request, {
      scope: "public_booking_post_company",
      limit: 60,
      windowSeconds: 3600,
      keyParts: [companyId],
      logContext: { companyId },
    });
    if (companyLimited) return companyLimited;

    const raw = await request.json().catch(() => null);

    // Honeypot + minimum fill time. Generic 400 — don't tell a bot which check tripped.
    const signals = assessFormSignals({
      honeypot: readField(raw, "website"),
      formStartedAt: readField(raw, "formStartedAt"),
    });
    if (!signals.ok) {
      return NextResponse.json(
        { error: "Your request could not be processed. Please try again." },
        { status: 400 },
      );
    }

    const turnstile = await verifyTurnstile(request, readField(raw, "turnstileToken") as string | undefined);
    if (!turnstile.ok) {
      return NextResponse.json(
        { error: "Please complete the verification and try again." },
        { status: 400 },
      );
    }

    // Unknown keys (website / formStartedAt / turnstileToken) are stripped by the schema.
    const input = publicBookingRequestSchema.parse(raw);
    const data = await createPublicBookingRequest(companyId, input);
    return NextResponse.json({ data });
  });
}
