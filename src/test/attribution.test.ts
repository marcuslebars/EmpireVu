import { describe, expect, it, vi } from "vitest";

import {
  deriveFirstTouch,
  getAttributionSummary,
  listAttribution,
  monthRangeInTimeZone,
} from "@/server/services/attribution";
import type { TenantServiceContext } from "@/server/services/shared";

// ── first_touch rule (mirrors revenue_attribution_v) ──────────────────────────

describe("deriveFirstTouch", () => {
  it("picks the earliest touch across lead → call → message (golden)", () => {
    const touch = deriveFirstTouch({
      rawLeads: [{ createdAt: "2026-09-01T09:00:00.000Z", source: "website_form", sourceSite: null }],
      inboundCalls: [{ at: "2026-09-01T10:00:00.000Z" }],
      inboundMessages: [{ createdAt: "2026-09-01T11:00:00.000Z", channel: "sms" }],
      contactCreatedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(touch).toEqual({ source: "website_form", channel: "web", at: "2026-09-01T09:00:00.000Z" });
  });

  it("breaks an exact-timestamp tie in favour of raw_leads (rank 0 < voice 1 < message 2)", () => {
    const tied = "2026-09-01T10:00:00.000Z";
    const touch = deriveFirstTouch({
      rawLeads: [{ createdAt: tied, source: null, sourceSite: "bayside.example" }],
      inboundCalls: [{ at: tied }],
      inboundMessages: [{ createdAt: tied, channel: "email" }],
      contactCreatedAt: "2026-08-15T00:00:00.000Z",
    });
    // coalesce(source, source_site, 'web') → the site, and web wins the tie.
    expect(touch).toEqual({ source: "bayside.example", channel: "web", at: tied });
  });

  it("falls back to the contact's created_at as a manual touch when there are none", () => {
    const touch = deriveFirstTouch({
      rawLeads: [],
      inboundCalls: [],
      inboundMessages: [],
      contactCreatedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(touch).toEqual({ source: "manual", channel: "manual", at: "2026-08-15T00:00:00.000Z" });
  });

  it("maps inbound voice and message channels the same way the view does", () => {
    const voice = deriveFirstTouch({
      rawLeads: [],
      inboundCalls: [{ at: "2026-09-01T08:00:00.000Z" }],
      inboundMessages: [{ createdAt: "2026-09-01T09:00:00.000Z", channel: "email" }],
      contactCreatedAt: null,
    });
    expect(voice).toEqual({ source: "retell", channel: "voice", at: "2026-09-01T08:00:00.000Z" });

    const email = deriveFirstTouch({
      rawLeads: [],
      inboundCalls: [],
      inboundMessages: [{ createdAt: "2026-09-01T09:00:00.000Z", channel: "email" }],
      contactCreatedAt: null,
    });
    expect(email).toEqual({ source: "email", channel: "email", at: "2026-09-01T09:00:00.000Z" });

    const sms = deriveFirstTouch({
      rawLeads: [],
      inboundCalls: [],
      inboundMessages: [{ createdAt: "2026-09-01T09:00:00.000Z", channel: "sms" }],
      contactCreatedAt: null,
    });
    expect(sms).toEqual({ source: "sms", channel: "sms", at: "2026-09-01T09:00:00.000Z" });
  });
});

// ── Period boundaries (DST-safe, America/Toronto golden) ──────────────────────

describe("monthRangeInTimeZone", () => {
  it("brackets a DST-straddling month at local midnight (America/Toronto, March 2026)", () => {
    // March 15 2026 is EDT; the month opens in EST (UTC-5) and the next month opens in
    // EDT (UTC-4) because DST began March 8 2026 — the boundaries must reflect both.
    const range = monthRangeInTimeZone("America/Toronto", Date.parse("2026-03-15T12:00:00.000Z"));
    expect(range.from).toBe("2026-03-01T05:00:00.000Z"); // Mar 1 00:00 EST
    expect(range.to).toBe("2026-04-01T04:00:00.000Z"); // Apr 1 00:00 EDT
  });

  it("uses standard time on both sides for a non-DST month (America/Toronto, January 2026)", () => {
    const range = monthRangeInTimeZone("America/Toronto", Date.parse("2026-01-15T12:00:00.000Z"));
    expect(range.from).toBe("2026-01-01T05:00:00.000Z");
    expect(range.to).toBe("2026-02-01T05:00:00.000Z");
  });

  it("is identity-simple in UTC", () => {
    const range = monthRangeInTimeZone("UTC", Date.parse("2026-09-12T00:00:00.000Z"));
    expect(range.from).toBe("2026-09-01T00:00:00.000Z");
    expect(range.to).toBe("2026-10-01T00:00:00.000Z");
  });
});

// ── Service call-shape (mocked supabase) ──────────────────────────────────────

interface SupabaseMockOptions {
  rpcRow?: Record<string, unknown>;
  viewRows?: Array<Record<string, unknown>>;
  onRpc?: (name: string, params: Record<string, unknown>) => void;
}

function makeContext(options: SupabaseMockOptions): TenantServiceContext {
  const supabase = {
    rpc: (name: string, params: Record<string, unknown>) => {
      options.onRpc?.(name, params);
      return Promise.resolve({ data: options.rpcRow ? [options.rpcRow] : [], error: null });
    },
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        limit: () => Promise.resolve({ data: options.viewRows ?? [], error: null }),
      };
      return builder;
    },
  };
  return {
    organizationId: "org-1",
    actorProfileId: null,
    supabase: supabase as unknown as TenantServiceContext["supabase"],
  };
}

describe("getAttributionSummary", () => {
  it("calls ui_attribution_summary and maps the aggregate row (incl. breakdown ordering)", async () => {
    const onRpc = vi.fn();
    const context = makeContext({
      onRpc,
      rpcRow: {
        quotes_count: 3,
        approved_cents_total: 500_000,
        paid_cents_total: 150_000,
        voice_ai_count: 2,
        voice_ai_approved_cents: 400_000,
        voice_ai_paid_cents: 120_000,
        automation_count: 1,
        automation_approved_cents: 100_000,
        automation_paid_cents: 30_000,
        estimated_time_saved_seconds: 3600,
        by_source: {
          retell: { count: 1, approved_cents: 100_000, paid_cents: 30_000 },
          web: { count: 2, approved_cents: 400_000, paid_cents: 120_000 },
        },
        by_channel: {
          voice: { count: 1, approved_cents: 100_000, paid_cents: 30_000 },
          web: { count: 2, approved_cents: 400_000, paid_cents: 120_000 },
        },
      },
    });

    const summary = await getAttributionSummary(context, { from: "2026-09-01T04:00:00.000Z", to: "2026-10-01T04:00:00.000Z" });

    expect(onRpc).toHaveBeenCalledWith("ui_attribution_summary", {
      p_org_id: "org-1",
      p_company_id: undefined,
      p_from: "2026-09-01T04:00:00.000Z",
      p_to: "2026-10-01T04:00:00.000Z",
    });
    expect(summary.quotesCount).toBe(3);
    expect(summary.paidCentsTotal).toBe(150_000);
    expect(summary.voiceAi).toEqual({ count: 2, approvedCents: 400_000, paidCents: 120_000 });
    expect(summary.automation).toEqual({ count: 1, approvedCents: 100_000, paidCents: 30_000 });
    expect(summary.estimatedTimeSavedSeconds).toBe(3600);
    // Highest paid first.
    expect(summary.bySource.map((entry) => entry.key)).toEqual(["web", "retell"]);
    expect(summary.bySource[0]).toEqual({ key: "web", count: 2, approvedCents: 400_000, paidCents: 120_000 });
  });

  it("returns zeroed totals when the RPC yields no row", async () => {
    const summary = await getAttributionSummary(makeContext({}), {});
    expect(summary.quotesCount).toBe(0);
    expect(summary.paidCentsTotal).toBe(0);
    expect(summary.bySource).toEqual([]);
    expect(summary.byChannel).toEqual([]);
  });
});

describe("listAttribution", () => {
  it("maps view rows to camelCase and orders most-recently-closed first", async () => {
    const context = makeContext({
      viewRows: [
        {
          quote_id: "q-early",
          contact_id: "c-1",
          company_id: "co-1",
          auto_generated: false,
          first_touch_source: "web",
          first_touch_channel: "web",
          first_touch_at: "2026-09-02T00:00:00.000Z",
          voice_ai_involved: true,
          automation_involved: false,
          approved_cents: 100_000,
          paid_cents: 30_000,
          approved_at: "2026-09-05T00:00:00.000Z",
          paid_at: "2026-09-06T00:00:00.000Z",
        },
        {
          quote_id: "q-late",
          contact_id: null,
          company_id: null,
          auto_generated: true,
          first_touch_source: "manual",
          first_touch_channel: "manual",
          first_touch_at: null,
          voice_ai_involved: false,
          automation_involved: true,
          approved_cents: 0,
          paid_cents: 50_000,
          approved_at: null,
          paid_at: "2026-09-20T00:00:00.000Z",
        },
      ],
    });

    const rows = await listAttribution(context, { from: "2026-09-01T04:00:00.000Z", to: "2026-10-01T04:00:00.000Z" });

    // q-late closes 2026-09-20 (paid), q-early closes 2026-09-05 (approved) → late first.
    expect(rows.map((row) => row.quoteId)).toEqual(["q-late", "q-early"]);
    expect(rows[0]).toEqual({
      quoteId: "q-late",
      contactId: null,
      companyId: null,
      autoGenerated: true,
      firstTouchSource: "manual",
      firstTouchChannel: "manual",
      firstTouchAt: null,
      voiceAiInvolved: false,
      automationInvolved: true,
      approvedCents: 0,
      paidCents: 50_000,
      approvedAt: null,
      paidAt: "2026-09-20T00:00:00.000Z",
    });
  });

  it("applies the client-side limit after sorting", async () => {
    const context = makeContext({
      viewRows: [
        { quote_id: "q-early", approved_at: "2026-09-05T00:00:00.000Z", paid_at: null, approved_cents: 1, paid_cents: 0 },
        { quote_id: "q-late", approved_at: "2026-09-25T00:00:00.000Z", paid_at: null, approved_cents: 1, paid_cents: 0 },
      ],
    });
    const rows = await listAttribution(context, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].quoteId).toBe("q-late");
  });
});
