/**
 * Supabase admin key: prefers the new secret key (sb_secret_…), falls back to the legacy
 * service_role JWT only during the switch-over, refuses a publishable key in the secret slot,
 * and no secret ever has a browser-exposed (VITE_ / NEXT_PUBLIC_) name anywhere in the repo.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSupabaseSecretKey, supabaseSecretKeySource } from "@/server/supabase/env";

afterEach(() => vi.unstubAllEnvs());

describe("getSupabaseSecretKey", () => {
  it("prefers SUPABASE_SECRET_KEY over the legacy service_role key", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_abc");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "eyJlegacy");
    expect(getSupabaseSecretKey()).toBe("sb_secret_abc");
    expect(supabaseSecretKeySource()).toBe("SUPABASE_SECRET_KEY");
  });

  it("falls back to SUPABASE_SERVICE_ROLE_KEY while the secret key is unset", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "eyJlegacy");
    expect(getSupabaseSecretKey()).toBe("eyJlegacy");
    expect(supabaseSecretKeySource()).toBe("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("refuses a publishable key in the secret slot", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_publishable_oops");
    expect(() => getSupabaseSecretKey()).toThrow(/publishable/);
  });

  it("throws a clear error when neither is set", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => getSupabaseSecretKey()).toThrow(/SUPABASE_SECRET_KEY/);
    expect(supabaseSecretKeySource()).toBeNull();
  });
});

describe("no secret has a browser-exposed name", () => {
  const PUBLIC_SECRET = /\b(?:VITE|NEXT_PUBLIC)_[A-Z0-9_]*(?:SERVICE_ROLE|SECRET)[A-Z0-9_]*\b/g;
  const ROOTS = ["src", "mobile/src", "scripts"];
  const SKIP = /(^|\/)test(\/|$)|\.test\.tsx?$/;

  function files(dir: string): string[] {
    let out: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out = out.concat(files(p));
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
    }
    return out;
  }

  it("source and .env.example never name a VITE_/NEXT_PUBLIC_ secret", () => {
    const hits: string[] = [];
    for (const f of [...ROOTS.flatMap(files), ".env.example"]) {
      if (SKIP.test(f.replace(/\\/g, "/"))) continue;
      for (const m of readFileSync(f, "utf8").matchAll(PUBLIC_SECRET)) hits.push(`${f}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});
