// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): CrankLeads "stop setup reminders" link. The owner
// clicks it from an email, possibly signed out — there is no RLS identity, and
// crankleads_purchases is service-role only. The purchase is found ONLY by the random token
// the link carries (never by an id the request chooses), and the one write is
// crankleads_purchases.setup_reminders_stopped_at. Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";

import { CRANKLEADS_OFFER_NAME } from "@/server/services/crankleads/config";
import { isStopToken, stopSetupReminders } from "@/server/services/crankleads/setup-followups";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * "Stop these setup reminders" — the link in the footer of every CrankLeads setup reminder
 * email. Public: the 48-hex-char random token (crankleads_purchases.setup_reminders_stop_token)
 * is the credential; it can do exactly one thing — stop that purchase's setup reminders.
 * GET only shows a confirm button (mail scanners prefetch links; a GET must not change state);
 * the POST from that button stops them. Rate-limited per IP.
 */

const HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

function page(title: string, inner: string, status = 200): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;color:#111827;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}main{background:#fff;border:1px solid #e5e7eb;border-radius:12px;max-width:420px;padding:24px}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;line-height:1.5;color:#374151}button{padding:10px 16px;border:0;border-radius:8px;background:#111827;color:#fff;font-weight:600;cursor:pointer}</style></head>
<body><main>${inner}</main></body></html>`;
  return new NextResponse(html, { status, headers: HEADERS });
}

function notFound(): NextResponse {
  return page("Link not valid", `<h1>This link isn't valid</h1><p>It may have been copied incompletely. Reply to any ${CRANKLEADS_OFFER_NAME} email and we'll stop the reminders for you.</p>`, 404);
}

async function limited(request: Request): Promise<NextResponse | null> {
  return enforceRateLimit(request, {
    scope: "crankleads_stop_reminders_ip",
    limit: 20,
    windowSeconds: 3600,
    keyParts: [trustedClientIp(request)],
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const blocked = await limited(request);
  if (blocked) return blocked;
  const token = new URL(request.url).searchParams.get("token");
  if (!isStopToken(token)) return notFound();
  return page(
    "Stop setup reminders",
    `<h1>Stop setup reminders?</h1><p>We'll stop the emails and texts reminding you to finish setting up. Your system keeps working exactly as it is.</p>
<form method="post" action="?token=${token}"><button type="submit">Stop reminders</button></form>`,
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const blocked = await limited(request);
  if (blocked) return blocked;
  const token = new URL(request.url).searchParams.get("token");
  if (!isStopToken(token)) return notFound();
  try {
    const outcome = await stopSetupReminders(createSupabaseAdminClient(), token);
    if (outcome === "not_found") return notFound();
    return page(
      "Reminders stopped",
      `<h1>Done — no more setup reminders</h1><p>You can finish setup any time from your dashboard. Questions? Reply to any ${CRANKLEADS_OFFER_NAME} email.</p>`,
    );
  } catch (err) {
    console.error("[crankleads/stop-reminders] failed:", err instanceof Error ? err.message : err);
    return page("Something went wrong", "<h1>Something went wrong</h1><p>Please try again in a minute.</p>", 502);
  }
}
