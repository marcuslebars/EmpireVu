import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createFakeDb } from "./helpers/fake-supabase";
import { PRODUCT_LINE_DB_VALUES } from "@/lib/product-line";
import { leadNotifyAudience } from "@/server/services/lead-intake/notify";
import { signaturePrefix } from "@/server/services/owner-channel/common";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { isCrankleadsOrg, loadActiveCompanies } from "@/server/services/staff/bookkeeper/settings";
import { importUrlFor } from "@/server/services/staff/importer/links";
import { portLinkFor } from "@/server/services/staff/porting/service";
import { jobUrl } from "@/server/services/staff/recruiter/jobs";

// Everdoer rebrand PR 1: every read of organizations.platform_brand goes through the
// product-line shim, so the Phase 3 values ('done_for_you' / 'standard') behave exactly like
// today's ('crankleads' / 'empirevu').

const ROOT = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("no literal platform_brand reads remain", () => {
  const files = sourceFiles(ROOT).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));

  it("sweep filters use PRODUCT_LINE_DB_VALUES, never .eq/.neq on a literal", () => {
    const bad = files.flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\.(eq|neq)\(\s*"platform_brand"/.test(line))
        .map(({ n }) => `${f.path}:${n}`),
    );
    expect(bad).toEqual([]);
    const sweeps = files.filter((f) => f.text.includes('.in("platform_brand", [...PRODUCT_LINE_DB_VALUES.done_for_you])'));
    expect(sweeps.length).toBeGreaterThanOrEqual(10);
  });

  it("no `platform_brand === \"crankleads\"`-style comparisons on stored values", () => {
    const bad = files.flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
        .filter(({ line }) => /(platform_brand|platformBrand)\)?\s*(===|!==)\s*"(crankleads|empirevu)"/.test(line))
        .map(({ n }) => `${f.path}:${n}`),
    );
    expect(bad).toEqual([]);
  });
});

describe("sweeps pick up both stored values", () => {
  it("bookkeeper loadActiveCompanies includes 'crankleads' and 'done_for_you' orgs, not house orgs", async () => {
    const db = createFakeDb();
    db.tables.organizations = [
      { id: "o-old", platform_brand: "crankleads" },
      { id: "o-new", platform_brand: "done_for_you" },
      { id: "o-house", platform_brand: "empirevu" },
      { id: "o-house-new", platform_brand: "standard" },
    ];
    db.tables.companies = [
      { id: "c-old", organization_id: "o-old", timezone: null, ai_settings: {} },
      { id: "c-new", organization_id: "o-new", timezone: null, ai_settings: {} },
      { id: "c-house", organization_id: "o-house", timezone: null, ai_settings: {} },
      { id: "c-house-new", organization_id: "o-house-new", timezone: null, ai_settings: {} },
    ];
    const got = await loadActiveCompanies(db.client);
    expect(got.map((c) => c.companyId).sort()).toEqual(["c-new", "c-old"]);
    expect(got.every((c) => c.crankleads)).toBe(true);
  });

  it("the filter values", () => {
    expect([...PRODUCT_LINE_DB_VALUES.done_for_you]).toEqual(["crankleads", "done_for_you"]);
  });
});

describe("readers treat old and new values the same", () => {
  it.each([
    ["crankleads", true],
    ["done_for_you", true],
    ["empirevu", false],
    ["standard", false],
    [null, false],
  ] as const)("%s → done for you: %s", (value, dfy) => {
    expect(signaturePrefix(value)).toBe(dfy ? "CrankLeads: " : "");
    expect(leadNotifyAudience({ platform_brand: value, crankleads_tier: null }, true) === "none").toBe(dfy);
    expect(isCrankleadsOrg({ platform_brand: value })).toBe(dfy);
  });

  it("links built from a stored value use the done-for-you host for either value", () => {
    const prev = { app: process.env.APP_BASE_URL, cl: process.env.CRANKLEADS_APP_BASE_URL, ev: process.env.EVERDOER_APP_BASE_URL };
    process.env.APP_BASE_URL = "https://app.empirevu.com";
    process.env.CRANKLEADS_APP_BASE_URL = "https://app.crankleads.com";
    delete process.env.EVERDOER_APP_BASE_URL;
    try {
      for (const value of ["crankleads", "done_for_you"]) {
        expect(importUrlFor(value, "tok")).toBe("https://app.crankleads.com/import/tok");
        expect(portLinkFor(value, "tok")).toBe("https://app.crankleads.com/port/tok");
        expect(jobUrl("acme", "job-1", value)).toBe("https://app.crankleads.com/s/acme/jobs/job-1");
        expect(quotePublicBaseUrlFor({ platform_brand: value })).toBe("https://app.crankleads.com");
      }
      for (const value of ["empirevu", "standard"]) {
        expect(importUrlFor(value, "tok")).toBe("https://app.empirevu.com/import/tok");
        expect(portLinkFor(value, "tok")).toBe("https://app.empirevu.com/port/tok");
      }
    } finally {
      for (const [k, v] of [
        ["APP_BASE_URL", prev.app],
        ["CRANKLEADS_APP_BASE_URL", prev.cl],
        ["EVERDOER_APP_BASE_URL", prev.ev],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
