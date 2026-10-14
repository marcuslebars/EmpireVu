/**
 * Everdoer rebrand: which names we WRITE to the outside world.
 *
 * PR 1 makes every reader accept both old (EmpireVu / CrankLeads) and new (Everdoer) names, but
 * keeps writing the old ones, so rolling the deploy back can never strand anything:
 *   - Retell tool headers           x-empirevu-retell-secret  → x-everdoer-retell-secret
 *   - Twilio FriendlyName tags      "EmpireVu catcher <id>"   → "Everdoer catcher <id>"
 *   - Twilio forwarding-test key    EmpireVuForwardingTestId  → EverdoerForwardingTestId
 *   - Stripe metadata source        "crankleads"              → "everdoer"
 *
 * Set EVERDOER_WRITE_NEW_NAMES=1 on every service (web + workers) once PR 1 has been live and
 * stable (REBRAND_CHECKLIST.md). Unsetting it is the instant rollback, with no deploy needed.
 * The "remove shims" PR (PR 8) hard-codes the new names and removes this switch.
 */
export function writeNewNames(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.EVERDOER_WRITE_NEW_NAMES?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
