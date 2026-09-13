/**
 * The pushes that fill in the notification preference toggles: AI draft ready, workflow
 * failed, schedule conflict, and the morning digest. Message shapes carry the deep link
 * (screen + record + scope) the app needs to open the right thing.
 */
import { describe, expect, it } from "vitest";

import { conflictMessage, overlaps } from "@/server/services/push/conflicts";
import { digestMessage } from "@/server/services/push/digest";
import { draftReadyMessage, workflowFailedMessage } from "@/server/services/push/notify";

const ORG = "org-1";

describe("draftReadyMessage", () => {
  it("names the contact and previews the text reply", () => {
    const msg = draftReadyMessage(
      { organization_id: ORG, company_id: "co-1", contact_id: "c-1", sms_body: "Hi Dana — we have two lift slots next week.", email_subject: "Winter storage" },
      "Dana Whitcombe",
    );
    expect(msg).toMatchObject({
      title: "Reply ready for Dana Whitcombe",
      body: "Hi Dana — we have two lift slots next week.",
      category: "drafts",
      data: { screen: "lead", recordId: "c-1", organizationId: ORG, companyId: "co-1" },
    });
  });

  it("truncates long previews and falls back without a name", () => {
    const msg = draftReadyMessage({ organization_id: ORG, company_id: "co-1", contact_id: "c-1", sms_body: "x".repeat(300), email_subject: null }, null);
    expect(msg.title).toBe("AI reply ready to approve");
    expect(msg.body.length).toBe(118);
    expect(msg.body.endsWith("…")).toBe(true);
  });
});

describe("workflowFailedMessage", () => {
  it("links to the run trace", () => {
    const msg = workflowFailedMessage({ organizationId: ORG, companyId: null, workflowName: "Quote sent → 48h chase", failureReason: "Twilio 21610: unsubscribed recipient", runId: "run-9" });
    expect(msg).toMatchObject({
      title: "Workflow failed — Quote sent → 48h chase",
      body: "Twilio 21610: unsubscribed recipient",
      category: "workflow_failures",
      data: { screen: "run", recordId: "run-9" },
    });
  });
});

describe("schedule conflicts", () => {
  const at = (iso: string, minutes: number) => ({ scheduled_for: iso, duration_minutes: minutes });

  it("detects overlap but not back-to-back bookings", () => {
    expect(overlaps(at("2026-09-14T14:00:00Z", 60), at("2026-09-14T14:30:00Z", 60))).toBe(true);
    expect(overlaps(at("2026-09-14T14:00:00Z", 60), at("2026-09-14T15:00:00Z", 30))).toBe(false);
    expect(overlaps(at("2026-09-14T15:00:00Z", 30), at("2026-09-14T14:00:00Z", 90))).toBe(true);
  });

  it("describes the clash and deep-links to the booking", () => {
    const booking = { id: "b-1", organization_id: ORG, company_id: "co-1", title: "Detail + compound", scheduled_for: "2026-09-14T20:15:00Z", duration_minutes: 120, status: "confirmed" as const };
    const other = { ...booking, id: "b-2", title: "Queen's Cove lift", scheduled_for: "2026-09-14T21:00:00Z" };
    const msg = conflictMessage({ booking, other, profileIds: ["kyle"] }, "America/Toronto");
    expect(msg).toMatchObject({
      title: "Schedule conflict",
      body: "Detail + compound overlaps Queen's Cove lift at 17:00.",
      category: "conflicts",
      data: { screen: "booking", recordId: "b-1", companyId: "co-1" },
    });
  });
});

describe("digestMessage", () => {
  it("summarises only what is non-zero", () => {
    expect(digestMessage(ORG, { jobsToday: 5, leadsWaiting: 1, overdueTasks: 0 })).toMatchObject({
      title: "Good morning",
      body: "5 jobs today · 1 lead waiting.",
      category: "daily_digest",
      data: { screen: "home", organizationId: ORG },
    });
  });

  it("sends nothing on an empty day", () => {
    expect(digestMessage(ORG, { jobsToday: 0, leadsWaiting: 0, overdueTasks: 0 })).toBeNull();
  });
});
