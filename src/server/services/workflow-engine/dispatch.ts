import type { Tables } from "@/server/db/database.types";
import {
  createActivityEvent,
  type CreateActivityEventInput,
} from "@/server/services/activity-events";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  isSupportedWorkflowTrigger,
} from "@/server/services/workflow-engine/definitions";
import { enqueueWorkflowEventJob } from "@/server/services/workflow-event-jobs";

export interface EmitActivityEventAndDispatchOptions {
  dispatchAsync?: boolean;
  maxAttempts?: number;
}

export interface EmitActivityEventAndDispatchResult {
  activityEvent: Tables<"activity_events">;
  workflowEventJob: Tables<"workflow_event_jobs"> | null;
}

export function shouldDispatchWorkflowEvent(eventType: string): boolean {
  return isSupportedWorkflowTrigger(eventType);
}

export async function emitActivityEventAndDispatch(
  context: TenantServiceContext,
  input: CreateActivityEventInput,
  options: EmitActivityEventAndDispatchOptions = {},
): Promise<EmitActivityEventAndDispatchResult> {
  const activityEvent = await createActivityEvent(context, input);

  if (options.dispatchAsync === false || !shouldDispatchWorkflowEvent(input.eventType)) {
    return {
      activityEvent,
      workflowEventJob: null,
    };
  }

  const workflowEventJob = await enqueueWorkflowEventJob(context, {
    activityEventId: activityEvent.id,
    maxAttempts: options.maxAttempts,
  });

  return {
    activityEvent,
    workflowEventJob,
  };
}