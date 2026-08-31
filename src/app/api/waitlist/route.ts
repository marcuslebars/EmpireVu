import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Public early-access signup endpoint for the empirevu.com marketing site.
 *
 * Cross-origin by design: the form is served from empirevu.com and posts here to
 * app.empirevu.com, so this route answers CORS preflight and echoes an allowed
 * Origin. Writes go through the service-role admin client (waitlist RLS has no
 * public policies), and the insert is idempotent on email — a repeat signup is a
 * no-op success, never an error the visitor sees.
 */

const DEFAULT_ALLOWED = "https://empirevu.com,https://www.empirevu.com";

function allowedOrigins(): Set<string> {
  const raw = process.env.WAITLIST_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // Only reflect an Origin we trust; unknown origins get no ACAO header, so a
  // browser there can't read the response (a non-browser client isn't our concern
  // for a public waitlist).
  if (origin && allowedOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  business: z.string().trim().max(200).optional(),
  // Honeypot: a hidden field a real person never fills; bots do. Present => drop.
  company_url: z.string().max(200).optional(),
});

export async function OPTIONS(request: Request): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const cors = corsHeaders(request.headers.get("origin"));

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Enter a valid email." }, { status: 400, headers: cors });
  }

  // Honeypot tripped — behave like success, persist nothing.
  if (parsed.company_url && parsed.company_url.trim().length > 0) {
    return NextResponse.json({ data: { ok: true } }, { status: 200, headers: cors });
  }

  try {
    const supabase = createSupabaseAdminClient();
    // `waitlist` isn't in the generated Database types (hand-committed), so cast
    // the call — same convention as the other service-role writes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("waitlist") as any).upsert(
      {
        business: parsed.business && parsed.business.length > 0 ? parsed.business : null,
        email: parsed.email,
        source: "empirevu.com",
      },
      { onConflict: "email", ignoreDuplicates: true },
    );
    if (error) {
      throw error;
    }
    return NextResponse.json({ data: { ok: true } }, { status: 200, headers: cors });
  } catch (err) {
    console.error("[waitlist] insert failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Could not save your signup. Please try again." },
      { status: 500, headers: cors },
    );
  }
}

// ── Admin read ───────────────────────────────────────────────────────────────

/** Constant-time bearer-token check for the operator-only read. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface WaitlistRow {
  email: string;
  business: string | null;
  source: string;
  created_at: string;
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: WaitlistRow[]): string {
  const lines = ["email,business,source,created_at"];
  for (const r of rows) {
    lines.push([r.email, r.business, r.source, r.created_at].map(csvCell).join(","));
  }
  return lines.join("\n");
}

/**
 * Operator-only read of the signups. The app has no platform-admin identity, so
 * this is gated by a static bearer token (WAITLIST_ADMIN_TOKEN) rather than a
 * session — call it with `Authorization: Bearer <token>`. JSON by default;
 * `?format=csv` returns a spreadsheet-friendly export. Unset token => 503.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.WAITLIST_ADMIN_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "Admin read is not configured." }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !tokenMatches(token, expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createSupabaseAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from("waitlist") as any)
    .select("email, business, source, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[waitlist] admin read failed:", error.message ?? error);
    return NextResponse.json({ error: "Could not read the waitlist." }, { status: 500 });
  }

  const rows = (data ?? []) as WaitlistRow[];
  if (new URL(request.url).searchParams.get("format") === "csv") {
    return new NextResponse(toCsv(rows), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="waitlist.csv"',
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  }
  return NextResponse.json({ data: { count: rows.length, signups: rows } });
}
