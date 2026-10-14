/**
 * Everdoer rebrand: the App Review demo org (job:seed-demo) moves to new ids.
 *
 * Every demo row's id is a uuid v5 of `<salt><name>`. The salt was 'empirevu-demo-seed:' and is
 * now 'everdoer-demo-seed:', so a reseed would create a second org next to the old one. Before
 * seeding, the job therefore finds the OLD demo org by the id the old salt gives
 * "organization", checks it really is the demo org (slug and name both match what the old job
 * wrote, and the slug contains "demo"), and deletes it; the org's rows go with it through the
 * organization_id cascades. The old reviewer login (demo@empirevu.com) is deleted too, but only
 * if it belongs to no other org. Nothing else is ever touched, and nothing is deleted without
 * `--apply`: without it the job prints the plan and stops.
 */
import { createHash } from "node:crypto";

import type { createSupabaseAdminClient } from "@/server/supabase/admin";

export const DEMO_SEED_SALT = "everdoer-demo-seed:";
/** Only used to find (and delete) the rows the job made before the rebrand. */
export const LEGACY_DEMO_SEED_SALT = "empirevu-demo-seed:";
export const DEMO_ORG_SLUG = "everdoer-demo";
export const LEGACY_DEMO_ORG_SLUG = "empirevu-demo";
export const DEMO_ORG_NAME = "Everdoer Demo";
/** The name the old job wrote on every run. */
export const LEGACY_DEMO_ORG_NAME = "EmpireVu Demo";
export const DEMO_EMAIL = "demo@everdoer.com";
export const LEGACY_DEMO_EMAIL = "demo@empirevu.com";

/**
 * A uuid v5 derived from the row's name. Same salt + name, same id, forever: that's what makes
 * the seed's upserts idempotent, and what lets the cleanup find the old org without a lookup by
 * anything a user could have changed.
 */
export function demoUuid(salt: string, name: string): string {
  const bytes = createHash("sha1").update(`${salt}${name}`).digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

type Admin = ReturnType<typeof createSupabaseAdminClient>;

/** The two auth calls the cleanup needs (the GoTrue admin API, or a fake in tests). */
export interface DemoAuthAdmin {
  findUserByEmail(email: string): Promise<{ id: string; email: string } | null>;
  deleteUser(id: string): Promise<void>;
}

export function demoAuthAdmin(admin: Admin): DemoAuthAdmin {
  return {
    async findUserByEmail(email) {
      for (let page = 1; page <= 20; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        // Under the SPA tsconfig the GoTrue listUsers result infers `users` as never[].
        const users = data.users as Array<{ id: string; email?: string | null }>;
        const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (match) return { id: match.id, email: match.email ?? email };
        if (users.length < 200) break;
      }
      return null;
    },
    async deleteUser(id) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    },
  };
}

/** Tables counted in the dry run, so the operator sees what the cascade removes. */
const COUNTED_TABLES = [
  "organization_memberships",
  "companies",
  "contacts",
  "quotes",
  "invoices",
  "bookings",
  "tasks",
  "message_log",
  "workflows",
  "workflow_runs",
] as const;

export interface LegacyDemoPlan {
  /** The old demo org, verified; null when there is none (already cleaned up). */
  org: { id: string; slug: string; name: string } | null;
  /** Rows per table in the old org (all removed with it). */
  counts: Record<string, number>;
  /** The old reviewer login, to delete; null when there's none or it must be kept. */
  user: { id: string; email: string } | null;
  /** Why an existing old login is kept (it's in another org, or it IS the new login). */
  userKept: string | null;
  /** Set when something with the old org's id is NOT the demo org: nothing may be deleted. */
  refused: string | null;
}

export function planIsEmpty(plan: LegacyDemoPlan): boolean {
  return !plan.org && !plan.user && !plan.refused;
}

export async function planLegacyDemoCleanup(
  admin: Admin,
  auth: DemoAuthAdmin,
  options: { legacyOrgSlug: string; legacyEmail: string; newEmail: string },
): Promise<LegacyDemoPlan> {
  const plan: LegacyDemoPlan = { org: null, counts: {}, user: null, userKept: null, refused: null };
  const legacyOrgId = demoUuid(LEGACY_DEMO_SEED_SALT, "organization");

  const { data: org, error } = await admin.from("organizations").select("id, slug, name").eq("id", legacyOrgId).maybeSingle();
  if (error) throw error;
  if (org) {
    const row = org as { id: string; slug: string; name: string };
    if (row.slug !== options.legacyOrgSlug || !row.slug.includes("demo") || row.name !== LEGACY_DEMO_ORG_NAME) {
      plan.refused =
        `Organization ${row.id} has the old demo org's id but slug "${row.slug}" and name "${row.name}" ` +
        `(expected "${options.legacyOrgSlug}" and "${LEGACY_DEMO_ORG_NAME}"). Not deleting anything; check it by hand.`;
      return plan;
    }
    plan.org = row;
    for (const table of COUNTED_TABLES) {
      const { data, error: countError } = await admin.from(table).select("id").eq("organization_id", row.id);
      if (countError) throw countError;
      plan.counts[table] = (data ?? []).length;
    }
  }

  if (options.legacyEmail.toLowerCase() === options.newEmail.toLowerCase()) {
    plan.userKept = `${options.legacyEmail} is also the new login; it is kept (and moved to the new org).`;
    return plan;
  }
  const user = await auth.findUserByEmail(options.legacyEmail);
  if (user) {
    const { data: memberships, error: membershipError } = await admin
      .from("organization_memberships")
      .select("organization_id")
      .eq("profile_id", user.id);
    if (membershipError) throw membershipError;
    const others = ((memberships ?? []) as Array<{ organization_id: string }>)
      .map((m) => m.organization_id)
      .filter((id) => id !== legacyOrgId);
    if (others.length) {
      plan.userKept = `${user.email} is also a member of ${others.join(", ")}; it is kept. Remove it by hand if it should go.`;
    } else {
      plan.user = user;
    }
  }
  return plan;
}

export function formatLegacyDemoPlan(plan: LegacyDemoPlan): string {
  if (plan.refused) return `REFUSED: ${plan.refused}`;
  const lines: string[] = [];
  if (plan.org) {
    lines.push(`delete organization ${plan.org.id} "${plan.org.name}" (${plan.org.slug}) and, with it:`);
    for (const [table, n] of Object.entries(plan.counts)) lines.push(`  ${table}: ${n}`);
  } else {
    lines.push("no old-salt demo organization (already removed)");
  }
  if (plan.user) lines.push(`delete the old reviewer login ${plan.user.email} (${plan.user.id})`);
  if (plan.userKept) lines.push(`keep: ${plan.userKept}`);
  return lines.join("\n");
}

/** Delete what the plan lists. The org delete re-checks id, slug AND name in its WHERE clause. */
export async function applyLegacyDemoCleanup(
  admin: Admin,
  auth: DemoAuthAdmin,
  plan: LegacyDemoPlan,
): Promise<{ deletedOrg: boolean; deletedUser: boolean }> {
  if (plan.refused) throw new Error(plan.refused);
  let deletedOrg = false;
  if (plan.org) {
    const { data, error } = await admin
      .from("organizations")
      .delete()
      .eq("id", plan.org.id)
      .eq("slug", plan.org.slug)
      .eq("name", LEGACY_DEMO_ORG_NAME)
      .select("id");
    if (error) throw error;
    deletedOrg = (data ?? []).length === 1;
  }
  let deletedUser = false;
  if (plan.user) {
    await auth.deleteUser(plan.user.id);
    deletedUser = true;
  }
  return { deletedOrg, deletedUser };
}
