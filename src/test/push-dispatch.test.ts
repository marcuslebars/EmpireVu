/**
 * Push fan-out: preferences and quiet hours are enforced server-side, tokens the provider
 * reports as unregistered are revoked, and a missing provider config sends nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { inQuietHours, sendPushToOrganization, type PushMessage, type PushSenders } from "@/server/services/push/dispatch";

type Row = Record<string, unknown>;

function fakeAdmin(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; values: Row; ids: unknown[] }> = [];
  const client = {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let pendingUpdate: Row | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          if (pendingUpdate) updates.push({ table, values: pendingUpdate, ids: values });
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        update: (values: Row) => {
          pendingUpdate = values;
          return builder;
        },
        then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: (tables[table] ?? []).filter((row) => filters.every((f) => f(row))), error: null }).then(onFulfilled),
      };
      return builder;
    },
  };
  return { client: client as unknown as Parameters<typeof sendPushToOrganization>[0], updates };
}

const ORG = "org-1";
const message = (overrides: Partial<PushMessage> = {}): PushMessage => ({
  title: "New lead — Dana Whitcombe",
  body: "Marina took the call.",
  category: "leads",
  data: { screen: "lead", recordId: "contact-1", organizationId: ORG, companyId: "co-1" },
  ...overrides,
});

const tokens = [
  { id: "t1", token: "ios-token-a", platform: "ios", user_id: "u1", organization_id: ORG, revoked_at: null },
  { id: "t2", token: "android-token-b", platform: "android", user_id: "u2", organization_id: ORG, revoked_at: null },
  { id: "t3", token: "ios-token-c", platform: "ios", user_id: "u3", organization_id: ORG, revoked_at: "2026-09-01T00:00:00Z" },
  { id: "t4", token: "ios-token-other-org", platform: "ios", user_id: "u1", organization_id: "org-2", revoked_at: null },
];

function senders(outcomes: Record<string, "sent" | "unregistered" | "failed"> = {}): PushSenders & { calls: string[] } {
  const calls: string[] = [];
  const send = vi.fn(async (token: string) => {
    calls.push(token);
    return outcomes[token] ?? "sent";
  });
  return { ios: send, android: send, calls };
}

describe("sendPushToOrganization", () => {
  it("sends to the organization's active tokens only", async () => {
    const { client } = fakeAdmin({ device_tokens: tokens, notification_preferences: [] });
    const s = senders();
    const result = await sendPushToOrganization(client, ORG, message(), { senders: s });
    expect(s.calls.sort()).toEqual(["android-token-b", "ios-token-a"]);
    expect(result).toMatchObject({ sent: 2, skipped: 0, revoked: 0 });
  });

  it("respects category opt-outs and the workflow-failure default of off", async () => {
    const { client } = fakeAdmin({
      device_tokens: tokens,
      notification_preferences: [{ user_id: "u1", organization_id: ORG, leads: false, drafts: true, payments: true, conflicts: true, workflow_failures: false, daily_digest: true, quiet_hours_start: null, quiet_hours_end: null, timezone: null }],
    });
    const s = senders();
    await sendPushToOrganization(client, ORG, message(), { senders: s });
    expect(s.calls).toEqual(["android-token-b"]);

    const s2 = senders();
    const result = await sendPushToOrganization(client, ORG, message({ category: "workflow_failures" }), { senders: s2 });
    expect(s2.calls).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it("holds non-urgent pushes during quiet hours but lets urgent ones through", async () => {
    const prefs = { user_id: "u1", organization_id: ORG, leads: true, drafts: true, payments: true, conflicts: true, workflow_failures: false, daily_digest: true, quiet_hours_start: "21:00:00", quiet_hours_end: "06:30:00", timezone: "America/Toronto" };
    const { client } = fakeAdmin({ device_tokens: tokens.slice(0, 1), notification_preferences: [prefs] });
    const lateNight = new Date("2026-09-13T03:00:00Z"); // 23:00 in Toronto

    const quiet = senders();
    await sendPushToOrganization(client, ORG, message(), { senders: quiet, now: lateNight });
    expect(quiet.calls).toEqual([]);

    const urgent = senders();
    await sendPushToOrganization(client, ORG, message({ urgent: true }), { senders: urgent, now: lateNight });
    expect(urgent.calls).toEqual(["ios-token-a"]);
  });

  it("revokes tokens the provider reports as unregistered", async () => {
    const { client, updates } = fakeAdmin({ device_tokens: tokens, notification_preferences: [] });
    const result = await sendPushToOrganization(client, ORG, message(), { senders: senders({ "ios-token-a": "unregistered" }) });
    expect(result.revoked).toBe(1);
    expect(updates).toEqual([{ table: "device_tokens", values: expect.objectContaining({ revoked_at: expect.any(String) }), ids: ["t1"] }]);
  });

  it("does nothing when no push provider is configured", async () => {
    const { client } = fakeAdmin({ device_tokens: tokens, notification_preferences: [] });
    const result = await sendPushToOrganization(client, ORG, message(), { senders: { ios: null, android: null } });
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0, revoked: 0 });
  });
});

describe("inQuietHours", () => {
  const window = { quiet_hours_start: "21:00", quiet_hours_end: "06:30", timezone: "America/Toronto" };

  it("handles windows that wrap midnight", () => {
    expect(inQuietHours(window, new Date("2026-09-13T02:00:00Z"), "UTC")).toBe(true); // 22:00 local
    expect(inQuietHours(window, new Date("2026-09-13T10:00:00Z"), "UTC")).toBe(true); // 06:00 local
    expect(inQuietHours(window, new Date("2026-09-13T16:00:00Z"), "UTC")).toBe(false); // 12:00 local
  });

  it("is off without a window", () => {
    expect(inQuietHours(undefined, new Date(), "UTC")).toBe(false);
    expect(inQuietHours({ quiet_hours_start: null, quiet_hours_end: null, timezone: null }, new Date(), "UTC")).toBe(false);
  });
});
