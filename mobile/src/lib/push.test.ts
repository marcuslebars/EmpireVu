import { describe, expect, it, vi } from "vitest";

vi.mock("@m/lib/api", () => ({ apiRequest: vi.fn() }));

import { routeForPush } from "@m/lib/push";

describe("routeForPush", () => {
  it("opens a lead inside the Inbox tab", () => {
    expect(routeForPush({ screen: "lead", recordId: "c1" })).toEqual({ tab: "inbox", routes: [{ name: "lead", contactId: "c1" }] });
  });

  it("stacks quotes under More so Back returns to the list", () => {
    expect(routeForPush({ screen: "quote", recordId: "q1" })).toEqual({ tab: "more", routes: [{ name: "quotes" }, { name: "quote", quoteId: "q1" }] });
  });

  it("falls back to a tab root when there is no record", () => {
    expect(routeForPush({ screen: "booking" })).toEqual({ tab: "calendar", routes: [] });
    expect(routeForPush({ screen: "tasks" })).toEqual({ tab: "tasks", routes: [] });
  });

  it("sends unknown screens Home", () => {
    expect(routeForPush({ screen: "something-new" })).toEqual({ tab: "home", routes: [] });
  });
});
