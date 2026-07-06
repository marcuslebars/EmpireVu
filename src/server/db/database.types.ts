export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  __InternalSupabase: {
    PostgrestVersion: "12";
  };
  public: {
    Tables: {
      activity_events: {
        Row: {
          actor_user_id: string | null;
          company_id: string | null;
          created_at: string;
          entity_id: string | null;
          entity_type: string;
          event_type: string;
          id: string;
          metadata_json: Json;
          occurred_at: string;
          organization_id: string;
          related_entity_id: string | null;
          related_entity_type: string | null;
          updated_at: string;
        };
        Insert: {
          actor_user_id?: string | null;
          company_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type: string;
          event_type: string;
          id?: string;
          metadata_json?: Json;
          occurred_at?: string;
          organization_id: string;
          related_entity_id?: string | null;
          related_entity_type?: string | null;
          updated_at?: string;
        };
        Update: {
          actor_user_id?: string | null;
          company_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string;
          event_type?: string;
          id?: string;
          metadata_json?: Json;
          occurred_at?: string;
          organization_id?: string;
          related_entity_id?: string | null;
          related_entity_type?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      bookings: {
        Row: {
          company_id: string;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          duration_minutes: number;
          id: string;
          organization_id: string;
          scheduled_for: string;
          status: Database["public"]["Enums"]["booking_status"];
          title: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          duration_minutes?: number;
          id?: string;
          organization_id: string;
          scheduled_for: string;
          status?: Database["public"]["Enums"]["booking_status"];
          title: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          duration_minutes?: number;
          id?: string;
          organization_id?: string;
          scheduled_for?: string;
          status?: Database["public"]["Enums"]["booking_status"];
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      comments: {
        Row: {
          author_profile_id: string | null;
          body: string;
          company_id: string | null;
          created_at: string;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["comment_entity_type"];
          id: string;
          organization_id: string;
          updated_at: string;
        };
        Insert: {
          author_profile_id?: string | null;
          body: string;
          company_id?: string | null;
          created_at?: string;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["comment_entity_type"];
          id?: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          author_profile_id?: string | null;
          body?: string;
          company_id?: string | null;
          created_at?: string;
          entity_id?: string;
          entity_type?: Database["public"]["Enums"]["comment_entity_type"];
          id?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      companies: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          notes: string | null;
          organization_id: string;
          slug: string;
          stage: Database["public"]["Enums"]["company_stage"];
          updated_at: string;
          website: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          notes?: string | null;
          organization_id: string;
          slug: string;
          stage?: Database["public"]["Enums"]["company_stage"];
          updated_at?: string;
          website?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          notes?: string | null;
          organization_id?: string;
          slug?: string;
          stage?: Database["public"]["Enums"]["company_stage"];
          updated_at?: string;
          website?: string | null;
        };
        Relationships: [];
      };
      company_memberships: {
        Row: {
          company_id: string;
          created_at: string;
          id: string;
          organization_id: string;
          profile_id: string;
          role: Database["public"]["Enums"]["company_role"];
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          id?: string;
          organization_id: string;
          profile_id: string;
          role?: Database["public"]["Enums"]["company_role"];
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
          profile_id?: string;
          role?: Database["public"]["Enums"]["company_role"];
          updated_at?: string;
        };
        Relationships: [];
      };
      contacts: {
        Row: {
          company_id: string;
          created_at: string;
          email: string | null;
          first_name: string;
          id: string;
          last_name: string | null;
          metadata: Json;
          notes: string | null;
          organization_id: string;
          owner_profile_id: string | null;
          phone: string | null;
          stage: Database["public"]["Enums"]["contact_stage"];
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          email?: string | null;
          first_name: string;
          id?: string;
          last_name?: string | null;
          metadata?: Json;
          notes?: string | null;
          organization_id: string;
          owner_profile_id?: string | null;
          phone?: string | null;
          stage?: Database["public"]["Enums"]["contact_stage"];
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          email?: string | null;
          first_name?: string;
          id?: string;
          last_name?: string | null;
          metadata?: Json;
          notes?: string | null;
          organization_id?: string;
          owner_profile_id?: string | null;
          phone?: string | null;
          stage?: Database["public"]["Enums"]["contact_stage"];
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_memberships: {
        Row: {
          created_at: string;
          id: string;
          joined_at: string;
          organization_id: string;
          profile_id: string;
          role: Database["public"]["Enums"]["membership_role"];
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          joined_at?: string;
          organization_id: string;
          profile_id: string;
          role?: Database["public"]["Enums"]["membership_role"];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          joined_at?: string;
          organization_id?: string;
          profile_id?: string;
          role?: Database["public"]["Enums"]["membership_role"];
          updated_at?: string;
        };
        Relationships: [];
      };
      organizations: {
        Row: {
          billing_email: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          slug: string;
          updated_at: string;
        };
        Insert: {
          billing_email?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          slug: string;
          updated_at?: string;
        };
        Update: {
          billing_email?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          slug?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          default_organization_id: string | null;
          email: string;
          full_name: string | null;
          id: string;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          default_organization_id?: string | null;
          email: string;
          full_name?: string | null;
          id: string;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          default_organization_id?: string | null;
          email?: string;
          full_name?: string | null;
          id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          assigned_to_profile_id: string | null;
          booking_id: string | null;
          company_id: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          due_at: string | null;
          id: string;
          organization_id: string;
          priority: Database["public"]["Enums"]["task_priority"];
          status: Database["public"]["Enums"]["task_status"];
          title: string;
          updated_at: string;
          workflow_id: string | null;
        };
        Insert: {
          assigned_to_profile_id?: string | null;
          booking_id?: string | null;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          due_at?: string | null;
          id?: string;
          organization_id: string;
          priority?: Database["public"]["Enums"]["task_priority"];
          status?: Database["public"]["Enums"]["task_status"];
          title: string;
          updated_at?: string;
          workflow_id?: string | null;
        };
        Update: {
          assigned_to_profile_id?: string | null;
          booking_id?: string | null;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          due_at?: string | null;
          id?: string;
          organization_id?: string;
          priority?: Database["public"]["Enums"]["task_priority"];
          status?: Database["public"]["Enums"]["task_status"];
          title?: string;
          updated_at?: string;
          workflow_id?: string | null;
        };
        Relationships: [];
      };
      workflow_event_jobs: {
        Row: {
          activity_event_id: string;
          attempt_count: number;
          available_at: string;
          company_id: string | null;
          completed_at: string | null;
          created_at: string;
          id: string;
          last_attempted_at: string | null;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          organization_id: string;
          started_at: string | null;
          status: Database["public"]["Enums"]["workflow_event_job_status"];
          updated_at: string;
        };
        Insert: {
          activity_event_id: string;
          attempt_count?: number;
          available_at?: string;
          company_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          last_attempted_at?: string | null;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          organization_id: string;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["workflow_event_job_status"];
          updated_at?: string;
        };
        Update: {
          activity_event_id?: string;
          attempt_count?: number;
          available_at?: string;
          company_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          last_attempted_at?: string | null;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          organization_id?: string;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["workflow_event_job_status"];
          updated_at?: string;
        };
        Relationships: [];
      };
      workflow_runs: {
        Row: {
          actions_executed_count: number;
          company_id: string | null;
          completed_at: string | null;
          context_json: Json;
          created_at: string;
          created_tasks_count: number;
          failure_reason: string | null;
          id: string;
          logs_json: Json;
          organization_id: string;
          started_at: string | null;
          status: Database["public"]["Enums"]["workflow_run_status"];
          time_saved_seconds: number;
          trigger_event_id: string | null;
          updated_at: string;
          workflow_id: string;
        };
        Insert: {
          actions_executed_count?: number;
          company_id?: string | null;
          completed_at?: string | null;
          context_json?: Json;
          created_at?: string;
          created_tasks_count?: number;
          failure_reason?: string | null;
          id?: string;
          logs_json?: Json;
          organization_id: string;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["workflow_run_status"];
          time_saved_seconds?: number;
          trigger_event_id?: string | null;
          updated_at?: string;
          workflow_id: string;
        };
        Update: {
          actions_executed_count?: number;
          company_id?: string | null;
          completed_at?: string | null;
          context_json?: Json;
          created_at?: string;
          created_tasks_count?: number;
          failure_reason?: string | null;
          id?: string;
          logs_json?: Json;
          organization_id?: string;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["workflow_run_status"];
          time_saved_seconds?: number;
          trigger_event_id?: string | null;
          updated_at?: string;
          workflow_id?: string;
        };
        Relationships: [];
      };
      workflows: {
        Row: {
          company_id: string | null;
          created_at: string;
          created_by: string | null;
          definition: Json;
          description: string | null;
          id: string;
          name: string;
          organization_id: string;
          slug: string;
          status: Database["public"]["Enums"]["workflow_status"];
          trigger_event: string;
          updated_at: string;
        };
        Insert: {
          company_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          definition?: Json;
          description?: string | null;
          id?: string;
          name: string;
          organization_id: string;
          slug: string;
          status?: Database["public"]["Enums"]["workflow_status"];
          trigger_event: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          definition?: Json;
          description?: string | null;
          id?: string;
          name?: string;
          organization_id?: string;
          slug?: string;
          status?: Database["public"]["Enums"]["workflow_status"];
          trigger_event?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      raw_leads: {
        Row: {
          company_id: string | null;
          contact_id: string | null;
          created_at: string;
          form_type: string | null;
          id: string;
          lead_id: string;
          matched: boolean;
          needs_attention: boolean;
          organization_id: string | null;
          raw_payload: Json;
          received_at: string | null;
          schema_valid: boolean;
          schema_version: number | null;
          source: string | null;
          source_site: string | null;
          updated_at: string;
        };
        Insert: {
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          form_type?: string | null;
          id?: string;
          lead_id: string;
          matched?: boolean;
          needs_attention?: boolean;
          organization_id?: string | null;
          raw_payload: Json;
          received_at?: string | null;
          schema_valid?: boolean;
          schema_version?: number | null;
          source?: string | null;
          source_site?: string | null;
          updated_at?: string;
        };
        Update: {
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          form_type?: string | null;
          id?: string;
          lead_id?: string;
          matched?: boolean;
          needs_attention?: boolean;
          organization_id?: string | null;
          raw_payload?: Json;
          received_at?: string | null;
          schema_valid?: boolean;
          schema_version?: number | null;
          source?: string | null;
          source_site?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      booking_status: "pending" | "confirmed" | "completed" | "cancelled";
      comment_entity_type:
        | "company"
        | "contact"
        | "booking"
        | "task"
        | "workflow"
        | "workflow_run"
        | "activity_event";
      company_role: "lead" | "member" | "viewer";
      company_stage: "prospect" | "active" | "paused" | "archived";
      contact_stage: "lead" | "qualified" | "active" | "closed";
      membership_role: "owner" | "admin" | "member";
      task_priority: "low" | "medium" | "high" | "urgent";
      task_status: "todo" | "in_progress" | "blocked" | "completed";
      workflow_event_job_status: "pending" | "running" | "completed" | "failed";
      workflow_run_status: "pending" | "running" | "completed" | "failed";
      workflow_status: "draft" | "active" | "paused" | "archived";
    };
    CompositeTypes: Record<string, never>;
  };
}

type PublicSchema = Database["public"];

export type TableName = keyof PublicSchema["Tables"];
export type EnumName = keyof PublicSchema["Enums"];

export type Tables<T extends TableName> = PublicSchema["Tables"][T]["Row"];
export type Inserts<T extends TableName> = PublicSchema["Tables"][T]["Insert"];
export type Updates<T extends TableName> = PublicSchema["Tables"][T]["Update"];
export type DbEnum<T extends EnumName> = PublicSchema["Enums"][T];
