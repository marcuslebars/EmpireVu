/** How the onboarding Phone step can handle calls. */
export type PhoneMode = "ai_receptionist" | "missed_call_catcher";

/**
 * Done-for-you Catch / Close bought the missed-call catcher only (the AI receptionist is
 * Front Desk). Shared by the wizard UI and the server-side gate on
 * /api/organizations/[id]/onboarding/phone. Pure, no imports (used by both bundles).
 */
export function isCatcherOnlyTier(planTier: string | null | undefined): boolean {
  return planTier === "catch" || planTier === "close";
}

/**
 * Which phone modes the Phone step offers. Only a done-for-you Catch/Close org without
 * marina_reception is limited to the catcher; every other org (self-serve trials, existing
 * operate/launch orgs, Front Desk, house) sees both, exactly as before. The server enforces
 * the same rule — this only shapes the UI.
 */
export function availablePhoneModes(input: {
  planTier: string | null | undefined;
  aiReceptionistAllowed: boolean;
}): PhoneMode[] {
  return isCatcherOnlyTier(input.planTier) && !input.aiReceptionistAllowed
    ? ["missed_call_catcher"]
    : ["ai_receptionist", "missed_call_catcher"];
}
