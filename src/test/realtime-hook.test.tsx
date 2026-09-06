import { beforeEach, describe, expect, it, vi } from "vitest";

let fakeClient: FakeClient | null;
vi.mock("@/lib/supabase", () => ({ getSupabaseBrowserClient: () => fakeClient }));

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { invalidateOrgRealtimeQueries, subscribeOrgRealtime, useOrgRealtime } from "@/lib/realtime";

interface OnCall {
  filter: Record<string, unknown>;
  cb: (payload: unknown) => void;
}

// A stand-in for the Supabase realtime client that records .on registrations.
class FakeClient {
  channelName: string | null = null;
  onCalls: OnCall[] = [];
  subscribed = false;
  removed = 0;
  channel(name: string) {
    this.channelName = name;
    return this;
  }
  on(_event: string, filter: Record<string, unknown>, cb: (payload: unknown) => void) {
    this.onCalls.push({ filter, cb });
    return this;
  }
  subscribe() {
    this.subscribed = true;
    return this;
  }
  removeChannel() {
    this.removed += 1;
  }
  fireFirstInsert() {
    this.onCalls[0]?.cb({ eventType: "INSERT" });
  }
}

beforeEach(() => {
  fakeClient = null;
});

describe("subscribeOrgRealtime", () => {
  it("subscribes to activity_events + message_log, org-filtered, and fires onChange on insert", () => {
    const client = new FakeClient();
    const onChange = vi.fn();

    const unsubscribe = subscribeOrgRealtime(client as never, "org-1", onChange);

    expect(client.channelName).toBe("org-realtime:org-1");
    expect(client.subscribed).toBe(true);
    expect(client.onCalls.map((c) => c.filter.table)).toEqual(["activity_events", "message_log"]);
    for (const call of client.onCalls) {
      expect(call.filter.filter).toBe("organization_id=eq.org-1");
      expect(call.filter.event).toBe("INSERT");
    }

    client.onCalls[1].cb({});
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(client.removed).toBe(1);
  });
});

describe("invalidateOrgRealtimeQueries", () => {
  it("invalidates the dashboard, crm, and jobs families", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");

    invalidateOrgRealtimeQueries(qc, "org-1");

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["dashboard"]);
    expect(keys).toContainEqual(["crm"]);
    expect(keys).toContainEqual(["automations", "jobs", "org-1"]);
  });
});

describe("useOrgRealtime", () => {
  it("invalidates queries when a realtime insert fires", () => {
    const client = new FakeClient();
    fakeClient = client;
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);

    renderHook(() => useOrgRealtime("org-1"), { wrapper });

    expect(client.subscribed).toBe(true);
    spy.mockClear();

    client.fireFirstInsert();
    expect(spy).toHaveBeenCalled();
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["dashboard"]);
  });

  it("does nothing without an org id", () => {
    const client = new FakeClient();
    fakeClient = client;
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);

    renderHook(() => useOrgRealtime(""), { wrapper });
    expect(client.subscribed).toBe(false);
  });
});
