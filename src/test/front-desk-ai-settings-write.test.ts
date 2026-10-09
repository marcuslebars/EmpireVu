import { describe, expect, it } from "vitest";

import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import { createFakeDb } from "@/test/helpers/fake-supabase";

describe("updateAiSettings (optimistic read-modify-write of companies.ai_settings)", () => {
  it("a concurrent write to another section between our read and write isn't clobbered", async () => {
    const db = createFakeDb({ companies: [{ id: "co-1", organization_id: "org-1", ai_settings: { sms_agent: { enabled: true } }, updated_at: "2026-10-09T10:00:00.000Z" }] });
    let calls = 0;
    const written = await updateAiSettings(db.client, { organizationId: "org-1", companyId: "co-1" }, (current) => {
      calls += 1;
      if (calls === 1) {
        // Someone else saves the weekly report section right now.
        db.tables.companies[0].ai_settings = { ...(db.tables.companies[0].ai_settings as object), weekly_report: { enabled: false } };
        db.tables.companies[0].updated_at = "2026-10-09T10:00:01.000Z";
      }
      return { ...current, call_answering: { mode: "voicemail" } };
    });
    expect(calls).toBe(2);
    expect(written).toEqual({ sms_agent: { enabled: true }, weekly_report: { enabled: false }, call_answering: { mode: "voicemail" } });
    expect(db.tables.companies[0].ai_settings).toEqual(written);
  });

  it("unknown company → null", async () => {
    const db = createFakeDb({ companies: [] });
    expect(await updateAiSettings(db.client, { organizationId: "org-1", companyId: "nope" }, (c) => c)).toBeNull();
  });
});
