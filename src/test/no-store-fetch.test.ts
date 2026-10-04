import { afterEach, describe, expect, it, vi } from "vitest";

import { noStoreFetch } from "@/server/supabase/no-store-fetch";

/**
 * Next.js caches GET fetches made in route handlers. Supabase reads must never be served
 * from that cache (a paid invoice still showing "due", a revoked link still working), so
 * every Supabase client goes through noStoreFetch.
 */
describe("noStoreFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("always asks for an uncached request and keeps the caller's options", async () => {
    const spy = vi.fn((..._a: unknown[]) => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", spy);
    await noStoreFetch("https://db.test/rest/v1/invoices", { method: "GET", headers: { apikey: "k" }, cache: "force-cache" });
    expect(spy).toHaveBeenCalledWith("https://db.test/rest/v1/invoices", { method: "GET", headers: { apikey: "k" }, cache: "no-store" });
  });

  it("is wired into the admin client", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/server/supabase/admin.ts", "utf8"));
    expect(src).toContain("fetch: noStoreFetch");
    const server = await import("node:fs").then((fs) => fs.readFileSync("src/server/supabase/server.ts", "utf8"));
    expect(server.match(/fetch: noStoreFetch/g)?.length).toBe(2);
  });
});
