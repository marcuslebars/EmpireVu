/**
 * Account deletion never strands a team without an owner, and only deletes an
 * organization's data when the user is its sole member and has explicitly confirmed.
 */
import { describe, expect, it, vi } from "vitest";

import { AccountDeletionBlocked, deleteAccount } from "@/server/services/account-deletion";

type Row = Record<string, unknown>;

function fakeAdmin(tables: { organization_memberships: Row[]; organizations: Row[] }) {
  const deletedOrgIds: unknown[] = [];
  const deleteUser = vi.fn(async () => ({ data: {}, error: null }));
  const client = {
    auth: { admin: { deleteUser } },
    from(table: keyof typeof tables) {
      const filters: Array<(row: Row) => boolean> = [];
      let deleting = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        delete: () => {
          deleting = true;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          if (deleting) deletedOrgIds.push(...values);
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: tables[table].filter((row) => filters.every((f) => f(row))), error: null }).then(onFulfilled),
      };
      return builder;
    },
  };
  return { admin: client as unknown as Parameters<typeof deleteAccount>[0], deleteUser, deletedOrgIds };
}

const orgs = [
  { id: "org-team", name: "Thinker Holdings" },
  { id: "org-solo", name: "Side Project" },
];

describe("deleteAccount", () => {
  it("refuses when the user is the only owner of an organization with other members", async () => {
    const { admin, deleteUser } = fakeAdmin({
      organizations: orgs,
      organization_memberships: [
        { organization_id: "org-team", profile_id: "me", role: "owner" },
        { organization_id: "org-team", profile_id: "kyle", role: "member" },
      ],
    });

    const attempt = deleteAccount(admin, "me", { confirm: "DELETE", deleteSoleOrganizations: true });
    await expect(attempt).rejects.toBeInstanceOf(AccountDeletionBlocked);
    await expect(attempt).rejects.toMatchObject({ code: "transfer_ownership" });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("allows leaving when another owner remains", async () => {
    const { admin, deleteUser, deletedOrgIds } = fakeAdmin({
      organizations: orgs,
      organization_memberships: [
        { organization_id: "org-team", profile_id: "me", role: "owner" },
        { organization_id: "org-team", profile_id: "sam", role: "owner" },
      ],
    });

    await deleteAccount(admin, "me", { confirm: "DELETE" });
    expect(deleteUser).toHaveBeenCalledWith("me");
    expect(deletedOrgIds).toEqual([]);
  });

  it("asks for confirmation before deleting an organization the user is alone in", async () => {
    const { admin, deleteUser } = fakeAdmin({
      organizations: orgs,
      organization_memberships: [{ organization_id: "org-solo", profile_id: "me", role: "owner" }],
    });

    await expect(deleteAccount(admin, "me", { confirm: "DELETE" })).rejects.toMatchObject({
      code: "confirm_sole_organizations",
      organizations: [{ id: "org-solo", name: "Side Project" }],
    });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("deletes the sole organization and the user once confirmed", async () => {
    const { admin, deleteUser, deletedOrgIds } = fakeAdmin({
      organizations: orgs,
      organization_memberships: [{ organization_id: "org-solo", profile_id: "me", role: "owner" }],
    });

    const result = await deleteAccount(admin, "me", { confirm: "DELETE", deleteSoleOrganizations: true });
    expect(deletedOrgIds).toEqual(["org-solo"]);
    expect(deleteUser).toHaveBeenCalledWith("me");
    expect(result.deletedOrganizations).toEqual(["org-solo"]);
  });
});
