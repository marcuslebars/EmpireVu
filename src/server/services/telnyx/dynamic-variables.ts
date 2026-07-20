import { FALLBACK_LOOKUP, lookupCustomerByPhone, type CustomerLookup } from "./customer";
import { extractCalledNumber, extractCallerNumber, normalizePhoneLast10 } from "./payload";
import { createTelnyxAdminClient, resolveTenantByCalledNumber } from "./tenant";

/**
 * Telnyx gives us 1 second before it gives up and uses its own defaults. We cut
 * ourselves off well short of that so a slow lookup degrades the greeting
 * rather than stalling the call.
 */
export const TELNYX_LOOKUP_BUDGET_MS = 800;

export interface DynamicVariablesResponse {
  dynamic_variables: {
    customer_name: string;
    last_service_summary?: string;
    smb__interaction_mode: "returning_customer" | "new_lead";
    system__timezone: string;
  };
}

function businessTimezone(): string {
  return process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

export function buildDynamicVariables(lookup: CustomerLookup): DynamicVariablesResponse {
  return {
    dynamic_variables: {
      customer_name: lookup.customerName,
      smb__interaction_mode: lookup.interactionMode,
      system__timezone: businessTimezone(),
      ...(lookup.lastServiceSummary ? { last_service_summary: lookup.lastServiceSummary } : {}),
    },
  };
}

export function fallbackDynamicVariables(): DynamicVariablesResponse {
  return buildDynamicVariables(FALLBACK_LOOKUP);
}

/**
 * Resolve `work` within `timeoutMs`, otherwise return `fallback`. A rejection
 * also yields the fallback — on this path there is no such thing as an error
 * worth failing the call over.
 */
export async function raceWithFallback<T>(
  work: () => Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([work().catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The real lookup: dialled number → brand, caller number → customer. */
export async function resolveDynamicVariables(payload: unknown): Promise<DynamicVariablesResponse> {
  const admin = createTelnyxAdminClient();
  const tenant = await resolveTenantByCalledNumber(admin, extractCalledNumber(payload));
  const lookup = await lookupCustomerByPhone(admin, {
    companyId: tenant.companyId,
    organizationId: tenant.organizationId,
    phoneLast10: normalizePhoneLast10(extractCallerNumber(payload)),
  });

  return buildDynamicVariables(lookup);
}
