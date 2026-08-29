import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { sendEmail } from "@/server/outbound/email";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { TenantServiceContext } from "@/server/services/shared";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

// Only admin/member are invitable — ownership is transferred by promoting an existing
// member, never handed out through an invite link.
export const createInvitationInputSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(["admin", "member"]).default("member"),
});

export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>;

export interface InvitationSummary {
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  role: Tables<"organization_invitations">["role"];
  status: string;
  token: string;
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function invitationUrl(token: string): string {
  return `${appBaseUrl()}/invite/${token}`;
}

function toInvitationSummary(row: Tables<"organization_invitations">): InvitationSummary {
  return {
    createdAt: row.created_at,
    email: row.email,
    expiresAt: row.expires_at,
    id: row.id,
    role: row.role,
    status: row.status,
    token: row.token,
  };
}

export async function listInvitations(
  context: TenantServiceContext,
  options: { status?: string } = {},
): Promise<InvitationSummary[]> {
  let query = context.supabase
    .from("organization_invitations")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

  if (options.status) {
    query = query.eq("status", options.status);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return (data ?? []).map(toInvitationSummary);
}

export async function createInvitation(
  context: TenantServiceContext,
  input: CreateInvitationInput,
): Promise<{ emailSent: boolean; invitation: InvitationSummary; inviteUrl: string }> {
  const email = input.email.trim().toLowerCase();

  // Reject inviting someone who is already a member of this org.
  const { data: matchingProfiles, error: profileError } = await context.supabase
    .from("profiles")
    .select("id")
    .ilike("email", email);

  if (profileError) {
    throw profileError;
  }

  const profileIds = (matchingProfiles ?? []).map((profile) => profile.id);
  if (profileIds.length > 0) {
    const { data: membership, error: membershipError } = await context.supabase
      .from("organization_memberships")
      .select("id")
      .eq("organization_id", context.organizationId)
      .in("profile_id", profileIds)
      .maybeSingle();

    if (membershipError) {
      throw membershipError;
    }

    if (membership) {
      throw new ValidationError("That person is already a member of this organization.");
    }
  }

  const token = randomBytes(24).toString("hex");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertQuery = (context.supabase.from("organization_invitations") as any)
    .insert({
      email,
      invited_by_profile_id: context.actorProfileId,
      organization_id: context.organizationId,
      role: input.role,
      token,
    })
    .select("*")
    .single();
  const { data, error } = await insertQuery as {
    data: Tables<"organization_invitations"> | null;
    error: { code?: string } | null;
  };

  if (error) {
    // Partial unique index on (organization_id, lower(email)) where status = 'pending'.
    if (error.code === "23505") {
      throw new ValidationError("There is already a pending invitation for that email.");
    }
    throw error;
  }

  if (!data) {
    throw new Error("Invitation creation failed.");
  }

  const inviteUrl = invitationUrl(token);

  // Best-effort email — the admin always gets a copyable link back regardless, so a
  // missing RESEND config or a transient send failure never blocks the invitation.
  let emailSent = false;
  try {
    await sendEmail({
      to: email,
      subject: "You've been invited to join a team on EmpireVu",
      body: `You've been invited to join a team on EmpireVu as ${input.role}.\n\nAccept your invitation:\n${inviteUrl}\n\nThis link expires in 7 days.`,
    });
    emailSent = true;
  } catch {
    emailSent = false;
  }

  return { emailSent, invitation: toInvitationSummary(data), inviteUrl };
}

export async function revokeInvitation(
  context: TenantServiceContext,
  invitationId: string,
): Promise<{ id: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("organization_invitations") as any)
    .update({ status: "revoked" })
    .eq("organization_id", context.organizationId)
    .eq("id", invitationId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  const { data, error } = await query as { data: { id: string } | null; error: unknown };

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Invitation not found or already resolved.");
  }

  return { id: data.id };
}

export interface InvitationPreview {
  email: string;
  expired: boolean;
  organizationId: string;
  organizationName: string;
  role: Tables<"organization_invitations">["role"];
  status: string;
}

/** Public token lookup for the accept page — runs through the service role. */
export async function getInvitationByToken(
  admin: AdminClient,
  token: string,
): Promise<InvitationPreview | null> {
  const { data: invitationData, error } = await admin
    .from("organization_invitations")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const invitation = invitationData as Tables<"organization_invitations"> | null;
  if (!invitation) {
    return null;
  }

  const { data: organizationData } = await admin
    .from("organizations")
    .select("name")
    .eq("id", invitation.organization_id)
    .maybeSingle();
  const organization = organizationData as { name: string } | null;

  return {
    email: invitation.email,
    expired: new Date(invitation.expires_at) < new Date(),
    organizationId: invitation.organization_id,
    organizationName: organization?.name ?? "an organization",
    role: invitation.role,
    status: invitation.status,
  };
}

/**
 * Accept an invitation for the authenticated user. Runs through the service role because
 * the invitee is not yet a member, so RLS would otherwise block the membership insert.
 * Idempotent: re-accepting an already-accepted invite just returns the org.
 */
export async function acceptInvitation(
  admin: AdminClient,
  input: { token: string; userEmail: string | null; userId: string },
): Promise<{ organizationId: string }> {
  const { data: invitationData, error } = await admin
    .from("organization_invitations")
    .select("*")
    .eq("token", input.token)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const invitation = invitationData as Tables<"organization_invitations"> | null;
  if (!invitation) {
    throw new ValidationError("This invitation link is invalid.");
  }

  if (invitation.status === "revoked") {
    throw new ValidationError("This invitation has been revoked.");
  }

  if (invitation.status === "accepted") {
    return { organizationId: invitation.organization_id };
  }

  if (new Date(invitation.expires_at) < new Date()) {
    throw new ValidationError("This invitation has expired.");
  }

  // The invitation is bound to a specific address — accepting requires signing in as it.
  if (input.userEmail && input.userEmail.toLowerCase() !== invitation.email.toLowerCase()) {
    throw new ValidationError(
      `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
    );
  }

  // Guarantee the FK target exists without clobbering an existing profile.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: profileError } = await (admin.from("profiles") as any).upsert(
    { email: input.userEmail ?? invitation.email, id: input.userId },
    { onConflict: "id", ignoreDuplicates: true },
  );

  if (profileError) {
    throw profileError;
  }

  const { data: existingMembership, error: membershipLookupError } = await admin
    .from("organization_memberships")
    .select("id")
    .eq("organization_id", invitation.organization_id)
    .eq("profile_id", input.userId)
    .maybeSingle();

  if (membershipLookupError) {
    throw membershipLookupError;
  }

  if (!existingMembership) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: insertError } = await (admin.from("organization_memberships") as any).insert({
      organization_id: invitation.organization_id,
      profile_id: input.userId,
      role: invitation.role,
    });

    if (insertError) {
      throw insertError;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (admin.from("organization_invitations") as any)
    .update({
      accepted_at: new Date().toISOString(),
      accepted_by_profile_id: input.userId,
      status: "accepted",
    })
    .eq("id", invitation.id);

  if (updateError) {
    throw updateError;
  }

  return { organizationId: invitation.organization_id };
}
