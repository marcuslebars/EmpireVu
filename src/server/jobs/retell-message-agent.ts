/**
 * Create or update the ONE shared Retell message-taking agent used by "AI answers when you
 * can't" (docs/front-desk-ai.md → "## Phone answering" → Setup).
 *
 * Needs RETELL_API_KEY, RETELL_FUNCTION_SECRET and APP_BASE_URL. Re-run any time the prompt
 * changes: with RETELL_MESSAGE_LLM_ID + RETELL_MESSAGE_AGENT_ID set it UPDATES them in place.
 *
 *   npm run job:retell-message-agent              # print the config (dry run, the default)
 *   npm run job:retell-message-agent -- --apply   # create / update it in Retell
 *
 * After the first --apply, set the printed RETELL_MESSAGE_AGENT_ID (and RETELL_MESSAGE_LLM_ID)
 * on the web service.
 */
import { createRetellClient } from "@/server/services/retell/provision";
import { buildMessageAgentConfig, ensureMessageAgent } from "@/server/services/voice/message-agent";

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const baseUrl = process.env.APP_BASE_URL?.trim();
  const secret = process.env.RETELL_FUNCTION_SECRET?.trim();
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!baseUrl || !secret) {
    console.error("[retell-message-agent] APP_BASE_URL and RETELL_FUNCTION_SECRET are required.");
    return 1;
  }
  const input = { baseUrl, functionSecret: secret };
  if (!apply) {
    const config = buildMessageAgentConfig(input);
    const redacted = JSON.stringify({ llm: config.llm, agent: config.agent("<llm_id>") }, null, 2).split(secret).join("<RETELL_FUNCTION_SECRET>");
    console.log(redacted);
    console.log("\n(dry run — pass --apply to create/update it in Retell)");
    return 0;
  }
  if (!apiKey) {
    console.error("[retell-message-agent] RETELL_API_KEY is required for --apply.");
    return 1;
  }
  const result = await ensureMessageAgent(createRetellClient(apiKey), {
    ...input,
    existing: { llmId: process.env.RETELL_MESSAGE_LLM_ID?.trim() || null, agentId: process.env.RETELL_MESSAGE_AGENT_ID?.trim() || null },
  });
  console.log(`RETELL_MESSAGE_LLM_ID=${result.llmId}${result.created.llm ? "   (new)" : ""}`);
  console.log(`RETELL_MESSAGE_AGENT_ID=${result.agentId}${result.created.agent ? "   (new)" : ""}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[retell-message-agent] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
