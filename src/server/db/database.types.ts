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
          brand_accent_color: string | null;
          brand_from_name: string | null;
          brand_logo_url: string | null;
          brand_primary_color: string | null;
          brand_reply_email: string | null;
          brand_reply_phone: string | null;
          brand_review_url: string | null;
          brand_website_url: string | null;
          cancellation_policy_text: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          notes: string | null;
          organization_id: string;
          owner_email: string | null;
          owner_phone_e164: string | null;
          quote_terms_text: string | null;
          slug: string;
          stage: Database["public"]["Enums"]["company_stage"];
          stripe_account_label: string | null;
          stripe_charges_enabled: boolean;
          stripe_connect_updated_at: string | null;
          stripe_connected_account_id: string | null;
          stripe_details_submitted: boolean;
          stripe_mode: string | null;
          stripe_payouts_enabled: boolean;
          stripe_requirements: Json | null;
          stripe_statement_descriptor_suffix: string | null;
          updated_at: string;
          website: string | null;
          timezone: string | null;
          hours: Json | null;
          service_area: string | null;
        };
        Insert: {
          brand_accent_color?: string | null;
          brand_from_name?: string | null;
          brand_logo_url?: string | null;
          brand_primary_color?: string | null;
          brand_reply_email?: string | null;
          brand_reply_phone?: string | null;
          brand_review_url?: string | null;
          brand_website_url?: string | null;
          cancellation_policy_text?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          notes?: string | null;
          organization_id: string;
          owner_email?: string | null;
          owner_phone_e164?: string | null;
          quote_terms_text?: string | null;
          slug: string;
          stage?: Database["public"]["Enums"]["company_stage"];
          stripe_account_label?: string | null;
          stripe_charges_enabled?: boolean;
          stripe_connect_updated_at?: string | null;
          stripe_connected_account_id?: string | null;
          stripe_details_submitted?: boolean;
          stripe_mode?: string | null;
          stripe_payouts_enabled?: boolean;
          stripe_requirements?: Json | null;
          stripe_statement_descriptor_suffix?: string | null;
          updated_at?: string;
          website?: string | null;
          timezone?: string | null;
          hours?: Json | null;
          service_area?: string | null;
        };
        Update: {
          brand_accent_color?: string | null;
          brand_from_name?: string | null;
          brand_logo_url?: string | null;
          brand_primary_color?: string | null;
          brand_reply_email?: string | null;
          brand_reply_phone?: string | null;
          brand_review_url?: string | null;
          brand_website_url?: string | null;
          cancellation_policy_text?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          notes?: string | null;
          organization_id?: string;
          owner_email?: string | null;
          owner_phone_e164?: string | null;
          quote_terms_text?: string | null;
          slug?: string;
          stage?: Database["public"]["Enums"]["company_stage"];
          stripe_account_label?: string | null;
          stripe_charges_enabled?: boolean;
          stripe_connect_updated_at?: string | null;
          stripe_connected_account_id?: string | null;
          stripe_details_submitted?: boolean;
          stripe_mode?: string | null;
          stripe_payouts_enabled?: boolean;
          stripe_requirements?: Json | null;
          stripe_statement_descriptor_suffix?: string | null;
          updated_at?: string;
          website?: string | null;
          timezone?: string | null;
          hours?: Json | null;
          service_area?: string | null;
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
          /** Generated (stored): last 10 digits of `phone`, else null. Read-only. */
          phone_last10: string | null;
          /** Generated (stored): lower(name + email + phone) for trigram search. Read-only. */
          search_text: string;
          sms_consent_at: string | null;
          sms_opt_out_at: string | null;
          email_opt_out_at: string | null;
          consent_source: string | null;
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
          sms_consent_at?: string | null;
          sms_opt_out_at?: string | null;
          email_opt_out_at?: string | null;
          consent_source?: string | null;
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
          sms_consent_at?: string | null;
          sms_opt_out_at?: string | null;
          email_opt_out_at?: string | null;
          consent_source?: string | null;
          stage?: Database["public"]["Enums"]["contact_stage"];
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_invitations: {
        Row: {
          accepted_at: string | null;
          accepted_by_profile_id: string | null;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by_profile_id: string | null;
          organization_id: string;
          role: Database["public"]["Enums"]["membership_role"];
          status: string;
          token: string;
        };
        Insert: {
          accepted_at?: string | null;
          accepted_by_profile_id?: string | null;
          created_at?: string;
          email: string;
          expires_at?: string;
          id?: string;
          invited_by_profile_id?: string | null;
          organization_id: string;
          role?: Database["public"]["Enums"]["membership_role"];
          status?: string;
          token: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by_profile_id?: string | null;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by_profile_id?: string | null;
          organization_id?: string;
          role?: Database["public"]["Enums"]["membership_role"];
          status?: string;
          token?: string;
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
        Relationships: [
          {
            foreignKeyName: "organization_memberships_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      organizations: {
        Row: {
          billing_email: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          plan: string;
          slug: string;
          stripe_customer_id: string | null;
          subscription_status: string;
          trial_ends_at: string | null;
          updated_at: string;
        };
        Insert: {
          billing_email?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          plan?: string;
          slug: string;
          stripe_customer_id?: string | null;
          subscription_status?: string;
          trial_ends_at?: string | null;
          updated_at?: string;
        };
        Update: {
          billing_email?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          plan?: string;
          slug?: string;
          stripe_customer_id?: string | null;
          subscription_status?: string;
          trial_ends_at?: string | null;
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
          current_step_index: number;
          resume_at: string | null;
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
          current_step_index?: number;
          resume_at?: string | null;
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
          current_step_index?: number;
          resume_at?: string | null;
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
      ai_drafts: {
        Row: {
          analysis: Json;
          booking_id: string | null;
          company_id: string;
          contact_id: string;
          created_at: string;
          created_by: string | null;
          email_body: string | null;
          email_error: string | null;
          email_sent_at: string | null;
          email_status: string;
          email_subject: string | null;
          id: string;
          organization_id: string;
          proposed_slots: Json;
          sms_body: string | null;
          sms_error: string | null;
          sms_sent_at: string | null;
          sms_status: string;
          updated_at: string;
          workflow_id: string | null;
        };
        Insert: {
          analysis: Json;
          booking_id?: string | null;
          company_id: string;
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          email_body?: string | null;
          email_error?: string | null;
          email_sent_at?: string | null;
          email_status?: string;
          email_subject?: string | null;
          id?: string;
          organization_id: string;
          proposed_slots?: Json;
          sms_body?: string | null;
          sms_error?: string | null;
          sms_sent_at?: string | null;
          sms_status?: string;
          updated_at?: string;
          workflow_id?: string | null;
        };
        Update: {
          analysis?: Json;
          booking_id?: string | null;
          company_id?: string;
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          email_body?: string | null;
          email_error?: string | null;
          email_sent_at?: string | null;
          email_status?: string;
          email_subject?: string | null;
          id?: string;
          organization_id?: string;
          proposed_slots?: Json;
          sms_body?: string | null;
          sms_error?: string | null;
          sms_sent_at?: string | null;
          sms_status?: string;
          updated_at?: string;
          workflow_id?: string | null;
        };
        Relationships: [];
      };
      telnyx_numbers: {
        Row: {
          active: boolean;
          brand_label: string | null;
          company_id: string;
          created_at: string;
          id: string;
          organization_id: string;
          phone_e164: string;
          source_site: string;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          brand_label?: string | null;
          company_id: string;
          created_at?: string;
          id?: string;
          organization_id: string;
          phone_e164: string;
          source_site: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          brand_label?: string | null;
          company_id?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
          phone_e164?: string;
          source_site?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      telnyx_quotes: {
        Row: {
          boat_length_ft: number | null;
          boat_type: string | null;
          caller_phone_last10: string | null;
          company_id: string | null;
          created_at: string;
          currency: string;
          deposit_cents: number | null;
          engine_type: string | null;
          error_message: string | null;
          id: string;
          line_items: Json;
          missing_fields: string[];
          organization_id: string;
          quote_total_cents: number | null;
          request_payload: Json;
          service_type: string | null;
          spoken_summary: string | null;
          status: string;
          telnyx_conversation_id: string | null;
          updated_at: string;
        };
        Insert: {
          boat_length_ft?: number | null;
          boat_type?: string | null;
          caller_phone_last10?: string | null;
          company_id?: string | null;
          created_at?: string;
          currency?: string;
          deposit_cents?: number | null;
          engine_type?: string | null;
          error_message?: string | null;
          id?: string;
          line_items?: Json;
          missing_fields?: string[];
          organization_id: string;
          quote_total_cents?: number | null;
          request_payload: Json;
          service_type?: string | null;
          spoken_summary?: string | null;
          status: string;
          telnyx_conversation_id?: string | null;
          updated_at?: string;
        };
        Update: {
          boat_length_ft?: number | null;
          boat_type?: string | null;
          caller_phone_last10?: string | null;
          company_id?: string | null;
          created_at?: string;
          currency?: string;
          deposit_cents?: number | null;
          engine_type?: string | null;
          error_message?: string | null;
          id?: string;
          line_items?: Json;
          missing_fields?: string[];
          organization_id?: string;
          quote_total_cents?: number | null;
          request_payload?: Json;
          service_type?: string | null;
          spoken_summary?: string | null;
          status?: string;
          telnyx_conversation_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      telnyx_call_insights: {
        Row: {
          booked: boolean | null;
          call_outcome: string | null;
          caller_phone_last10: string | null;
          company_id: string | null;
          contact_id: string | null;
          created_at: string;
          id: string;
          lead_id: string | null;
          lead_quality: string | null;
          organization_id: string | null;
          raw_payload: Json | null;
          requested_service: string | null;
          telnyx_conversation_id: string;
          updated_at: string;
        };
        Insert: {
          booked?: boolean | null;
          call_outcome?: string | null;
          caller_phone_last10?: string | null;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          lead_id?: string | null;
          lead_quality?: string | null;
          organization_id?: string | null;
          raw_payload?: Json | null;
          requested_service?: string | null;
          telnyx_conversation_id: string;
          updated_at?: string;
        };
        Update: {
          booked?: boolean | null;
          call_outcome?: string | null;
          caller_phone_last10?: string | null;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          lead_id?: string | null;
          lead_quality?: string | null;
          organization_id?: string | null;
          raw_payload?: Json | null;
          requested_service?: string | null;
          telnyx_conversation_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      billing_events: {
        Row: {
          id: string;
          organization_id: string | null;
          payload: Json;
          processed_at: string | null;
          received_at: string;
          stripe_event_id: string;
          type: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          payload: Json;
          processed_at?: string | null;
          received_at?: string;
          stripe_event_id: string;
          type: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          payload?: Json;
          processed_at?: string | null;
          received_at?: string;
          stripe_event_id?: string;
          type?: string;
        };
        Relationships: [];
      };
      billing_event_jobs: {
        Row: {
          attempt_count: number;
          available_at: string;
          billing_event_id: string;
          completed_at: string | null;
          created_at: string;
          id: string;
          last_attempted_at: string | null;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          started_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempt_count?: number;
          available_at?: string;
          billing_event_id: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          last_attempted_at?: string | null;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempt_count?: number;
          available_at?: string;
          billing_event_id?: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          last_attempted_at?: string | null;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      feature_flags: {
        Row: {
          created_at: string;
          enabled: boolean;
          feature: string;
          limit_value: number | null;
          organization_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          enabled?: boolean;
          feature: string;
          limit_value?: number | null;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          feature?: string;
          limit_value?: number | null;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          created_at: string;
          current_period_end: string | null;
          id: string;
          organization_id: string;
          plan: string;
          status: string;
          stripe_subscription_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          current_period_end?: string | null;
          id?: string;
          organization_id: string;
          plan: string;
          status: string;
          stripe_subscription_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          current_period_end?: string | null;
          id?: string;
          organization_id?: string;
          plan?: string;
          status?: string;
          stripe_subscription_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      jobber_connections: {
        Row: {
          access_token: string | null;
          connected_at: string | null;
          created_at: string;
          jobber_account_name: string | null;
          organization_id: string;
          refresh_lock_at: string | null;
          refresh_token: string | null;
          scope: string | null;
          token_expires_at: string | null;
          updated_at: string;
        };
        Insert: {
          access_token?: string | null;
          connected_at?: string | null;
          created_at?: string;
          jobber_account_name?: string | null;
          organization_id: string;
          refresh_lock_at?: string | null;
          refresh_token?: string | null;
          scope?: string | null;
          token_expires_at?: string | null;
          updated_at?: string;
        };
        Update: {
          access_token?: string | null;
          connected_at?: string | null;
          created_at?: string;
          jobber_account_name?: string | null;
          organization_id?: string;
          refresh_lock_at?: string | null;
          refresh_token?: string | null;
          scope?: string | null;
          token_expires_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      jobber_sync_jobs: {
        Row: {
          attempt_count: number;
          available_at: string;
          company_id: string | null;
          completed_at: string | null;
          contact_id: string | null;
          created_at: string;
          id: string;
          jobber_client_id: string | null;
          jobber_quote_id: string | null;
          last_attempted_at: string | null;
          last_error: string | null;
          lead_id: string;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          organization_id: string;
          payload: Json;
          started_at: string | null;
          status: Database["public"]["Enums"]["jobber_sync_job_status"];
          updated_at: string;
        };
        Insert: {
          attempt_count?: number;
          available_at?: string;
          company_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          jobber_client_id?: string | null;
          jobber_quote_id?: string | null;
          last_attempted_at?: string | null;
          last_error?: string | null;
          lead_id: string;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          organization_id: string;
          payload?: Json;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["jobber_sync_job_status"];
          updated_at?: string;
        };
        Update: {
          attempt_count?: number;
          available_at?: string;
          company_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          jobber_client_id?: string | null;
          jobber_quote_id?: string | null;
          last_attempted_at?: string | null;
          last_error?: string | null;
          lead_id?: string;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          organization_id?: string;
          payload?: Json;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["jobber_sync_job_status"];
          updated_at?: string;
        };
        Relationships: [];
      };
      retell_calls: {
        Row: {
          agent_id: string | null;
          call_analysis: Json | null;
          call_id: string;
          call_successful: boolean | null;
          call_summary: string | null;
          caller_phone_last10: string | null;
          company_id: string | null;
          contact_id: string | null;
          created_at: string;
          custom_analysis_data: Json | null;
          direction: string | null;
          event: string | null;
          from_number: string | null;
          id: string;
          in_voicemail: boolean | null;
          is_urgent: boolean;
          lead_id: string | null;
          organization_id: string | null;
          processed_at: string | null;
          raw_payload: Json;
          received_at: string | null;
          to_number: string | null;
          transcript: string | null;
          transcript_object: Json | null;
          updated_at: string;
          user_sentiment: string | null;
          call_cost_cents: number | null;
          cost_breakdown: Json | null;
          duration_ms: number | null;
          end_timestamp: string | null;
          start_timestamp: string | null;
        };
        Insert: {
          agent_id?: string | null;
          call_analysis?: Json | null;
          call_id: string;
          call_successful?: boolean | null;
          call_summary?: string | null;
          caller_phone_last10?: string | null;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          custom_analysis_data?: Json | null;
          direction?: string | null;
          event?: string | null;
          from_number?: string | null;
          id?: string;
          in_voicemail?: boolean | null;
          is_urgent?: boolean;
          lead_id?: string | null;
          organization_id?: string | null;
          processed_at?: string | null;
          raw_payload: Json;
          received_at?: string | null;
          to_number?: string | null;
          transcript?: string | null;
          transcript_object?: Json | null;
          updated_at?: string;
          user_sentiment?: string | null;
          call_cost_cents?: number | null;
          cost_breakdown?: Json | null;
          duration_ms?: number | null;
          end_timestamp?: string | null;
          start_timestamp?: string | null;
        };
        Update: {
          agent_id?: string | null;
          call_analysis?: Json | null;
          call_id?: string;
          call_successful?: boolean | null;
          call_summary?: string | null;
          caller_phone_last10?: string | null;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          custom_analysis_data?: Json | null;
          direction?: string | null;
          event?: string | null;
          from_number?: string | null;
          id?: string;
          in_voicemail?: boolean | null;
          is_urgent?: boolean;
          lead_id?: string | null;
          organization_id?: string | null;
          processed_at?: string | null;
          raw_payload?: Json;
          received_at?: string | null;
          to_number?: string | null;
          transcript?: string | null;
          transcript_object?: Json | null;
          updated_at?: string;
          user_sentiment?: string | null;
          call_cost_cents?: number | null;
          cost_breakdown?: Json | null;
          duration_ms?: number | null;
          end_timestamp?: string | null;
          start_timestamp?: string | null;
        };
        Relationships: [];
      };
      quotes: {
        Row: {
          approved_at: string | null;
          approved_by_name: string | null;
          approved_deposit_cents: number | null;
          approved_ip: string | null;
          approved_line_items: Json | null;
          approved_subtotal_cents: number | null;
          approved_tax_cents: number | null;
          approved_total_cents: number | null;
          approved_user_agent: string | null;
          auto_generated: boolean;
          balance_paid_at: string | null;
          bundle_id: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          company_id: string | null;
          completed_at: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          deposit_cents: number;
          deposit_paid_at: string | null;
          deposit_rate_bps: number;
          expires_at: string | null;
          expiry_reminder_sent_at: string | null;
          first_viewed_at: string | null;
          id: string;
          input_snapshot: Json;
          intro_message: string | null;
          line_items: Json;
          notes: string | null;
          organization_id: string;
          public_token: string;
          quote_number: string | null;
          sent_at: string | null;
          source: string | null;
          source_lead_id: string | null;
          status: string;
          stripe_checkout_session_id: string | null;
          stripe_customer_id: string | null;
          stripe_invoice_id: string | null;
          stripe_payment_intent_id: string | null;
          stripe_payment_method_id: string | null;
          subtotal_cents: number;
          superseded_by: string | null;
          supersedes: string | null;
          tax_cents: number;
          tax_rate_bps: number;
          terms_accepted: boolean;
          title: string | null;
          total_cents: number;
          updated_at: string;
          valid_until: string | null;
        };
        Insert: {
          approved_at?: string | null;
          approved_by_name?: string | null;
          approved_deposit_cents?: number | null;
          approved_ip?: string | null;
          approved_line_items?: Json | null;
          approved_subtotal_cents?: number | null;
          approved_tax_cents?: number | null;
          approved_total_cents?: number | null;
          approved_user_agent?: string | null;
          auto_generated?: boolean;
          balance_paid_at?: string | null;
          bundle_id?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          company_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          deposit_cents?: number;
          deposit_paid_at?: string | null;
          deposit_rate_bps?: number;
          expires_at?: string | null;
          expiry_reminder_sent_at?: string | null;
          first_viewed_at?: string | null;
          id?: string;
          input_snapshot?: Json;
          intro_message?: string | null;
          line_items?: Json;
          notes?: string | null;
          organization_id: string;
          public_token: string;
          quote_number?: string | null;
          sent_at?: string | null;
          source?: string | null;
          source_lead_id?: string | null;
          status?: string;
          stripe_checkout_session_id?: string | null;
          stripe_customer_id?: string | null;
          stripe_invoice_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_payment_method_id?: string | null;
          subtotal_cents?: number;
          superseded_by?: string | null;
          supersedes?: string | null;
          tax_cents?: number;
          tax_rate_bps?: number;
          terms_accepted?: boolean;
          title?: string | null;
          total_cents?: number;
          updated_at?: string;
          valid_until?: string | null;
        };
        Update: {
          approved_at?: string | null;
          approved_by_name?: string | null;
          approved_deposit_cents?: number | null;
          approved_ip?: string | null;
          approved_line_items?: Json | null;
          approved_subtotal_cents?: number | null;
          approved_tax_cents?: number | null;
          approved_total_cents?: number | null;
          approved_user_agent?: string | null;
          auto_generated?: boolean;
          balance_paid_at?: string | null;
          bundle_id?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          company_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          deposit_cents?: number;
          deposit_paid_at?: string | null;
          deposit_rate_bps?: number;
          expires_at?: string | null;
          expiry_reminder_sent_at?: string | null;
          first_viewed_at?: string | null;
          id?: string;
          input_snapshot?: Json;
          intro_message?: string | null;
          line_items?: Json;
          notes?: string | null;
          organization_id?: string;
          public_token?: string;
          quote_number?: string | null;
          sent_at?: string | null;
          source?: string | null;
          source_lead_id?: string | null;
          status?: string;
          stripe_checkout_session_id?: string | null;
          stripe_customer_id?: string | null;
          stripe_invoice_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_payment_method_id?: string | null;
          subtotal_cents?: number;
          superseded_by?: string | null;
          supersedes?: string | null;
          tax_cents?: number;
          tax_rate_bps?: number;
          terms_accepted?: boolean;
          title?: string | null;
          total_cents?: number;
          updated_at?: string;
          valid_until?: string | null;
        };
        Relationships: [];
      };
      quote_events: {
        Row: {
          actor_profile_id: string | null;
          created_at: string;
          event_type: string;
          id: string;
          metadata: Json;
          organization_id: string;
          quote_id: string;
        };
        Insert: {
          actor_profile_id?: string | null;
          created_at?: string;
          event_type: string;
          id?: string;
          metadata?: Json;
          organization_id: string;
          quote_id: string;
        };
        Update: {
          actor_profile_id?: string | null;
          created_at?: string;
          event_type?: string;
          id?: string;
          metadata?: Json;
          organization_id?: string;
          quote_id?: string;
        };
        Relationships: [];
      };
      quote_number_counters: {
        Row: {
          last_number: number;
          organization_id: string;
          year: number;
        };
        Insert: {
          last_number?: number;
          organization_id: string;
          year: number;
        };
        Update: {
          last_number?: number;
          organization_id?: string;
          year?: number;
        };
        Relationships: [];
      };
      company_voice_profiles: {
        Row: {
          active: boolean;
          brand_label: string | null;
          company_id: string;
          created_at: string;
          created_by: string | null;
          dynamic_variables: Json;
          from_number: string | null;
          id: string;
          organization_id: string;
          retell_outbound_agent_id: string | null;
          system_prompt: string | null;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          brand_label?: string | null;
          company_id: string;
          created_at?: string;
          created_by?: string | null;
          dynamic_variables?: Json;
          from_number?: string | null;
          id?: string;
          organization_id: string;
          retell_outbound_agent_id?: string | null;
          system_prompt?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          brand_label?: string | null;
          company_id?: string;
          created_at?: string;
          created_by?: string | null;
          dynamic_variables?: Json;
          from_number?: string | null;
          id?: string;
          organization_id?: string;
          retell_outbound_agent_id?: string | null;
          system_prompt?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      company_stripe_customers: {
        Row: {
          company_id: string;
          contact_id: string;
          created_at: string;
          organization_id: string;
          stripe_customer_id: string;
        };
        Insert: {
          company_id: string;
          contact_id: string;
          created_at?: string;
          organization_id: string;
          stripe_customer_id: string;
        };
        Update: {
          company_id?: string;
          contact_id?: string;
          created_at?: string;
          organization_id?: string;
          stripe_customer_id?: string;
        };
        Relationships: [];
      };
      service_catalog_items: {
        Row: {
          active: boolean;
          additional_unit_multiplier: number | null;
          company_id: string;
          created_at: string;
          description: string | null;
          id: string;
          label: string;
          max_measure: number | null;
          max_quantity: number | null;
          minimum_cents: number;
          modifier_groups: Json | null;
          organization_id: string;
          pricing_type: string;
          rate_bands: Json | null;
          rate_cents: number;
          review_rules: Json | null;
          service_key: string;
          sort_order: number;
          surcharge_eligible: boolean;
          tiers: Json | null;
          unit_label: string | null;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          additional_unit_multiplier?: number | null;
          company_id: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          label: string;
          max_measure?: number | null;
          max_quantity?: number | null;
          minimum_cents?: number;
          modifier_groups?: Json | null;
          organization_id: string;
          pricing_type: string;
          rate_bands?: Json | null;
          rate_cents?: number;
          review_rules?: Json | null;
          service_key: string;
          sort_order?: number;
          surcharge_eligible?: boolean;
          tiers?: Json | null;
          unit_label?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          additional_unit_multiplier?: number | null;
          company_id?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          label?: string;
          max_measure?: number | null;
          max_quantity?: number | null;
          minimum_cents?: number;
          modifier_groups?: Json | null;
          organization_id?: string;
          pricing_type?: string;
          rate_bands?: Json | null;
          rate_cents?: number;
          review_rules?: Json | null;
          service_key?: string;
          sort_order?: number;
          surcharge_eligible?: boolean;
          tiers?: Json | null;
          unit_label?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      service_catalog_bundles: {
        Row: {
          active: boolean;
          bundle_key: string;
          company_id: string;
          created_at: string;
          discount_pct: number;
          id: string;
          label: string;
          organization_id: string;
          service_keys: string[];
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          bundle_key: string;
          company_id: string;
          created_at?: string;
          discount_pct: number;
          id?: string;
          label: string;
          organization_id: string;
          service_keys?: string[];
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          bundle_key?: string;
          company_id?: string;
          created_at?: string;
          discount_pct?: number;
          id?: string;
          label?: string;
          organization_id?: string;
          service_keys?: string[];
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      service_catalog_surcharges: {
        Row: {
          active: boolean;
          company_id: string;
          created_at: string;
          id: string;
          label: string;
          organization_id: string;
          per_measure_cents: number;
          updated_at: string;
          variant_key: string;
        };
        Insert: {
          active?: boolean;
          company_id: string;
          created_at?: string;
          id?: string;
          label: string;
          organization_id: string;
          per_measure_cents?: number;
          updated_at?: string;
          variant_key: string;
        };
        Update: {
          active?: boolean;
          company_id?: string;
          created_at?: string;
          id?: string;
          label?: string;
          organization_id?: string;
          per_measure_cents?: number;
          updated_at?: string;
          variant_key?: string;
        };
        Relationships: [];
      };
      waitlist: {
        Row: {
          business: string | null;
          created_at: string;
          email: string;
          id: string;
          metadata: Json;
          source: string;
        };
        Insert: {
          business?: string | null;
          created_at?: string;
          email: string;
          id?: string;
          metadata?: Json;
          source?: string;
        };
        Update: {
          business?: string | null;
          created_at?: string;
          email?: string;
          id?: string;
          metadata?: Json;
          source?: string;
        };
        Relationships: [];
      };
      inbound_webhook_jobs: {
        Row: {
          attempts: number;
          claimed_at: string | null;
          claimed_by: string | null;
          company_id: string | null;
          created_at: string;
          external_id: string;
          id: string;
          last_error: string | null;
          max_attempts: number;
          organization_id: string | null;
          payload: Json;
          provider: string;
          run_at: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          claimed_at?: string | null;
          claimed_by?: string | null;
          company_id?: string | null;
          created_at?: string;
          external_id: string;
          id?: string;
          last_error?: string | null;
          max_attempts?: number;
          organization_id?: string | null;
          payload: Json;
          provider: string;
          run_at?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          claimed_at?: string | null;
          claimed_by?: string | null;
          company_id?: string | null;
          created_at?: string;
          external_id?: string;
          id?: string;
          last_error?: string | null;
          max_attempts?: number;
          organization_id?: string | null;
          payload?: Json;
          provider?: string;
          run_at?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      rate_limit_buckets: {
        Row: {
          bucket_key: string;
          hits: number;
          window_started_at: string;
        };
        Insert: {
          bucket_key: string;
          hits?: number;
          window_started_at?: string;
        };
        Update: {
          bucket_key?: string;
          hits?: number;
          window_started_at?: string;
        };
        Relationships: [];
      };
      usage_events: {
        Row: {
          company_id: string | null;
          cost_cents: number | null;
          created_at: string;
          id: string;
          kind: string;
          metadata: Json | null;
          occurred_at: string;
          organization_id: string;
          provider: string | null;
          provider_ref: string | null;
          quantity: number;
          unit: string;
        };
        Insert: {
          company_id?: string | null;
          cost_cents?: number | null;
          created_at?: string;
          id?: string;
          kind: string;
          metadata?: Json | null;
          occurred_at?: string;
          organization_id: string;
          provider?: string | null;
          provider_ref?: string | null;
          quantity: number;
          unit: string;
        };
        Update: {
          company_id?: string | null;
          cost_cents?: number | null;
          created_at?: string;
          id?: string;
          kind?: string;
          metadata?: Json | null;
          occurred_at?: string;
          organization_id?: string;
          provider?: string | null;
          provider_ref?: string | null;
          quantity?: number;
          unit?: string;
        };
        Relationships: [];
      };
      intake_keys: {
        Row: {
          active: boolean;
          company_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          key_hash: string;
          key_prefix: string;
          label: string | null;
          last_used_at: string | null;
          organization_id: string;
        };
        Insert: {
          active?: boolean;
          company_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          key_hash: string;
          key_prefix: string;
          label?: string | null;
          last_used_at?: string | null;
          organization_id: string;
        };
        Update: {
          active?: boolean;
          company_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          key_hash?: string;
          key_prefix?: string;
          label?: string | null;
          last_used_at?: string | null;
          organization_id?: string;
        };
        Relationships: [];
      };
      voice_numbers: {
        Row: {
          active: boolean;
          brand_label: string | null;
          company_id: string;
          created_at: string;
          id: string;
          organization_id: string;
          phone_e164: string;
          provider: string;
          provider_agent_id: string | null;
        };
        Insert: {
          active?: boolean;
          brand_label?: string | null;
          company_id: string;
          created_at?: string;
          id?: string;
          organization_id: string;
          phone_e164: string;
          provider: string;
          provider_agent_id?: string | null;
        };
        Update: {
          active?: boolean;
          brand_label?: string | null;
          company_id?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
          phone_e164?: string;
          provider?: string;
          provider_agent_id?: string | null;
        };
        Relationships: [];
      };
      message_log: {
        Row: {
          body: string | null;
          channel: string;
          company_id: string | null;
          contact_id: string | null;
          created_at: string;
          direction: string;
          error: string | null;
          from_addr: string | null;
          id: string;
          organization_id: string;
          provider: string | null;
          provider_ref: string | null;
          status: string;
          subject: string | null;
          to_addr: string | null;
          workflow_run_id: string | null;
        };
        Insert: {
          body?: string | null;
          channel: string;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          direction: string;
          error?: string | null;
          from_addr?: string | null;
          id?: string;
          organization_id: string;
          provider?: string | null;
          provider_ref?: string | null;
          status: string;
          subject?: string | null;
          to_addr?: string | null;
          workflow_run_id?: string | null;
        };
        Update: {
          body?: string | null;
          channel?: string;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          direction?: string;
          error?: string | null;
          from_addr?: string | null;
          id?: string;
          organization_id?: string;
          provider?: string | null;
          provider_ref?: string | null;
          status?: string;
          subject?: string | null;
          to_addr?: string | null;
          workflow_run_id?: string | null;
        };
        Relationships: [];
      };
      workflow_schedule_ticks: {
        Row: {
          claimed_at: string | null;
          claimed_by: string | null;
          created_at: string;
          id: string;
          last_error: string | null;
          organization_id: string;
          scheduled_for: string;
          status: string;
          workflow_id: string;
        };
        Insert: {
          claimed_at?: string | null;
          claimed_by?: string | null;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          organization_id: string;
          scheduled_for: string;
          status?: string;
          workflow_id: string;
        };
        Update: {
          claimed_at?: string | null;
          claimed_by?: string | null;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          organization_id?: string;
          scheduled_for?: string;
          status?: string;
          workflow_id?: string;
        };
        Relationships: [];
      };
      onboarding_progress: {
        Row: {
          id: string;
          organization_id: string;
          company_id: string;
          step: string;
          status: string;
          data: Json;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          company_id: string;
          step: string;
          status?: string;
          data?: Json;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          company_id?: string;
          step?: string;
          status?: string;
          data?: Json;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      onboarding_events: {
        Row: {
          id: string;
          organization_id: string;
          company_id: string | null;
          step: string;
          event: string;
          occurred_at: string;
          metadata: Json;
        };
        Insert: {
          id?: string;
          organization_id: string;
          company_id?: string | null;
          step: string;
          event: string;
          occurred_at?: string;
          metadata?: Json;
        };
        Update: {
          id?: string;
          organization_id?: string;
          company_id?: string | null;
          step?: string;
          event?: string;
          occurred_at?: string;
          metadata?: Json;
        };
        Relationships: [];
      };
    };
    Views: {
      revenue_attribution_v: {
        Row: {
          approved_at: string | null;
          approved_cents: number | null;
          auto_generated: boolean | null;
          automation_involved: boolean | null;
          company_id: string | null;
          contact_id: string | null;
          first_touch_at: string | null;
          first_touch_channel: string | null;
          first_touch_source: string | null;
          organization_id: string | null;
          paid_at: string | null;
          paid_cents: number | null;
          quote_id: string | null;
          voice_ai_involved: boolean | null;
        };
        Relationships: [];
      };
      ui_contact_list_v: {
        Row: {
          bookings_count: number | null;
          company_id: string | null;
          company_name: string | null;
          company_stage: string | null;
          email: string | null;
          id: string | null;
          last_activity_at: string | null;
          last_activity_event_type: string | null;
          name: string | null;
          next_action_detail: string | null;
          next_action_due_at: string | null;
          next_action_label: string | null;
          next_action_type: string | null;
          organization_id: string | null;
          owner_email: string | null;
          owner_full_name: string | null;
          owner_id: string | null;
          owner_profile_id: string | null;
          phone: string | null;
          pipeline_value_cents: number | null;
          realized_revenue_cents: number | null;
          search_text: string | null;
          stage: string | null;
          upcoming_bookings_count: number | null;
        };
        Relationships: [];
      };
      ui_task_list_v: {
        Row: {
          assigned_to_profile_id: string | null;
          assignee_email: string | null;
          assignee_full_name: string | null;
          assignee_id: string | null;
          booking_id: string | null;
          booking_title: string | null;
          comments_count: number | null;
          company_id: string | null;
          company_name: string | null;
          company_stage: string | null;
          contact_company_id: string | null;
          contact_company_name: string | null;
          contact_company_stage: string | null;
          contact_email: string | null;
          contact_first_name: string | null;
          contact_last_name: string | null;
          contact_id: string | null;
          contact_phone: string | null;
          contact_stage: string | null;
          created_at: string | null;
          description: string | null;
          due_at: string | null;
          id: string | null;
          is_overdue: boolean | null;
          organization_id: string | null;
          priority: string | null;
          search_text: string | null;
          status: string | null;
          title: string | null;
          workflow_id: string | null;
          workflow_name: string | null;
        };
        Relationships: [];
      };
      ui_workflow_jobs_v: {
        Row: {
          activity_event_id: string | null;
          activity_event_type: string | null;
          attempt_count: number | null;
          available_at: string | null;
          company_id: string | null;
          company_name: string | null;
          company_stage: string | null;
          completed_at: string | null;
          created_at: string | null;
          id: string | null;
          last_attempted_at: string | null;
          last_error: string | null;
          locked_at: string | null;
          organization_id: string | null;
          status: string | null;
        };
        Relationships: [];
      };
      ui_workflow_list_v: {
        Row: {
          company_id: string | null;
          company_name: string | null;
          company_stage: string | null;
          created_at: string | null;
          description: string | null;
          failed_runs: number | null;
          id: string | null;
          last_run_at: string | null;
          last_run_status: string | null;
          name: string | null;
          organization_id: string | null;
          recent_runs_count: number | null;
          status: string | null;
          successful_runs: number | null;
          total_runs: number | null;
          trigger_type: string | null;
        };
        Relationships: [];
      };
      usage_monthly_v: {
        Row: {
          company_id: string | null;
          cost_cents: number | null;
          kind: string | null;
          month: string | null;
          organization_id: string | null;
          quantity: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      claim_billing_event_jobs: {
        Args: {
          p_worker_id: string;
          p_limit?: number;
          p_stale_after_seconds?: number;
        };
        Returns: Database["public"]["Tables"]["billing_event_jobs"]["Row"][];
      };
      claim_waiting_workflow_runs: {
        Args: {
          p_batch?: number;
          p_stale_after_seconds?: number;
        };
        Returns: Database["public"]["Tables"]["workflow_runs"]["Row"][];
      };
      claim_workflow_schedule_ticks: {
        Args: {
          p_batch?: number;
          p_worker_id?: string;
          p_stale_after_seconds?: number;
        };
        Returns: Database["public"]["Tables"]["workflow_schedule_ticks"]["Row"][];
      };
      claim_inbound_webhook_jobs: {
        Args: {
          p_batch?: number;
          p_worker_id?: string;
          p_stale_after_seconds?: number;
        };
        Returns: Database["public"]["Tables"]["inbound_webhook_jobs"]["Row"][];
      };
      claim_jobber_sync_jobs: {
        Args: {
          p_worker_id: string;
          p_limit?: number;
          p_stale_after_seconds?: number;
        };
        Returns: Database["public"]["Tables"]["jobber_sync_jobs"]["Row"][];
      };
      claim_workflow_event_jobs: {
        Args: {
          p_worker_id: string;
          p_limit?: number;
          p_stale_after_seconds?: number;
        };
        Returns: Database["public"]["Tables"]["workflow_event_jobs"]["Row"][];
      };
      consume_rate_limit: {
        Args: {
          p_key: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: boolean;
      };
      next_quote_number: {
        Args: {
          p_organization_id: string;
        };
        Returns: string;
      };
      record_billing_event: {
        Args: {
          p_stripe_event_id: string;
          p_type: string;
          p_payload: Json;
          p_organization_id?: string;
        };
        Returns: string;
      };
      ui_activity_feed: {
        Args: {
          p_org_id: string;
          p_company_id?: string;
          p_limit?: number;
          p_before_ts?: string;
        };
        Returns: Database["public"]["Tables"]["activity_events"]["Row"][];
      };
      ui_attribution_summary: {
        Args: {
          p_org_id: string;
          p_company_id?: string;
          p_from?: string;
          p_to?: string;
        };
        Returns: {
          quotes_count: number;
          approved_cents_total: number;
          paid_cents_total: number;
          voice_ai_count: number;
          voice_ai_approved_cents: number;
          voice_ai_paid_cents: number;
          automation_count: number;
          automation_approved_cents: number;
          automation_paid_cents: number;
          estimated_time_saved_seconds: number;
          by_source: Json;
          by_channel: Json;
        }[];
      };
      ui_automation_impact: {
        Args: {
          p_org_id: string;
          p_company_id?: string;
          p_since_ts?: string;
        };
        Returns: {
          estimated_time_saved_seconds: number;
          failed_jobs_count: number;
          successful_runs: number;
          tasks_auto_created: number;
          total_workflow_runs: number;
        }[];
      };
      ui_calendar_bookings: {
        Args: {
          p_org_id: string;
          p_company_id?: string;
          p_from_ts?: string;
          p_to_ts?: string;
        };
        Returns: {
          id: string;
          scheduled_for: string;
          duration_minutes: number;
          status: string;
          title: string;
          description: string | null;
          company_id: string | null;
          company_name: string | null;
          company_stage: string | null;
          contact_id: string | null;
          contact_name: string | null;
          contact_email: string | null;
          contact_phone: string | null;
          contact_stage: string | null;
          contact_company_id: string | null;
          contact_company_name: string | null;
          contact_company_stage: string | null;
          task_count: number;
          highest_priority: string | null;
          assigned_profile_ids: string[];
          revenue_cents: number | null;
        }[];
      };
      ui_contact_detail: {
        Args: { p_org_id: string; p_contact_id: string };
        Returns: Json;
      };
      ui_dashboard_summary: {
        Args: { p_org_id: string; p_company_id?: string };
        Returns: {
          active_workflow_count: number;
          failed_workflow_job_count: number;
          new_lead_count: number;
          overdue_task_count: number;
          revenue_today_cents: number;
          revenue_week_cents: number;
          today_booking_count: number;
          upcoming_booking_count: number;
          urgent_task_count: number;
        }[];
      };
      ui_task_detail: {
        Args: { p_org_id: string; p_task_id: string };
        Returns: Json;
      };
      ui_value_cents: {
        Args: { p: Json };
        Returns: number;
      };
      ui_workflow_detail: {
        Args: { p_org_id: string; p_workflow_id: string };
        Returns: Json;
      };
    };
    Enums: {
      booking_status: "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
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
      jobber_sync_job_status:
        | "pending"
        | "running"
        | "completed"
        | "failed"
        | "manual_review";
      membership_role: "owner" | "admin" | "member";
      task_priority: "low" | "medium" | "high" | "urgent";
      task_status: "todo" | "in_progress" | "blocked" | "completed";
      workflow_event_job_status: "pending" | "running" | "completed" | "failed";
      workflow_run_status: "pending" | "running" | "completed" | "failed" | "waiting";
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
