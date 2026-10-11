// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): concierge console — customer import actions
// (docs/ai-staff.md → "Customer import"). Registered into the concierge registry, so each one
// runs only after requireOperator, for an org/company the registry resolved, with the
// operator_actions audit row written BEFORE it runs.
// ─────────────────────────────────────────────────────────────────────────────
import { ValidationError } from "@/server/organizations/context";
import { emptySchema, registerConciergeAction } from "@/server/services/concierge/actions";
import { defaultImporterDeps } from "@/server/services/staff/importer/deps";
import { sendImportLink } from "@/server/services/staff/importer/links";

registerConciergeAction({
  name: "send_import_link",
  label: "Send import link",
  schema: emptySchema,
  async run(ctx) {
    const out = await sendImportLink(ctx.admin, { organizationId: ctx.organizationId, companyId: ctx.companyId }, { ...defaultImporterDeps, now: () => ctx.nowMs });
    if (out.status === "off") throw new ValidationError("Customer import is off for this company (Settings > AI front desk > Customer import).");
    if (out.status === "no_phone") throw new ValidationError("No confirmed owner cell on file - the link wasn't texted.");
    if (out.status !== "sent") throw new ValidationError(`The text didn't go through (${out.status}).`);
    return { message: "Import link texted to the owner.", audit: { sent: true } };
  },
});
