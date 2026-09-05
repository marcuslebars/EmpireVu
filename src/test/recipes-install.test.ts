import { beforeEach, describe, expect, it, vi } from "vitest";

// Recorded installs — the createWorkflow mock pushes here, and the fake workflows query
// reads back from here, so idempotency across two installRecipes calls is exercised for real.
const installedRows: Array<{ id: string; slug: string }> = [];
const createWorkflow = vi.fn((...args: unknown[]) => {
  const input = args[1] as { slug: string; status?: "active" | "draft"; definition?: Record<string, unknown> };
  const id = `wf-${installedRows.length + 1}`;
  installedRows.push({ id, slug: input.slug });
  return Promise.resolve({ id, slug: input.slug, status: input.status ?? "active", definition: input.definition });
});

const smsConfigured = vi.fn(() => true);
const emailConfigured = vi.fn(() => true);
const voiceConfigured = vi.fn(() => false);

vi.mock("@/server/services/workflows", () => ({ createWorkflow: (...a: unknown[]) => createWorkflow(...a) }));
vi.mock("@/server/services/shared", async (orig) => ({
  ...(await orig<typeof import("@/server/services/shared")>()),
  assertCompanyInOrganization: (..._a: unknown[]) => Promise.resolve(),
}));
vi.mock("@/server/outbound/sms", () => ({ isSmsSendConfigured: () => smsConfigured() }));
vi.mock("@/server/outbound/email", () => ({ isEmailSendConfigured: () => emailConfigured() }));
vi.mock("@/server/services/voice", () => ({ isVoiceConfigured: () => voiceConfigured() }));

import { installRecipes, listRecipeCatalog } from "@/server/services/workflow-engine/recipes/install";
import { ALL_RECIPES } from "@/server/services/workflow-engine/recipes";

type Thenable = {
  select: () => Thenable;
  eq: () => Thenable;
  is: () => Thenable;
  then: (resolve: (value: { data: Array<{ id: string; slug: string }>; error: null }) => void) => void;
};

function makeContext() {
  const supabase = {
    from(table: string) {
      if (table === "workflows") {
        const api: Thenable = {
          select: () => api,
          eq: () => api,
          is: () => api,
          then: (resolve) => resolve({ data: installedRows.map((row) => ({ id: row.id, slug: row.slug })), error: null }),
        };
        return api;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { organizationId: "org-1", actorProfileId: null, supabase } as never;
}

beforeEach(() => {
  installedRows.length = 0;
  createWorkflow.mockClear();
  smsConfigured.mockReturnValue(true);
  emailConfigured.mockReturnValue(true);
  voiceConfigured.mockReturnValue(false);
});

describe("installRecipes", () => {
  it("installs the whole catalog, then is a no-op on re-run (idempotent by slug)", async () => {
    const first = await installRecipes(makeContext(), "co-1");
    expect(first.installed).toHaveLength(ALL_RECIPES.length);
    expect(first.skipped).toHaveLength(0);
    expect(createWorkflow).toHaveBeenCalledTimes(ALL_RECIPES.length);

    const second = await installRecipes(makeContext(), "co-1");
    expect(second.installed).toHaveLength(0);
    expect(second.skipped).toHaveLength(ALL_RECIPES.length);
    // No new workflows created on the second run.
    expect(createWorkflow).toHaveBeenCalledTimes(ALL_RECIPES.length);
  });

  it("installs only the requested slugs when `only` is given", async () => {
    const result = await installRecipes(makeContext(), "co-1", { only: ["stale-lead-nudge"] });
    expect(result.installed.map((r) => r.slug)).toEqual(["stale-lead-nudge"]);
  });

  it("drafts a recipe whose channel isn't configured and records a disabled_reason", async () => {
    smsConfigured.mockReturnValue(false);
    const result = await installRecipes(makeContext(), "co-1");

    const missedCall = result.installed.find((r) => r.slug === "missed-call-text-back");
    expect(missedCall?.status).toBe("draft");
    expect(missedCall?.disabledReason).toMatch(/sms/i);

    // A recipe that needs no channel installs active with no reason.
    const stale = result.installed.find((r) => r.slug === "stale-lead-nudge");
    expect(stale?.status).toBe("active");
    expect(stale?.disabledReason).toBeNull();

    // Email is configured, so the owner-alert recipe stays active.
    const ownerAlert = result.installed.find((r) => r.slug === "new-lead-owner-alert");
    expect(ownerAlert?.status).toBe("active");
  });

  it("forceDraftCustomerFacing seeds customer-texting recipes as draft, owner alerts stay active", async () => {
    const result = await installRecipes(makeContext(), "co-1", { forceDraftCustomerFacing: true });

    const missedCall = result.installed.find((r) => r.slug === "missed-call-text-back");
    expect(missedCall?.status).toBe("draft");
    expect(missedCall?.disabledReason).toMatch(/review/i);

    // notify_owner only → not customer-facing → stays active even when forcing drafts.
    const ownerAlert = result.installed.find((r) => r.slug === "new-lead-owner-alert");
    expect(ownerAlert?.status).toBe("active");
  });
});

describe("listRecipeCatalog", () => {
  it("annotates installed state, the workflow id, and time saved", async () => {
    // Pre-seed one installed recipe.
    installedRows.push({ id: "wf-existing", slug: "missed-call-text-back" });

    const catalog = await listRecipeCatalog(makeContext(), "co-1");
    expect(catalog).toHaveLength(ALL_RECIPES.length);

    const installed = catalog.find((c) => c.slug === "missed-call-text-back");
    expect(installed?.installed).toBe(true);
    expect(installed?.installedWorkflowId).toBe("wf-existing");
    expect(installed?.estimatedTimeSavedSeconds).toBeGreaterThan(0);

    const notInstalled = catalog.find((c) => c.slug === "quote-follow-up");
    expect(notInstalled?.installed).toBe(false);
    expect(notInstalled?.installedWorkflowId).toBeNull();
  });
});
