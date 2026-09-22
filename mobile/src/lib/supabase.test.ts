import { AuthApiError, AuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  SecureStorage: { get: vi.fn(async () => null), set: vi.fn(async () => undefined), remove: vi.fn(async () => true) },
}));
vi.mock("@m/lib/env", () => ({ env: { supabaseUrl: "https://test.supabase.co", supabaseAnonKey: "anon" } }));

import { classifyRestore, getAccessToken, noteSignedOut, refreshTokenRejected, restoreSession, supabase } from "@m/lib/supabase";

function session(expiresInSeconds: number, token = "access"): Session {
  return {
    access_token: token,
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: expiresInSeconds,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    user: { id: "u1", app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "" },
  };
}

describe("classifyRestore", () => {
  it("keeps a stored session whose refresh failed on the network as unreachable", () => {
    expect(classifyRestore(null, new AuthRetryableFetchError("Failed to fetch", 0))).toEqual({ kind: "unreachable" });
    expect(classifyRestore(null, new AuthRetryableFetchError("Bad gateway", 502))).toEqual({ kind: "unreachable" });
  });

  it("treats a rejected refresh token as signed out", () => {
    expect(classifyRestore(null, new AuthApiError("Invalid Refresh Token: Already Used", 400, "refresh_token_already_used"))).toEqual({ kind: "none" });
  });

  it("treats an empty store as signed out", () => {
    expect(classifyRestore(null, null)).toEqual({ kind: "none" });
  });

  it("returns a usable session", () => {
    const s = session(3600);
    expect(classifyRestore(s, null)).toEqual({ kind: "session", session: s });
  });
});

describe("refreshTokenRejected", () => {
  it("only counts server rejections", () => {
    expect(refreshTokenRejected({ status: 400, message: "Invalid Refresh Token" })).toBe(true);
    expect(refreshTokenRejected({ status: 0, message: "Failed to fetch" })).toBe(false);
    expect(refreshTokenRejected({ status: 503, message: "Service unavailable" })).toBe(false);
    expect(refreshTokenRejected(null)).toBe(false);
  });
});

describe("getAccessToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    noteSignedOut();
  });

  it("serves a fresh token from memory instead of re-reading the secure store", async () => {
    const getSession = vi.spyOn(supabase.auth, "getSession").mockResolvedValue({ data: { session: session(3600) }, error: null });
    await restoreSession();
    expect(await getAccessToken()).toBe("access");
    expect(await getAccessToken()).toBe("access");
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("goes back to getSession (which refreshes) when the cached token is about to expire", async () => {
    const getSession = vi
      .spyOn(supabase.auth, "getSession")
      .mockResolvedValueOnce({ data: { session: session(30, "old") }, error: null })
      .mockResolvedValueOnce({ data: { session: session(3600, "new") }, error: null });
    await restoreSession();
    expect(await getAccessToken()).toBe("new");
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("forgets the cached token on sign-out", async () => {
    const getSession = vi.spyOn(supabase.auth, "getSession").mockResolvedValue({ data: { session: session(3600) }, error: null });
    await restoreSession();
    noteSignedOut();
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await getAccessToken()).toBeNull();
  });
});
