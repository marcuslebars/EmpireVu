import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkConnectKey, signState, verifyState } from "@/server/services/jobber/connect";

describe("jobber connect: OAuth state (CSRF) + connect key", () => {
  const prev = process.env.JOBBER_CONNECT_SECRET;
  beforeEach(() => {
    process.env.JOBBER_CONNECT_SECRET = "connect-secret-123";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.JOBBER_CONNECT_SECRET;
    else process.env.JOBBER_CONNECT_SECRET = prev;
  });

  it("signs + verifies state bound to the org (round-trip)", () => {
    const state = signState("org-abc");
    expect(verifyState(state)).toBe("org-abc");
  });

  it("rejects tampered, malformed, or missing state", () => {
    const state = signState("org-abc");
    expect(verifyState(state.replace("org-abc", "org-evil"))).toBeNull();
    expect(verifyState("garbage")).toBeNull();
    expect(verifyState(null)).toBeNull();
  });

  it("state is single-use-shaped: two signs differ (nonce) yet both verify", () => {
    const a = signState("org-abc");
    const b = signState("org-abc");
    expect(a).not.toBe(b);
    expect(verifyState(a)).toBe("org-abc");
    expect(verifyState(b)).toBe("org-abc");
  });

  it("checkConnectKey compares against the secret (constant-time)", () => {
    expect(checkConnectKey("connect-secret-123")).toBe(true);
    expect(checkConnectKey("wrong")).toBe(false);
    expect(checkConnectKey(null)).toBe(false);
    expect(checkConnectKey("")).toBe(false);
  });
});
