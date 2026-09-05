import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role) — internal per-tenant cost vs MRR (Task 6).
//
// A cross-tenant report (every org's metered cost this month against its plan MRR).
// The app has no platform-admin identity, so this is gated by a static bearer token
// (OPS_ADMIN_TOKEN) rather than a session — same convention as the waitlist admin read.
// Service-role so usage_monthly_v (member-RLS) can be read across all tenants; it reads
// aggregates only and never mutates. Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { listPlanPricing } from "@/server/services/billing/plans";
import { torontoMonthStart } from "@/server/services/usage";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/** Constant-time bearer-token check (mirrors the waitlist admin read). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface TenantCostRow {
  organizationId: string;
  name: string;
  plan: string;
  subscriptionStatus: string;
  mrrCents: number | null;
  costCents: number;
  marginCents: number | null;
}

const HEALTHY_STATUSES = new Set(["active", "trialing", "past_due"]);

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: TenantCostRow[]): string {
  const lines = ["organization_id,name,plan,subscription_status,mrr_cents,cost_cents,margin_cents"];
  for (const r of rows) {
    lines.push(
      [r.organizationId, r.name, r.plan, r.subscriptionStatus, r.mrrCents, r.costCents, r.marginCents]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.OPS_ADMIN_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "Ops report is not configured." }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !tokenMatches(token, expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const monthStart = torontoMonthStart();

  const { data: orgs, error: orgError } = await admin
    .from("organizations")
    .select("id, name, plan, subscription_status");
  if (orgError) {
    console.error("[ops/tenant-costs] org read failed:", orgError.message);
    return NextResponse.json({ error: "Could not read tenants." }, { status: 500 });
  }

  const { data: usage, error: usageError } = await admin
    .from("usage_monthly_v")
    .select("organization_id, cost_cents")
    .eq("month", monthStart);
  if (usageError) {
    console.error("[ops/tenant-costs] usage read failed:", usageError.message);
    return NextResponse.json({ error: "Could not read usage." }, { status: 500 });
  }

  // Plan → monthly MRR from Stripe (prices are the source of truth). Null if unconfigured.
  const pricing = await listPlanPricing();
  const planMrr = new Map(pricing.map((p) => [p.plan as string, p.amountCents]));

  const costByOrg = new Map<string, number>();
  for (const row of usage ?? []) {
    if (!row.organization_id) continue;
    costByOrg.set(row.organization_id, (costByOrg.get(row.organization_id) ?? 0) + Number(row.cost_cents ?? 0));
  }

  const rows: TenantCostRow[] = ((orgs ?? []) as Array<{
    id: string;
    name: string;
    plan: string;
    subscription_status: string;
  }>).map((org) => {
    const mrrCents = org.plan === "internal"
      ? 0
      : HEALTHY_STATUSES.has(org.subscription_status)
        ? planMrr.get(org.plan) ?? null
        : null;
    const costCents = costByOrg.get(org.id) ?? 0;
    return {
      organizationId: org.id,
      name: org.name,
      plan: org.plan,
      subscriptionStatus: org.subscription_status,
      mrrCents,
      costCents,
      marginCents: mrrCents != null ? mrrCents - costCents : null,
    };
  });
  rows.sort((a, b) => b.costCents - a.costCents);

  if (new URL(request.url).searchParams.get("format") === "csv") {
    return new NextResponse(toCsv(rows), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="tenant-costs.csv"',
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  }

  return NextResponse.json({ data: { month: monthStart, tenants: rows } });
}
