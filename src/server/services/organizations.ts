import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { ValidationError } from "@/server/organizations/context";
import type { PurchasablePlan } from "@/server/services/billing/config";
import { newOrgTrialFields } from "@/server/services/billing/env";
import type { CrankleadsTier } from "@/server/services/crankleads/config";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { createSupabaseServerClient } from "@/server/supabase/server";

type AppSupabaseClient = ReturnType<typeof createSupabaseServerClient>;
type AdminSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

export const createOrganizationInputSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).optional(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationInputSchema>;

/**
 * Billing fields for an org that is created ALREADY PAID (a CrankLeads purchase provisioned
 * by the billing worker) instead of on the self-serve trial. Server-only: never accept these
 * from a request body.
 */
export interface PaidOrganizationBilling {
  plan: PurchasablePlan;
  subscriptionStatus: "active";
  stripeCustomerId: string;
  billingEmail: string | null;
  crankleadsTier: CrankleadsTier | null;
  /** Make it the owner's default org. False when grafting onto an EXISTING user. */
  setAsDefaultOrganization: boolean;
}

/**
 * Create an organization and make `userId` its owner. Callers pass the SERVICE-ROLE
 * client: clients hold no INSERT privilege on organizations or organization_memberships
 * (migration 20261006170000), because the row carries server-owned billing state.
 * Callers authenticate the user first; `input` is only ever name + slug.
 */
export async function createOrganization(
  supabase: AppSupabaseClient | AdminSupabaseClient,
  userId: string,
  profileId: string,
  input: CreateOrganizationInput,
  paid?: PaidOrganizationBilling,
): Promise<Tables<"organizations">> {
  const organizationSlug = input.slug ? slugify(input.slug) : slugify(input.name);

  const { data: existingOrg, error: existingError } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", organizationSlug)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existingOrg) {
    throw new ValidationError("An organization with this slug already exists.");
  }

  // A brand-new self-serve org starts on a time-boxed trial — NOT the `internal`
  // house default (billing-exempt), which would hand every signup the whole
  // product free. Gating enforces the trial's expiry from trial_ends_at.
  // A paid org (CrankLeads purchase) skips the trial: it starts active on the bought plan,
  // already linked to its Stripe customer.
  const trial = newOrgTrialFields(new Date());
  const billing: Inserts<"organizations"> = paid
    ? {
        created_by: userId,
        name: input.name,
        slug: organizationSlug,
        plan: paid.plan,
        subscription_status: paid.subscriptionStatus,
        trial_ends_at: null,
        stripe_customer_id: paid.stripeCustomerId,
        billing_email: paid.billingEmail,
        crankleads_tier: paid.crankleadsTier,
      }
    : {
        created_by: userId,
        name: input.name,
        slug: organizationSlug,
        plan: trial.plan,
        subscription_status: trial.subscription_status,
        trial_ends_at: trial.trial_ends_at,
      };
  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .insert(billing)
    .select("*")
    .single();

  if (organizationError) {
    // The pre-check above can't see orgs the caller isn't a member of (RLS), so a
    // slug that collides with someone else's org reaches the DB unique constraint.
    // Map that to a friendly 400 instead of a raw 500.
    if (organizationError.code === "23505") {
      throw new ValidationError("An organization with this slug already exists.");
    }
    throw organizationError;
  }

  if (!organization) {
    throw new Error("Organization creation failed.");
  }

  const { error: membershipError } = await supabase
    .from("organization_memberships")
    .insert({
      organization_id: organization.id,
      profile_id: profileId,
      role: "owner",
    });

  if (membershipError) {
    throw membershipError;
  }

  const orgId = organization.id;

  if (!paid || paid.setAsDefaultOrganization) {
    const { error: profileError } = await supabase
      .from("profiles")
      .update({ default_organization_id: orgId })
      .eq("id", profileId);

    if (profileError) {
      console.error("Failed to set default organization:", profileError);
    }
  }

  return organization as Tables<"organizations">;
}

export const updateOrganizationInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: z.string().min(1).max(80).optional(),
  })
  .refine((value) => value.name !== undefined || value.slug !== undefined, {
    message: "Provide at least one field to update.",
  });

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationInputSchema>;

export async function updateOrganization(
  supabase: AppSupabaseClient,
  organizationId: string,
  input: UpdateOrganizationInput,
): Promise<Tables<"organizations">> {
  const updates: { name?: string; slug?: string } = {};

  if (input.name !== undefined) {
    updates.name = input.name;
  }

  if (input.slug !== undefined) {
    updates.slug = slugify(input.slug);
  }

  if (updates.slug) {
    const { data: existing, error: existingError } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", updates.slug)
      .neq("id", organizationId)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      throw new ValidationError("An organization with this slug already exists.");
    }
  }

  const { data, error } = await supabase
    .from("organizations")
    .update(updates)
    .eq("id", organizationId)
    .select("*")
    .single();

  if (error) {
    // Map the DB unique-constraint collision (against orgs the caller can't see
    // under RLS) to a friendly 400 instead of a raw 500.
    if (error.code === "23505") {
      throw new ValidationError("An organization with this slug already exists.");
    }
    throw error;
  }

  if (!data) {
    throw new Error("Organization update failed.");
  }

  return data as Tables<"organizations">;
}

export async function listUserOrganizations(
  supabase: AppSupabaseClient,
  userId: string,
): Promise<Tables<"organizations">[]> {
  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("organization_id")
    .eq("profile_id", userId);

  if (membershipsError) {
    throw membershipsError;
  }

  if (!memberships || memberships.length === 0) {
    return [];
  }

  const organizationIds = (memberships as Array<{ organization_id: string }>).map((m) => m.organization_id);

  const { data: organizations, error: organizationsError } = await supabase
    .from("organizations")
    .select("*")
    .in("id", organizationIds)
    .order("created_at", { ascending: true });

  if (organizationsError) {
    throw organizationsError;
  }

  return (organizations ?? []) as Tables<"organizations">[];
}
