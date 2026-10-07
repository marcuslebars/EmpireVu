import type { User } from "@supabase/supabase-js";

import type { Tables } from "@/server/db/database.types";
import { UserFacingError } from "@/server/errors";
import type { createSupabaseServerClient } from "@/server/supabase/server";

type AppSupabaseClient = ReturnType<typeof createSupabaseServerClient>;

/*
 * These are all UserFacingError subclasses: their messages are written for the
 * person using the app and reach them as-is (see handleRoute). Keep ids and
 * internals out of them.
 */
/** Not signed in (→ 401). */
export class AuthenticationError extends UserFacingError {
  constructor(message: string) {
    super(message, { status: 401 });
  }
}
/** Signed in, but not allowed (→ 403). */
export class AuthorizationError extends UserFacingError {
  constructor(message: string) {
    super(message, { status: 403 });
  }
}
/** Bad input the user can fix (→ 400). */
export class ValidationError extends UserFacingError {
  constructor(message: string) {
    super(message, { status: 400 });
  }
}
/** A metered allowance for the month is exhausted (Task 6). Maps to HTTP 402 in handleRoute. */
export class UsageCapExceeded extends UserFacingError {
  constructor(message: string) {
    super(message, { status: 402 });
  }
}
/** A per-tenant rate limit tripped. Maps to HTTP 429 (+ Retry-After) in handleRoute. */
export class TooManyRequestsError extends UserFacingError {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message, { status: 429 });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface OrganizationContext {
  membership: Tables<"organization_memberships">;
  organizationId: string;
  profile: Tables<"profiles"> | null;
  user: User;
}

export async function getAuthenticatedUser(
  supabase: AppSupabaseClient,
): Promise<User> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthenticationError("Authentication is required.");
  }

  return user;
}

export async function requireOrganizationContext(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<OrganizationContext> {
  const user = await getAuthenticatedUser(supabase);

  const { data: membership, error: membershipError } = await supabase
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("profile_id", user.id)
    .maybeSingle();

  if (membershipError) {
    throw membershipError;
  }

  if (!membership) {
    throw new AuthorizationError("You do not have access to this organization.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  return {
    membership,
    organizationId,
    profile,
    user,
  };
}