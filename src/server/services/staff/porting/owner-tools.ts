/**
 * Owner-by-text tools for "keep your number": `start_number_port` (texted "keep my number" → the
 * /port/:token link, in the reply itself) and `number_port_status`. Scoped to the company the
 * owner channel resolved; nothing here reads or returns the account number or PIN.
 */
import type Anthropic from "@anthropic-ai/sdk";

import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { loadLatestPort, portSummary, startPort } from "@/server/services/staff/porting/service";
import { loadPortingCompany } from "@/server/services/staff/porting/settings";
import { focDateText, nextStepText, numbersText } from "@/server/services/staff/porting/status";
import type { RoleOwnerTool } from "@/server/services/staff/types";

const startTool: Anthropic.Messages.Tool = {
  name: "start_number_port",
  description:
    "The owner wants to keep their existing business phone number by moving it over to us (\"keep my number\", \"port my number\", \"move my number over\"). Starts the request (or finds the one in progress) and returns a link to a 5-minute form (carrier, account details, a photo of a recent bill, and an e-signature). Optional: the number to move if it isn't their usual business line.",
  input_schema: {
    type: "object",
    properties: { number: { type: "string", description: "The number to move, only if the owner named one other than their business line." } },
  },
};

const statusTool: Anthropic.Messages.Tool = {
  name: "number_port_status",
  description: "Where the owner's number move (\"keep my number\" port) stands: status, move date, what's needed next, and the form link while it's open.",
  input_schema: { type: "object", properties: {} },
};

async function runStart(state: ToolRunState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const number = typeof input.number === "string" ? input.number : null;
    const result = await startPort(state.admin, state.scope, { createdVia: "owner_text", number, nowMs: state.nowMs });
    const port = result.port;
    const nums = numbersText(port.numbers);
    if (!result.created && !["collecting", "rejected"].includes(port.status)) {
      return {
        ok: true,
        already_in_progress: true,
        tell_owner_exactly: `Your number move for ${nums} is already underway (${portSummary(port, null).statusLabel.toLowerCase()}). ${nextStepText(port.status)}`,
      };
    }
    return {
      ok: true,
      created: result.created,
      tell_owner_exactly: `Here's the form to move ${nums} over (about 5 minutes - have a recent phone bill handy): ${result.url} Your calls keep working the whole time, and nothing changes until the carrier moves it (usually 5-7 business days).`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't start the number move." };
  }
}

async function runStatus(state: ToolRunState): Promise<Record<string, unknown>> {
  try {
    const port = await loadLatestPort(state.admin, state.scope);
    if (!port) return { ok: true, port: null, note: "No number move has been started. The owner can say \"keep my number\" to start one." };
    const company = await loadPortingCompany(state.admin, state.scope);
    const summary = portSummary(port, company?.platformBrand ?? null);
    return {
      ok: true,
      port: {
        numbers: summary.numbersPretty,
        status: summary.statusLabel,
        move_date: port.foc_date ? focDateText(port.foc_date) : null,
        carrier_feedback: summary.rejectionReason,
        next_step: nextStepText(port.status),
        form_link: summary.url,
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't read the number move." };
  }
}

export function portingOwnerTools(): RoleOwnerTool[] {
  return [
    { tool: startTool, run: runStart },
    { tool: statusTool, run: (state) => runStatus(state) },
  ];
}
