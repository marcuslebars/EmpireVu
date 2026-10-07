/**
 * Team role rules (Settings → Team). The same rules are enforced in the database by the
 * organization_memberships_guard trigger (migration 20261006170000), so a direct PostgREST
 * call can't skip them; this covers the server-side copy the API route runs first.
 */
import { describe, expect, it } from "vitest";

import { AuthorizationError } from "@/server/organizations/context";
import { assertMayChangeRole } from "@/server/services/organization-users";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";

describe("assertMayChangeRole", () => {
  it("lets an admin move people between member and admin", () => {
    expect(() =>
      assertMayChangeRole({ profileId: ADMIN, role: "admin" }, { profileId: MEMBER, from: "member", to: "admin" }),
    ).not.toThrow();
    expect(() =>
      assertMayChangeRole({ profileId: ADMIN, role: "admin" }, { profileId: MEMBER, from: "admin", to: "member" }),
    ).not.toThrow();
  });

  it("refuses an admin making themselves owner", () => {
    expect(() =>
      assertMayChangeRole({ profileId: ADMIN, role: "admin" }, { profileId: ADMIN, from: "admin", to: "owner" }),
    ).toThrow(AuthorizationError);
  });

  it("refuses an admin granting or removing owner access for someone else", () => {
    expect(() =>
      assertMayChangeRole({ profileId: ADMIN, role: "admin" }, { profileId: MEMBER, from: "member", to: "owner" }),
    ).toThrow(AuthorizationError);
    expect(() =>
      assertMayChangeRole({ profileId: ADMIN, role: "admin" }, { profileId: OWNER, from: "owner", to: "member" }),
    ).toThrow(AuthorizationError);
  });

  it("refuses anyone raising their own role", () => {
    expect(() =>
      assertMayChangeRole({ profileId: MEMBER, role: "member" }, { profileId: MEMBER, from: "member", to: "admin" }),
    ).toThrow(AuthorizationError);
  });

  it("lets an owner transfer ownership and step down", () => {
    expect(() =>
      assertMayChangeRole({ profileId: OWNER, role: "owner" }, { profileId: ADMIN, from: "admin", to: "owner" }),
    ).not.toThrow();
    expect(() =>
      assertMayChangeRole({ profileId: OWNER, role: "owner" }, { profileId: OWNER, from: "owner", to: "admin" }),
    ).not.toThrow();
  });
});
