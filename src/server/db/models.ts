import type { DbEnum, Inserts, Tables, Updates } from "@/server/db/database.types";

export type Profile = Tables<"profiles">;
export type Organization = Tables<"organizations">;
export type OrganizationMembership = Tables<"organization_memberships">;
export type Company = Tables<"companies">;
export type CompanyMembership = Tables<"company_memberships">;
export type Contact = Tables<"contacts">;
export type Booking = Tables<"bookings">;
export type Task = Tables<"tasks">;
export type Workflow = Tables<"workflows">;
export type WorkflowRun = Tables<"workflow_runs">;
export type ActivityEvent = Tables<"activity_events">;
export type Comment = Tables<"comments">;

export type CompanyInsert = Inserts<"companies">;
export type ContactInsert = Inserts<"contacts">;
export type BookingInsert = Inserts<"bookings">;
export type TaskInsert = Inserts<"tasks">;
export type WorkflowInsert = Inserts<"workflows">;
export type WorkflowRunInsert = Inserts<"workflow_runs">;
export type ActivityEventInsert = Inserts<"activity_events">;
export type CommentInsert = Inserts<"comments">;

export type CompanyUpdate = Updates<"companies">;
export type ContactUpdate = Updates<"contacts">;
export type BookingUpdate = Updates<"bookings">;
export type TaskUpdate = Updates<"tasks">;
export type WorkflowUpdate = Updates<"workflows">;
export type WorkflowRunUpdate = Updates<"workflow_runs">;
export type ActivityEventUpdate = Updates<"activity_events">;
export type CommentUpdate = Updates<"comments">;

export type MembershipRole = DbEnum<"membership_role">;
export type CompanyRole = DbEnum<"company_role">;
export type CompanyStage = DbEnum<"company_stage">;
export type ContactStage = DbEnum<"contact_stage">;
export type BookingStatus = DbEnum<"booking_status">;
export type TaskStatus = DbEnum<"task_status">;
export type TaskPriority = DbEnum<"task_priority">;
export type WorkflowStatus = DbEnum<"workflow_status">;
export type WorkflowRunStatus = DbEnum<"workflow_run_status">;

export interface OrganizationScopedModel {
  organization_id: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyScopedModel extends OrganizationScopedModel {
  company_id: string | null;
}