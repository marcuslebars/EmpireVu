/**
 * Native mobile app auth: Bearer tokens on the API and CORS for the Capacitor origins.
 *
 * The web SPA keeps using the same-origin cookie; these tests pin that the cookie path
 * is untouched when no Authorization header is present, that a Bearer token produces a
 * client acting as that user, and that only the app origins get CORS headers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requestHeaders = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
  cookies: () => ({ getAll: () => [], set: () => undefined }),
}));

const createClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({ createClient: (...args: unknown[]) => createClient(...args) }));

const createServerClient = vi.fn((..._args: unknown[]) => ({ kind: "cookie-client" }));
vi.mock("@supabase/ssr", () => ({ createServerClient: (...args: unknown[]) => createServerClient(...args) }));

import { createSupabaseServerClient, readBearerToken } from "@/server/supabase/server";
import { allowedCorsOrigins, corsHeadersFor } from "@/server/api/cors";
import { middleware } from "@/middleware";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
});

afterEach(() => {
  requestHeaders.clear();
  createClient.mockReset();
  createServerClient.mockClear();
  vi.unstubAllEnvs();
});

describe("readBearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(readBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(readBearerToken("bearer   abc")).toBe("abc");
  });

  it("ignores missing or non-Bearer headers", () => {
    expect(readBearerToken(null)).toBeNull();
    expect(readBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(readBearerToken("Bearer")).toBeNull();
  });
});

describe("createSupabaseServerClient", () => {
  it("uses the cookie client when there is no Authorization header", () => {
    const client = createSupabaseServerClient();
    expect(client).toEqual({ kind: "cookie-client" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("acts as the token's user when a Bearer token is sent", async () => {
    const getUser = vi.fn(async (jwt?: string) => ({ data: { user: { id: `user-for-${jwt}` } }, error: null }));
    createClient.mockReturnValue({ auth: { getUser } });
    requestHeaders.set("authorization", "Bearer token-123");

    const client = createSupabaseServerClient();

    expect(createServerClient).not.toHaveBeenCalled();
    const [, , options] = createClient.mock.calls[0] as [string, string, { global: { headers: Record<string, string> }; auth: Record<string, boolean> }];
    expect(options.global.headers.Authorization).toBe("Bearer token-123");
    expect(options.auth.persistSession).toBe(false);

    // getAuthenticatedUser calls getUser() with no argument — it must validate the request's token.
    const { data } = await client.auth.getUser();
    expect(getUser).toHaveBeenCalledWith("token-123");
    expect(data.user?.id).toBe("user-for-token-123");
  });
});

describe("API CORS", () => {
  it("allows the Capacitor origins and extra configured origins", () => {
    expect(corsHeadersFor("capacitor://localhost")?.["Access-Control-Allow-Origin"]).toBe("capacitor://localhost");
    expect(corsHeadersFor("https://localhost")?.["Access-Control-Allow-Origin"]).toBe("https://localhost");
    expect(allowedCorsOrigins("https://staging.example.com/, ")).toContain("https://staging.example.com");
  });

  it("refuses other origins and never allows credentials", () => {
    expect(corsHeadersFor("https://evil.example.com")).toBeNull();
    expect(corsHeadersFor(null)).toBeNull();
    expect(corsHeadersFor("capacitor://localhost")).not.toHaveProperty("Access-Control-Allow-Credentials");
  });

  it("answers an allowed preflight with 204", async () => {
    const req = new NextRequest("https://empirevu.com/api/organizations/org/inbox", {
      method: "OPTIONS",
      headers: { origin: "capacitor://localhost" },
    });
    const res = await middleware(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("adds CORS headers to allowed API requests but not to others", async () => {
    const allowed = await middleware(
      new NextRequest("https://empirevu.com/api/session/context", { headers: { origin: "https://localhost" } }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://localhost");

    const other = await middleware(
      new NextRequest("https://empirevu.com/api/session/context", { headers: { origin: "https://evil.example.com" } }),
    );
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
