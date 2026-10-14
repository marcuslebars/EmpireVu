/**
 * Everdoer rebrand: the App Review demo seed moves to the 'everdoer-demo-seed:' id salt, and the
 * reseed deletes the OLD demo org (found by its old-salt id, verified by slug + name) and the old
 * login demo@empirevu.com (only when it belongs to no other org). Nothing else, and only with
 * --apply (the job prints the plan otherwise).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  applyLegacyDemoCleanup,
  DEMO_SEED_SALT,
  demoUuid,
  formatLegacyDemoPlan,
  LEGACY_DEMO_SEED_SALT,
  planIsEmpty,
  planLegacyDemoCleanup,
  type DemoAuthAdmin,
} from "@/server/services/rebrand/demo-seed";
import { createFakeDb } from "./helpers/fake-supabase";

/** The id function exactly as seed-demo-org.ts had it before the rebrand. */
function oldDemoId(name: string): string {
  const bytes = createHash("sha1").update(`empirevu-demo-seed:${name}`).digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

const OLD_ORG = oldDemoId("organization");
const NEW_ORG = demoUuid(DEMO_SEED_SALT, "organization");
const OPTIONS = { legacyOrgSlug: "empirevu-demo", legacyEmail: "demo@empirevu.com", newEmail: "demo@everdoer.com" };

function fakeAuth(users: Array<{ id: string; email: string }>): DemoAuthAdmin & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    findUserByEmail: (email) => Promise.resolve(users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null),
    deleteUser: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
  };
}

function world(overrides: { orgName?: string; orgSlug?: string; extraMembership?: boolean } = {}) {
  return createFakeDb({
    organizations: [
      { id: OLD_ORG, slug: overrides.orgSlug ?? "empirevu-demo", name: overrides.orgName ?? "EmpireVu Demo" },
      { id: "org-a1", slug: "a1-group", name: "A1 Group" },
      { id: "org-blairs", slug: "blairs-demo-shop", name: "Blair's" },
    ],
    organization_memberships: [
      { id: oldDemoId("membership"), organization_id: OLD_ORG, profile_id: "user-old" },
      { id: "m-a1", organization_id: "org-a1", profile_id: "user-a1" },
      ...(overrides.extraMembership ? [{ id: "m-x", organization_id: "org-blairs", profile_id: "user-old" }] : []),
    ],
    companies: [
      { id: oldDemoId("company"), organization_id: OLD_ORG, slug: "harbour-point-marine" },
      { id: "co-a1", organization_id: "org-a1", slug: "a1-marine-care" },
    ],
    contacts: [
      { id: oldDemoId("contact:1"), organization_id: OLD_ORG },
      { id: oldDemoId("contact:2"), organization_id: OLD_ORG },
      { id: "c-a1", organization_id: "org-a1" },
    ],
  });
}

describe("demo seed ids", () => {
  it("the new salt is everdoer-demo-seed:, and the old one reproduces the pre-rebrand ids exactly", () => {
    expect(DEMO_SEED_SALT).toBe("everdoer-demo-seed:");
    expect(demoUuid(LEGACY_DEMO_SEED_SALT, "organization")).toBe(OLD_ORG);
    expect(demoUuid(LEGACY_DEMO_SEED_SALT, "contact:Jane")).toBe(oldDemoId("contact:Jane"));
    expect(NEW_ORG).not.toBe(OLD_ORG);
    expect(NEW_ORG).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("planLegacyDemoCleanup / applyLegacyDemoCleanup", () => {
  it("plans the old org (verified) and the old login; deletes exactly those with apply", async () => {
    const db = world();
    const auth = fakeAuth([
      { id: "user-old", email: "demo@empirevu.com" },
      { id: "user-a1", email: "owner@a1marinecare.ca" },
    ]);
    const plan = await planLegacyDemoCleanup(db.client, auth, OPTIONS);
    expect(plan.refused).toBeNull();
    expect(plan.org).toEqual({ id: OLD_ORG, slug: "empirevu-demo", name: "EmpireVu Demo" });
    expect(plan.counts).toMatchObject({ companies: 1, contacts: 2, organization_memberships: 1 });
    expect(plan.user).toEqual({ id: "user-old", email: "demo@empirevu.com" });
    expect(formatLegacyDemoPlan(plan)).toContain(`delete organization ${OLD_ORG} "EmpireVu Demo" (empirevu-demo)`);
    // Planning deletes nothing.
    expect(db.queries.filter((q) => q.op !== "select")).toEqual([]);
    expect(auth.deleted).toEqual([]);

    const done = await applyLegacyDemoCleanup(db.client, auth, plan);
    expect(done).toEqual({ deletedOrg: true, deletedUser: true });
    const deletes = db.queries.filter((q) => q.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].table).toBe("organizations");
    expect(deletes[0].filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "id", value: OLD_ORG }),
        expect.objectContaining({ column: "slug", value: "empirevu-demo" }),
        expect.objectContaining({ column: "name", value: "EmpireVu Demo" }),
      ]),
    );
    expect(db.tables.organizations.map((o) => o.id)).toEqual(["org-a1", "org-blairs"]);
    expect(auth.deleted).toEqual(["user-old"]);
  });

  it("refuses (deletes nothing) when the old id belongs to something that isn't the demo org", async () => {
    for (const bad of [{ orgName: "Harbour Point Marine" }, { orgSlug: "harbour-point" }, { orgSlug: "a1-group-demo" }]) {
      const db = world(bad);
      const auth = fakeAuth([{ id: "user-old", email: "demo@empirevu.com" }]);
      const plan = await planLegacyDemoCleanup(db.client, auth, OPTIONS);
      expect(plan.refused).toMatch(/Not deleting anything/);
      expect(plan.org).toBeNull();
      expect(plan.user).toBeNull();
      await expect(applyLegacyDemoCleanup(db.client, auth, plan)).rejects.toThrow(/Not deleting anything/);
      expect(db.queries.filter((q) => q.op === "delete")).toEqual([]);
      expect(auth.deleted).toEqual([]);
    }
  });

  it("keeps the old login when it is also in another org", async () => {
    const db = world({ extraMembership: true });
    const auth = fakeAuth([{ id: "user-old", email: "demo@empirevu.com" }]);
    const plan = await planLegacyDemoCleanup(db.client, auth, OPTIONS);
    expect(plan.user).toBeNull();
    expect(plan.userKept).toMatch(/also a member of org-blairs/);
    await applyLegacyDemoCleanup(db.client, auth, plan);
    expect(auth.deleted).toEqual([]);
  });

  it("keeps the login when the new email is the old one (it just moves to the new org)", async () => {
    const db = world();
    const auth = fakeAuth([{ id: "user-old", email: "demo@empirevu.com" }]);
    const plan = await planLegacyDemoCleanup(db.client, auth, { ...OPTIONS, newEmail: "Demo@EmpireVu.com" });
    expect(plan.user).toBeNull();
    expect(plan.org?.id).toBe(OLD_ORG);
  });

  it("nothing to do once cleaned up: the reseed needs no --apply", async () => {
    const db = createFakeDb({ organizations: [{ id: NEW_ORG, slug: "everdoer-demo", name: "Everdoer Demo" }] });
    const auth = fakeAuth([{ id: "user-new", email: "demo@everdoer.com" }]);
    const plan = await planLegacyDemoCleanup(db.client, auth, OPTIONS);
    expect(planIsEmpty(plan)).toBe(true);
    const done = await applyLegacyDemoCleanup(db.client, auth, plan);
    expect(done).toEqual({ deletedOrg: false, deletedUser: false });
    expect(db.queries.filter((q) => q.op === "delete")).toEqual([]);
  });

  it("a login left over without its org is still removed", async () => {
    const db = createFakeDb({ organizations: [], organization_memberships: [] });
    const auth = fakeAuth([{ id: "user-old", email: "demo@empirevu.com" }]);
    const plan = await planLegacyDemoCleanup(db.client, auth, OPTIONS);
    expect(plan.org).toBeNull();
    expect(plan.user?.id).toBe("user-old");
    expect(planIsEmpty(plan)).toBe(false);
    await applyLegacyDemoCleanup(db.client, auth, plan);
    expect(auth.deleted).toEqual(["user-old"]);
  });

  it("surfaces a read error instead of guessing", async () => {
    const db = world();
    db.failNext("organizations", "select", { message: "db down" });
    const auth = fakeAuth([{ id: "user-old", email: "demo@empirevu.com" }]);
    await expect(planLegacyDemoCleanup(db.client, auth, OPTIONS)).rejects.toMatchObject({ message: "db down" });
    expect(auth.deleted).toEqual([]);
  });
});
