/**
 * Everdoer rebrand: bulk re-point of the Retell agents we provisioned + the shared message agent
 * (src/server/services/rebrand/retell-repoint.ts has the rules). Dry run unless --apply.
 *
 *   npm run job:retell-repoint                         # list each agent and what is stale (GET only)
 *   npm run job:retell-repoint -- --company <id>       # one company (skips the shared agent)
 *   npm run job:retell-repoint -- --apply              # resync the stale ones
 *   npm run job:retell-repoint -- --apply --all        # resync every one
 *
 * A resync rebuilds URLs from APP_BASE_URL and the tool header name from EVERDOER_WRITE_NEW_NAMES,
 * so set those first. Needs RETELL_API_KEY (+ RETELL_FUNCTION_SECRET and APP_BASE_URL for --apply)
 * and the Supabase service-role env. Hand-made agents (A1 Marine Care) are never listed.
 */
import { flushLegacyUsage } from "@/server/services/rebrand/legacy-usage";
import { expectedFromEnv, formatRetellRepoint, parseRetellRepointArgs, runRetellRepoint } from "@/server/services/rebrand/retell-repoint";
import { createRetellReader } from "@/server/services/retell/health";
import { createRetellClient } from "@/server/services/retell/provision";
import { ensureMessageAgent } from "@/server/services/voice/message-agent";
import { resyncReceptionistForContext } from "@/server/services/voice/resync";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

async function main(): Promise<number> {
  const args = parseRetellRepointArgs(process.argv.slice(2));
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!apiKey) {
    console.error("[retell-repoint] RETELL_API_KEY is required.");
    return 1;
  }
  const baseUrl = process.env.APP_BASE_URL?.trim();
  const secret = process.env.RETELL_FUNCTION_SECRET?.trim();
  if (args.apply && (!baseUrl || !secret)) {
    console.error("[retell-repoint] APP_BASE_URL and RETELL_FUNCTION_SECRET are required for --apply.");
    return 1;
  }
  const retell = createRetellClient(apiKey);
  const rows = await runRetellRepoint(
    {
      db: createSupabaseAdminClient(),
      reader: createRetellReader(apiKey),
      resync: (ctx, companyId) => resyncReceptionistForContext(ctx, companyId, retell),
      ensureMessage:
        baseUrl && secret
          ? () =>
              ensureMessageAgent(retell, {
                baseUrl,
                functionSecret: secret,
                existing: { llmId: process.env.RETELL_MESSAGE_LLM_ID?.trim() || null, agentId: process.env.RETELL_MESSAGE_AGENT_ID?.trim() || null },
              })
          : null,
    },
    args,
  );
  console.log(formatRetellRepoint(rows, expectedFromEnv()));
  if (!args.apply) {
    console.log(`\n(dry run — ${rows.filter((r) => r.action === "would_resync").length} agent(s) to resync; pass --apply)`);
    return 0;
  }
  return rows.some((r) => r.action === "failed") ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("[retell-repoint] FAILED:", err instanceof Error ? err.message : err);
    return 1;
  })
  .then(async (code) => {
    await flushLegacyUsage();
    process.exit(code);
  });
