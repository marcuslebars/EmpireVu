import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import {
  extractAiUsage,
} from "@/server/ai/claude";
import { UsageCapExceeded } from "@/server/organizations/context";
import {
  getMonthlyUsage,
  getUsageForFeature,
  recordAiUsage,
  recordUsage,
  torontoMonthStart,
  type RecordUsageInput,
} from "@/server/services/usage";

// ── recordUsage: idempotency mechanism ───────────────────────────────────────

function upsertRecorder() {
  const upserts: Array<{ row: Record<string, unknown>; options: unknown }> = [];
  const admin = {
    from() {
      return {
        upsert(row: Record<string, unknown>, options: unknown) {
          upserts.push({ row, options });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { upserts, admin };
}

describe("recordUsage", () => {
  it("writes an idempotent insert keyed on (provider, provider_ref, kind)", async () => {
    const { upserts, admin } = upsertRecorder();
    const input: RecordUsageInput = {
      organizationId: "org-1",
      kind: "voice_minutes",
      quantity: 1.5,
      unit: "minutes",
      provider: "retell",
      providerRef: "call_abc",
    };
    await recordUsage(admin as never, input);
    // A duplicate webhook delivery: same ref → same do-nothing upsert, recorded once by the DB.
    await recordUsage(admin as never, input);

    expect(upserts).toHaveLength(2);
    for (const u of upserts) {
      expect(u.options).toEqual({ onConflict: "provider,provider_ref,kind", ignoreDuplicates: true });
      expect(u.row).toMatchObject({ provider: "retell", provider_ref: "call_abc", kind: "voice_minutes", quantity: 1.5 });
    }
  });
});

// ── recordAiUsage: token + cost math from a response ──────────────────────────

describe("extractAiUsage + recordAiUsage", () => {
  const response = {
    id: "msg_123",
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;

  it("pulls the metering fields off a model response", () => {
    const meta = extractAiUsage(response, "fallback-model");
    expect(meta).toEqual({
      responseId: "msg_123",
      model: "claude-opus-4-8",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
    });
  });

  it("records the three token kinds with default-rate costs, all sharing the response id", async () => {
    const { upserts, admin } = upsertRecorder();
    const meta = extractAiUsage(response, "m");
    await recordAiUsage(admin as never, { organizationId: "org-1", ...meta });

    const byKind = Object.fromEntries(upserts.map((u) => [u.row.kind, u.row]));
    // Default rates: input $5, output $25, cache-read $0.50 per MTok → cents for 1M tokens.
    expect(byKind.ai_input_tokens).toMatchObject({ quantity: 1_000_000, cost_cents: 500, provider_ref: "msg_123" });
    expect(byKind.ai_output_tokens).toMatchObject({ quantity: 1_000_000, cost_cents: 2500, provider_ref: "msg_123" });
    expect(byKind.ai_cache_read_tokens).toMatchObject({ quantity: 1_000_000, cost_cents: 50, provider_ref: "msg_123" });
  });

  it("folds cache-creation cost into the input event and skips zero-quantity kinds", async () => {
    const { upserts, admin } = upsertRecorder();
    await recordAiUsage(admin as never, {
      organizationId: "org-1",
      responseId: "msg_x",
      model: "m",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 },
    });
    // output & cache_read are zero → skipped; only the input event is written.
    expect(upserts).toHaveLength(1);
    // input $5 (500¢) + cache-write $6.25 (625¢) = 1125¢.
    expect(upserts[0].row).toMatchObject({ kind: "ai_input_tokens", cost_cents: 1125 });
  });
});

// ── month bucketing in America/Toronto ───────────────────────────────────────

describe("torontoMonthStart", () => {
  it("buckets a UTC instant into the correct LOCAL (Toronto) month across a boundary", () => {
    // 2026-10-01 02:00 UTC is 2026-09-30 22:00 in Toronto (EDT, -4) → September.
    expect(torontoMonthStart(new Date("2026-10-01T02:00:00Z"))).toBe("2026-09-01");
    // 2026-10-01 12:00 UTC is 2026-10-01 08:00 Toronto → October.
    expect(torontoMonthStart(new Date("2026-10-01T12:00:00Z"))).toBe("2026-10-01");
  });

  it("normalizes a 'YYYY-MM' string to the first of that month", () => {
    expect(torontoMonthStart("2026-09")).toBe("2026-09-01");
  });
});

// ── reads: monthly rollup + per-feature total ────────────────────────────────

function readClient(rows: Array<Record<string, unknown>>) {
  return {
    from() {
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const result = Promise.resolve({ data: rows, error: null });
              return (onF: unknown, onR: unknown) => result.then(onF as never, onR as never);
            }
            return () => chain;
          },
        },
      );
      return chain;
    },
  };
}

describe("getMonthlyUsage / getUsageForFeature", () => {
  it("sums a kind across companies for the month", async () => {
    const client = readClient([
      { kind: "voice_minutes", quantity: 120, cost_cents: 300, company_id: "c1" },
      { kind: "voice_minutes", quantity: 80, cost_cents: 200, company_id: "c2" },
      { kind: "sms_sent", quantity: 5, cost_cents: 0, company_id: "c1" },
    ]);
    const rows = await getMonthlyUsage(client as never, "org-1");
    expect(rows).toHaveLength(3);

    // marina_reception → voice_minutes; summed across both companies.
    expect(await getUsageForFeature(client as never, "org-1", "marina_reception")).toBe(200);
    expect(await getUsageForFeature(client as never, "org-1", "sms_sequences")).toBe(5);
  });
});

// ── requireFeature usage-cap enforcement ─────────────────────────────────────

describe("requireFeature — usage cap (Task 6)", () => {
  it("throws UsageCapExceeded when a Front Desk org has spent its 500 voice minutes", async () => {
    // Route each table to its data via a table-aware fake.
    const supabase = tableAwareClient({
      organizations: { plan: "front_desk", subscription_status: "active", trial_ends_at: null },
      subscriptions: null,
      feature_flags: null,
      usage_monthly_v: [{ kind: "voice_minutes", quantity: 500, cost_cents: 0, company_id: null }],
    });
    const { requireFeature } = await import("@/server/services/billing/gating");
    await expect(requireFeature(supabase as never, "org-1", "marina_reception")).rejects.toBeInstanceOf(
      UsageCapExceeded,
    );
  });

  it("passes when under the cap", async () => {
    const supabase = tableAwareClient({
      organizations: { plan: "front_desk", subscription_status: "active", trial_ends_at: null },
      subscriptions: null,
      feature_flags: null,
      usage_monthly_v: [{ kind: "voice_minutes", quantity: 100, cost_cents: 0, company_id: null }],
    });
    const { requireFeature } = await import("@/server/services/billing/gating");
    await expect(requireFeature(supabase as never, "org-1", "marina_reception")).resolves.toBeUndefined();
  });

  it("never caps an internal (unlimited) org", async () => {
    const supabase = tableAwareClient({
      organizations: { plan: "internal", subscription_status: "active", trial_ends_at: null },
      usage_monthly_v: [{ kind: "voice_minutes", quantity: 99999, cost_cents: 0, company_id: null }],
    });
    const { requireFeature } = await import("@/server/services/billing/gating");
    await expect(requireFeature(supabase as never, "org-1", "marina_reception")).resolves.toBeUndefined();
  });
});

// A fake that returns per-table data for both `.maybeSingle()` and awaited queries.
function tableAwareClient(tables: Record<string, unknown>) {
  return {
    from(table: string) {
      const result = Promise.resolve({ data: tables[table] ?? null, error: null });
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "maybeSingle" || prop === "single") return () => result;
            if (prop === "then") return (onF: unknown, onR: unknown) => result.then(onF as never, onR as never);
            return () => chain;
          },
        },
      );
      return chain;
    },
  };
}
