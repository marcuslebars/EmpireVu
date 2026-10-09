/**
 * One-off repair: CrankLeads companies provisioned before the "only the tier's automations"
 * rule got the whole recipe catalog at default status (a Catch buyer could have stale-lead
 * nudges or quote follow-ups texting their leads). This lists — and with --apply sets to draft
 * — every ACTIVE catalog recipe outside the company's tier (packRecipesForTier ∪ the tier's
 * switch-on set). Custom workflows are never touched; nothing is ever turned ON.
 *
 * SANCTIONED EXCEPTION (service role) — jobs. Needs NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY. Dry-run by default; idempotent (re-running finds nothing).
 *
 *   npm run job:crankleads-repair-automations              # dry run: prints what would change
 *   npm run job:crankleads-repair-automations -- --apply   # makes the change
 */
import { repairTierAutomations } from "@/server/services/crankleads/tier-automations";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

async function main(): Promise<number> {
  const apply = process.argv.slice(2).includes("--apply");
  const items = await repairTierAutomations(createSupabaseAdminClient(), { apply });
  for (const item of items) {
    console.log(
      `[repair-tier-automations] ${apply ? "set to draft" : "would set to draft"} org=${item.organizationId} company=${item.companyId} tier=${item.tier}: ${item.deactivated.join(", ")}`,
    );
  }
  const total = items.reduce((n, i) => n + i.deactivated.length, 0);
  console.log(`[repair-tier-automations] ${apply ? "APPLIED" : "DRY RUN"} — ${total} automation(s) on ${items.length} compan${items.length === 1 ? "y" : "ies"}${apply ? "" : " (re-run with --apply to change them)"}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[repair-tier-automations] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
