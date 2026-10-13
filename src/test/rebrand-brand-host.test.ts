import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { brandForHost, brandForOrg } from "@/lib/platform-brand";

// Everdoer rebrand PR 1: everdoer hosts get the lime (CrankLeads) brand until PR 2, and the
// inline pre-React host script in index.html must agree with brandForHost().

const HOSTS: Array<[string, "crankleads" | "empirevu"]> = [
  ["everdoer.com", "crankleads"],
  ["www.everdoer.com", "crankleads"],
  ["app.everdoer.com", "crankleads"],
  ["api.everdoer.com", "crankleads"],
  ["APP.Everdoer.com", "crankleads"],
  ["everdoer.localhost", "crankleads"],
  ["app.everdoer.localhost", "crankleads"],
  ["app.crankleads.com", "crankleads"],
  ["crankleads.com", "crankleads"],
  ["crankleads.localhost", "crankleads"],
  ["app.empirevu.com", "empirevu"],
  ["api.empirevu.com", "empirevu"],
  ["localhost", "empirevu"],
  ["quotes.a1marinecare.ca", "empirevu"],
  ["quotes.a1marinestorage.ca", "empirevu"],
  ["noteverdoer.com", "empirevu"],
  ["everdoer.com.evil.example", "empirevu"],
  ["everdoer.co", "empirevu"],
];

describe("brandForHost: everdoer hosts", () => {
  it.each(HOSTS)("%s → %s", (host, key) => {
    expect(brandForHost(host).key).toBe(key);
  });

  it("ignores a port and a trailing dot", () => {
    expect(brandForHost("app.everdoer.localhost:5173").key).toBe("crankleads");
    expect(brandForHost("app.everdoer.com.").key).toBe("crankleads");
  });
});

describe("index.html host script stays in sync with brandForHost", () => {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
  const match = html.match(/if \(!(\/.+\/)\.test\(h\)\) return;/);

  it("has the host regex", () => {
    expect(match).not.toBeNull();
  });

  const source = match?.[1] ?? "/^$/";
  const re = new RegExp(source.slice(1, -1));

  it.each(HOSTS)("%s", (host, key) => {
    // The script lowercases location.hostname (no port, no trailing dot) before testing.
    const scriptBrand = re.test(host.toLowerCase()) ? "crankleads" : "empirevu";
    expect(scriptBrand).toBe(key);
    expect(brandForHost(host).key).toBe(scriptBrand);
  });
});

describe("brandForOrg goes through the product line", () => {
  it("accepts old and Phase 3 platform_brand values", () => {
    expect(brandForOrg({ platform_brand: "done_for_you" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "standard" }).key).toBe("empirevu");
    expect(brandForOrg({ platform_brand: "crankleads" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "empirevu" }).key).toBe("empirevu");
    expect(brandForOrg({ platform_brand: " Done_For_You " }).key).toBe("crankleads");
  });

  it("still treats a done-for-you tier (old or Phase 3 column) as done for you", () => {
    expect(brandForOrg({ platform_brand: "standard", crankleads_tier: "catch" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: null, plan_tier: "close" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "bogus" }).key).toBe("empirevu");
    expect(brandForOrg(null).key).toBe("empirevu");
  });
});
