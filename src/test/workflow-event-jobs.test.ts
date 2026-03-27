import { describe, expect, it } from "vitest";

import {
  buildWorkflowEventJobRetryUpdate,
  buildWorkflowEventJobsHealthSummary,
  isWorkflowEventJobRetryEligible,
} from "@/server/services/workflow-event-jobs";
import type { Tables } from "@/server/db/database.types";

function createJob(overrides: Partial<Tables<"workflow_event_jobs">>): Tables<"workflow_event_jobs"> {
  return {
    activity_event_id: "22222222-2222-2222-2222-222222222222",
    attempt_count: 0,
    available_at: "2026-03-24T10:00:00.000Z",
    company_id: null,
    completed_at: null,
    created_at: "2026-03-24T10:00:00.000Z",
    id: crypto.randomUUID(),
    last_attempted_at: null,
    last_error: null,
    locked_at: null,
    locked_by: null,
    max_attempts: 5,
    organization_id: "11111111-1111-1111-1111-111111111111",
    started_at: null,
    status: "pending",
    updated_at: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("workflow event job health summary", () => {
  it("summarizes pending, running, failed, completed, and suspicious jobs", () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    const summary = buildWorkflowEventJobsHealthSummary(
      [
        createJob({ status: "pending" }),
        createJob({ status: "failed", last_error: "boom" }),
        createJob({ status: "running", locked_at: "2026-03-24T11:58:00.000Z" }),
        createJob({ status: "running", locked_at: "2026-03-24T11:00:00.000Z" }),
        createJob({ status: "completed", completed_at: "2026-03-24T11:30:00.000Z" }),
        createJob({ status: "completed", completed_at: "2026-03-22T11:30:00.000Z", updated_at: "2026-03-22T11:30:00.000Z" }),
      ],
      { now, staleAfterSeconds: 900 },
    );

    expect(summary).toEqual({
      completedRecentCount: 1,
      failedCount: 1,
      pendingCount: 1,
      runningCount: 2,
      suspiciousRunningCount: 1,
    });
  });
});

describe("workflow event job retry helpers", () => {
  it("allows manual retry for failed jobs even after max attempts were reached", () => {
    expect(isWorkflowEventJobRetryEligible(createJob({
      attempt_count: 5,
      max_attempts: 5,
      status: "failed",
    }))).toBe(true);

    expect(isWorkflowEventJobRetryEligible(createJob({
      status: "completed",
    }))).toBe(false);
  });

  it("resets retry state so the worker can claim the job again", () => {
    expect(buildWorkflowEventJobRetryUpdate("2026-03-24T12:05:00.000Z")).toEqual({
      attempt_count: 0,
      available_at: "2026-03-24T12:05:00.000Z",
      completed_at: null,
      last_attempted_at: null,
      last_error: null,
      locked_at: null,
      locked_by: null,
      started_at: null,
      status: "pending",
    });
  });
});
