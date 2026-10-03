/** How the onboarding Phone step can handle calls. */
export type PhoneMode = "ai_receptionist" | "missed_call_catcher";

/**
 * Which phone modes the org's plan offers. The AI receptionist needs `marina_reception`
 * (Front Desk); an `operate` org (CrankLeads Catch / Close) only gets the missed-call
 * catcher. The server enforces the same rule on the AI provisioning route
 * (/api/organizations/[id]/onboarding/phone) — this only shapes the UI.
 */
export function availablePhoneModes(aiReceptionistAllowed: boolean): PhoneMode[] {
  return aiReceptionistAllowed ? ["ai_receptionist", "missed_call_catcher"] : ["missed_call_catcher"];
}
