/**
 * The SMS agent's tool-use loop — the first in the codebase.
 *
 *   user turn (fenced conversation + photos) → model → tool calls → tool results → … → text
 *
 * Bounded: at most `maxIterations` model calls per turn, a hard deadline across the whole turn
 * (each call is aborted at the deadline), and tool errors come back to the model as readable
 * results rather than exceptions. The caller (entry.ts) owns what happens to the final text.
 */
import Anthropic from "@anthropic-ai/sdk";

import { extractAiUsage, type AiUsageMeta } from "@/server/ai/claude";
import type { FetchedImage } from "@/server/services/sms-agent/media";
import { AGENT_TOOLS, runTool, type TurnState } from "@/server/services/sms-agent/tools";

/** The one Anthropic call the loop makes — injectable so tests can script a fake model. */
export interface ModelClient {
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal }): Promise<Anthropic.Message>;
}

/** The real client (reads ANTHROPIC_API_KEY), same SDK + zero-arg construction as ai/claude.ts. */
export function defaultModelClient(): ModelClient {
  const client = new Anthropic({ maxRetries: 1 });
  return {
    createMessage: (params, options) => client.messages.create(params, { signal: options.signal }) as Promise<Anthropic.Message>,
  };
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
}

export interface AgentTurnInput {
  state: TurnState;
  system: string;
  userText: string;
  images: FetchedImage[];
  model: string;
  client: ModelClient;
  maxIterations: number;
  /** Absolute epoch ms by which the whole turn must finish. */
  deadline: number;
}

export interface AgentTurnOutput {
  text: string | null;
  stoppedReason: "final" | "max_iterations" | "timeout";
  iterations: number;
  usage: AiUsageMeta[];
  toolCalls: ToolCallRecord[];
}

export class AgentTimeoutError extends Error {
  constructor() {
    super("SMS agent turn timed out.");
    this.name = "AgentTimeoutError";
  }
}

export function toolDefinitions(): Anthropic.Tool[] {
  return AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const tools = toolDefinitions();
  const firstContent: Anthropic.ContentBlockParam[] = [
    ...input.images.map(
      (img): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } }),
    ),
    { type: "text", text: input.userText },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: firstContent }];
  const usage: AiUsageMeta[] = [];
  const toolCalls: ToolCallRecord[] = [];

  for (let iteration = 1; iteration <= input.maxIterations; iteration++) {
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) throw new AgentTimeoutError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Anthropic.Message;
    try {
      response = await input.client.createMessage(
        {
          model: input.model,
          max_tokens: 1_024,
          thinking: { type: "disabled" },
          // The rules + facts are identical across a conversation's turns: cache them.
          system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
        },
        { signal: controller.signal },
      );
    } catch (err) {
      if (controller.signal.aborted) throw new AgentTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    usage.push(extractAiUsage(response, input.model));

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { text: textOf(response) || null, stoppedReason: "final", iterations: iteration, usage, toolCalls };
    }

    messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const { result, isError } = await runTool(input.state, use.name, use.input);
      toolCalls.push({ name: use.name, input: use.input, result, isError });
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: null, stoppedReason: "max_iterations", iterations: input.maxIterations, usage, toolCalls };
}
