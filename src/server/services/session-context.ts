import type { PostgrestError } from "@supabase/supabase-js";
import { brandForOrg, type PlatformBrandKey } from "@/lib/platform-brand";
import type { Tables } from "@/server/db/database.types";
import {
  getAuthenticatedUser,
  type OrganizationContext,
} from "@/server/organizations/context";
import { listCompanies } from "@/server/services/companies";
import { isOperatorUser } from "@/server/services/concierge/auth";
import type { createSupabaseServerClient } from "@/server/supabase/server";

type AppSupabaseClient = ReturnType<typeof createSupabaseServerClient>;

export interface SessionOrganizationSummary {
  id: string;
  membershipRole: Tables<"organization_memberships">["role"];
  name: string;
  slug: string;
  /** Brand this org's people see (docs/crankleads-branding.md). */
  platformBrand: PlatformBrandKey;
}

export interface SessionCompanySummary {
  id: string;
  name: string;
  stage: Tables<"companies">["stage"];
}

export interface SessionContextResponse {
  activeOrganizationId: string | null;
  companies: SessionCompanySummary[];
  /** Signed-in user is a concierge operator (OPERATOR_EMAILS) — shows the console nav entry. */
  isOperator: boolean;
  organizations: SessionOrganizationSummary[];
  profile: {
    email: string;
    fullName: string | null;
    id: string;
  } | null;
  user: {
    email: string | undefined;
    id: string;
  };
}

export async function listUserOrganizationContexts(
  supabase: AppSupabaseClient,
): Promise<OrganizationContext[]> {
  const user = await getAuthenticatedUser(supabase);
  const [{ data: memberships, error: membershipsError }, { data: rawProfile, error: profileError }] = await Promise.all([
    supabase
      .from("organization_memberships")
      .select("*")
      .eq("profile_id", user.id)
      .order("joined_at", { ascending: true }),
    supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  if (membershipsError) {
    throw membershipsError;
  }

  if (profileError) {
    throw profileError;
  }

  const profile = (rawProfile ?? null) as Tables<"profiles"> | null;

  const organizationIds = (memberships ?? []).map((membership) => membership.organization_id);
  const { data: organizations, error: organizationsError } = organizationIds.length
    ? await supabase
        .from("organizations")
        .select("*")
        .in("id", organizationIds)
    : { data: [] as Tables<"organizations">[], error: null as PostgrestError | null };

  if (organizationsError) {
    throw organizationsError;
  }

  const organizationsMap = new Map((organizations ?? []).map((organization) => [organization.id, organization]));
  const defaultOrganizationId = profile ? profile.default_organization_id : null;
  const orderedMemberships = [...(memberships ?? [])].sort((left, right) => {
    if (defaultOrganizationId === left.organization_id) {
      return -1;
    }

    if (defaultOrganizationId === right.organization_id) {
      return 1;
    }

    return left.joined_at.localeCompare(right.joined_at);
  });

  return orderedMemberships
    .filter((membership) => organizationsMap.has(membership.organization_id))
    .map((membership) => ({
      membership,
      organizationId: membership.organization_id,
      profile: profile ?? null,
      user,
    }));
}

export async function getSessionContext(
  supabase: AppSupabaseClient,
): Promise<SessionContextResponse> {
  const contexts = await listUserOrganizationContexts(supabase);
  const active = contexts[0] ?? null;
  const organizations = active
    ? await supabase
        .from("organizations")
        .select("*")
        .in("id", contexts.map((context) => context.organizationId))
    : { data: [] as Tables<"organizations">[], error: null as PostgrestError | null };

  if (organizations.error) {
    throw organizations.error;
  }

  const user = active?.user ?? (await getAuthenticatedUser(supabase));
  const organizationMap = new Map((organizations.data ?? []).map((organization) => [organization.id, organization]));
  const companies = active
    ? await listCompanies(
        {
          actorProfileId: active.user.id,
          organizationId: active.organizationId,
          supabase,
        },
        { limit: 100 },
      )
    : [];

  return {
    activeOrganizationId: active?.organizationId ?? null,
    companies: companies.map((company) => ({
      id: company.id,
      name: company.name,
      stage: company.stage,
    })),
    isOperator: isOperatorUser(user),
    organizations: contexts.map((context) => ({
      id: context.organizationId,
      membershipRole: context.membership.role,
      name: organizationMap.get(context.organizationId)?.name ?? context.organizationId,
      slug: organizationMap.get(context.organizationId)?.slug ?? context.organizationId,
      platformBrand: brandForOrg(organizationMap.get(context.organizationId)).key,
    })),
    profile: active?.profile
      ? {
          email: active.profile.email,
          fullName: active.profile.full_name,
          id: active.profile.id,
        }
      : null,
    user: {
      email: user.email,
      id: user.id,
    },
  };
}