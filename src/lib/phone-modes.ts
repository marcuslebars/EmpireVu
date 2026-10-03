/** How the onboarding Phone step can handle calls. */
export type PhoneMode = "ai_receptionist" | "missed_call_catcher";

/**
 * CrankLeads Catch / Close bought the missed-call catcher only (the AI receptionist is
 * Front Desk). Shared by the wizard UI and the server-side gate on
 * /api/organizations/[id]/onboarding/phone. Pure, no imports (used by both bundles).
 */
export function isCatcherOnlyTier(crankleadsTier: string | null | undefined): boolean {
  return crankleadsTier === "catch" || crankleadsTier === "close";
}

/**
 * Which phone modes the Phone step offers. Only a CrankLeads Catch/Close org without
 * marina_reception is limited to the catcher; every other org (self-serve trials, existing
 * operate/launch orgs, Front Desk, house) sees both, exactly as before. The server enforces
 * the same rule — this only shapes the UI.
 */
export function availablePhoneModes(input: {
  crankleadsTier: string | null | undefined;
  aiReceptionistAllowed: boolean;
}): PhoneMode[] {
  return isCatcherOnlyTier(input.crankleadsTier) && !input.aiReceptionistAllowed
    ? ["missed_call_catcher"]
    : ["ai_receptionist", "missed_call_catcher"];
}
