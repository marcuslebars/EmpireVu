// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): concierge console — number porting (docs/ai-staff.md →
// "Keep your number"). Registered into the concierge registry, so each runs only through
// runConciergeAction (requireOperator, strict zod input, ONE org + its own company, an
// operator_actions audit row written first). The port must belong to that company.
//
// port_reveal_secrets returns the decrypted account number + PIN to the operator's screen only:
// the audit row records THAT they were revealed (and by whom), never the values; the message
// carries no secret either. Loaded by services/concierge/register-all.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";

import { registerConciergeAction } from "@/server/services/concierge/actions";
import { cancelPort, markRejected, markSubmitted, revealSecrets, setFocDate, startPort } from "@/server/services/staff/porting/service";
import { STATUS_LABELS } from "@/server/services/staff/porting/status";

/** Run from the Ports page (they need a port id), so the account page doesn't show them as buttons. */
export const PORT_PANEL_ACTIONS = ["port_reveal_secrets", "port_mark_submitted", "port_set_foc", "port_mark_rejected", "port_cancel"] as const;

const portId = z.string().uuid();

registerConciergeAction({
  name: "port_start",
  label: "Keep their number: text the owner the porting form",
  schema: z.object({ number: z.string().max(40).optional() }).strict(),
  async run(ctx, input) {
    const result = await startPort(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId }, { createdVia: "operator", number: input.number ?? null, nowMs: ctx.nowMs });
    return {
      message: result.created
        ? `Port started${result.texted ? " - the owner was texted the form" : " (couldn't text the owner - send them the link)"}.`
        : `They already have one (${STATUS_LABELS[result.port.status]}).`,
      result: { portId: result.port.id, url: result.url, status: result.port.status },
      audit: { portId: result.port.id, created: result.created, texted: result.texted },
    };
  },
});

registerConciergeAction({
  name: "port_reveal_secrets",
  label: "Reveal account number + PIN",
  schema: z.object({ portId }).strict(),
  async run(ctx, input) {
    const secrets = await revealSecrets(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId }, input.portId);
    return {
      message: "Revealed (logged). Paste them only into the Twilio port form.",
      result: secrets,
      audit: { portId: input.portId, revealed: { accountNumber: secrets.accountNumber !== null, pin: secrets.pin !== null }, pinStatus: secrets.pinStatus },
    };
  },
});

registerConciergeAction({
  name: "port_mark_submitted",
  label: "Mark submitted",
  schema: z.object({ portId, twilioRequestId: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/, "Paste the Twilio port request id (letters and numbers).") }).strict(),
  async run(ctx, input) {
    const port = await markSubmitted(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId }, input.portId, { twilioRequestId: input.twilioRequestId, nowMs: ctx.nowMs });
    return { message: "Marked submitted - the owner gets the 90-minute carrier approval warning by text now.", result: { status: port.status }, audit: { portId: port.id, twilioRequestId: input.twilioRequestId } };
  },
});

registerConciergeAction({
  name: "port_set_foc",
  label: "Set FOC date",
  schema: z.object({ portId, focDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD") }).strict(),
  async run(ctx, input) {
    const port = await setFocDate(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId }, input.portId, { focDate: input.focDate, nowMs: ctx.nowMs });
    return { message: `Move date set to ${input.focDate} - the owner gets a text.`, result: { status: port.status }, audit: { portId: port.id, focDate: input.focDate } };
  },
});

registerConciergeAction({
  name: "port_mark_rejected",
  label: "Mark rejected",
  schema: z.object({ portId, reason: z.string().trim().min(3).max(300) }).strict(),
  async run(ctx, input) {
    const port = await markRejected(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId }, input.portId, { reason: input.reason, nowMs: ctx.nowMs });
    return { message: "Marked rejected - the owner gets a text with what to fix and the form link.", result: { status: port.status }, audit: { portId: port.id } };
  },
});

registerConciergeAction({
  name: "port_cancel",
  label: "Cancel port",
  schema: z.object({ portId }).strict(),
  async run(ctx, input) {
    const port = await cancelPort(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId }, input.portId, { by: "operator", nowMs: ctx.nowMs });
    return { message: "Cancelled - the owner gets a text. Cancel it in Twilio too if it was submitted.", result: { status: port.status }, audit: { portId: port.id } };
  },
});
