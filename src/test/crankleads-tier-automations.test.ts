/**
 * CrankLeads: only the tier's automations may be active (crankleads/tier-automations.ts) — the
 * restriction itself and the one-off repair (dry run by default, --apply, idempotent).
 */
import { describe, expect, it } from "vitest";

import { createFakeDb } from "./helpers/fake-supabase";
import { tierAllowedRecipeSlugs } from "@/server/services/crankleads/config";
import { repairTierAutomations, restrictAutomationsToTier } from "@/server/services/crankleads/tier-automations";

const wf = (id: string, org: string, company: string, slug: string, status = "active") => ({ id, organization_id: org, company_id: company, slug, status });

function seed() {
  return createFakeDb({
    organizations: [
      { id: "org-catch", platform_brand: "crankleads", crankleads_tier: "catch" },
      { id: "org-close", platform_brand: "crankleads", crankleads_tier: "close" },
      { id: "org-house", platform_brand: "empirevu", crankleads_tier: null },
    ],
    companies: [
      { id: "c-catch", organization_id: "org-catch", industry_pack: null },
      { id: "c-close", organization_id: "org-close", industry_pack: null },
      { id: "c-house", organization_id: "org-house", industry_pack: null },
    ],
    workflows: [
      wf("w1", "org-catch", "c-catch", "missed-call-text-back"),
      wf("w2", "org-catch", "c-catch", "stale-lead-nudge"),
      wf("w3", "org-catch", "c-catch", "quote-follow-up"),
      wf("w4", "org-catch", "c-catch", "my-own-custom-flow"),
      wf("w5", "org-close", "c-close", "stale-lead-nudge"),
      wf("w6", "org-close", "c-close", "call-summary-to-owner"),
      wf("w7", "org-house", "c-house", "stale-lead-nudge"),
    ],
  });
}

describe("tier automations", () => {
  it("allowed set per tier", () => {
    expect(tierAllowedRecipeSlugs("catch", []).has("stale-lead-nudge")).toBe(false);
    expect(tierAllowedRecipeSlugs("close", []).has("stale-lead-nudge")).toBe(true);
    expect(tierAllowedRecipeSlugs("close", []).has("call-summary-to-owner")).toBe(false);
    expect(tierAllowedRecipeSlugs("front_desk", []).has("call-summary-to-owner")).toBe(true);
  });

  it("restrict: outside-tier catalog recipes → draft; allowed and custom workflows untouched", async () => {
    const db = seed();
    const ctx = { organizationId: "org-catch", actorProfileId: null, supabase: db.client } as never;
    const out = await restrictAutomationsToTier(ctx, "c-catch", "catch");
    expect(out.deactivated.sort()).toEqual(["quote-follow-up", "stale-lead-nudge"]);
    const status = Object.fromEntries(db.tables.workflows.map((w) => [w.id, w.status]));
    expect(status).toMatchObject({ w1: "active", w2: "draft", w3: "draft", w4: "active", w5: "active", w7: "active" });
  });

  it("repair job: dry run changes nothing; --apply fixes every CrankLeads org (never house orgs); idempotent", async () => {
    const db = seed();
    const dry = await repairTierAutomations(db.client as never);
    expect(dry.map((i) => [i.companyId, i.deactivated.sort()])).toEqual([
      ["c-catch", ["quote-follow-up", "stale-lead-nudge"]],
      ["c-close", ["call-summary-to-owner"]],
    ]);
    expect(db.tables.workflows.every((w) => w.status === "active")).toBe(true);
    await repairTierAutomations(db.client as never, { apply: true });
    expect(db.tables.workflows.filter((w) => w.status === "draft").map((w) => w.id).sort()).toEqual(["w2", "w3", "w6"]);
    expect(await repairTierAutomations(db.client as never, { apply: true })).toEqual([]);
  });
});
