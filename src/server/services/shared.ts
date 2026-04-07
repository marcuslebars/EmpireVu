import type { Inserts, TableName, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import type { createSupabaseServerClient } from "@/server/supabase/server";

type AppSupabaseClient = ReturnType<typeof createSupabaseServerClient>;

export interface TenantServiceContext {
  actorProfileId: string | null;
  organizationId: string;
  supabase: AppSupabaseClient;
}

export type CommentEntityType = Tables<"comments">["entity_type"];

type SupabaseQueryBuilder = ReturnType<AppSupabaseClient['from']>;

export async function insertRow<T extends TableName>(
  context: TenantServiceContext,
  table: T,
  payload: Inserts<T>,
): Promise<Tables<T>> {
  const { data, error } = await (context.supabase.from(table) as unknown as SupabaseQueryBuilder)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(`${table} insert returned no data.`);
  }

  return data as Tables<T>;
}

export async function assertCompanyInOrganization(
  context: TenantServiceContext,
  companyId: string | null | undefined,
): Promise<void> {
  if (!companyId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("companies")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Company does not belong to this organization.");
  }
}

export async function assertContactInOrganization(
  context: TenantServiceContext,
  contactId: string | null | undefined,
): Promise<void> {
  if (!contactId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Contact does not belong to this organization.");
  }
}

export async function assertBookingInOrganization(
  context: TenantServiceContext,
  bookingId: string | null | undefined,
): Promise<void> {
  if (!bookingId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("bookings")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("id", bookingId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Booking does not belong to this organization.");
  }
}

export async function assertWorkflowInOrganization(
  context: TenantServiceContext,
  workflowId: string | null | undefined,
): Promise<void> {
  if (!workflowId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("workflows")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("id", workflowId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Workflow does not belong to this organization.");
  }
}

export async function assertProfileInOrganization(
  context: TenantServiceContext,
  profileId: string | null | undefined,
): Promise<void> {
  if (!profileId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("organization_memberships")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Profile is not a member of this organization.");
  }
}

export async function assertTaskInOrganization(
  context: TenantServiceContext,
  taskId: string | null | undefined,
): Promise<void> {
  if (!taskId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("tasks")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("id", taskId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Task does not belong to this organization.");
  }
}

export async function assertActivityEventInOrganization(
  context: TenantServiceContext,
  activityEventId: string | null | undefined,
): Promise<void> {
  if (!activityEventId) {
    return;
  }

  const { data, error } = await context.supabase
    .from("activity_events")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("id", activityEventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Activity event does not belong to this organization.");
  }
}

export async function resolveCommentTargetCompany(
  context: TenantServiceContext,
  entityType: CommentEntityType,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case "company": {
      await assertCompanyInOrganization(context, entityId);
      return entityId;
    }
    case "contact": {
      const { data, error } = await context.supabase
        .from("contacts")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("id", entityId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new ValidationError("Comment target does not belong to this organization.");
      }

      return (data as Tables<"contacts">).company_id;
    }
    case "booking": {
      const { data, error } = await context.supabase
        .from("bookings")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("id", entityId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new ValidationError("Comment target does not belong to this organization.");
      }

      return (data as Tables<"bookings">).company_id;
    }
    case "task": {
      const { data, error } = await context.supabase
        .from("tasks")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("id", entityId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new ValidationError("Comment target does not belong to this organization.");
      }

      return (data as Tables<"tasks">).company_id;
    }
    case "workflow": {
      const { data, error } = await context.supabase
        .from("workflows")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("id", entityId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new ValidationError("Comment target does not belong to this organization.");
      }

      return (data as Tables<"workflows">).company_id;
    }
    case "workflow_run": {
      const { data, error } = await context.supabase
        .from("workflow_runs")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("id", entityId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new ValidationError("Comment target does not belong to this organization.");
      }

      return (data as Tables<"workflow_runs">).company_id;
    }
    case "activity_event": {
      const { data, error } = await context.supabase
        .from("activity_events")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("id", entityId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new ValidationError("Comment target does not belong to this organization.");
      }

      return (data as Tables<"activity_events">).company_id;
    }
  }
}