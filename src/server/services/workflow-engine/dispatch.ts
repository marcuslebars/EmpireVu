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
  /**
   * Emit the activity event but NEVER enqueue a workflow job for it (Task 8). Messaging
   * actions record contact.sms_sent / contact.email_sent this way so a workflow that sends
   * a message can't re-trigger itself (or another workflow) on that emission.
   */
  emitOnly?: boolean;
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

  if (options.emitOnly || options.dispatchAsync === false || !shouldDispatchWorkflowEvent(input.eventType)) {
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