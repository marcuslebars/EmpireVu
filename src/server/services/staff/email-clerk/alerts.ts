/**
 * Texting the owner as email arrives (docs/ai-staff.md → "Email inbox"): customer emails without a
 * draft, bid invites, and supplier emails about one of our POs. From the platform number, only
 * 08:00–21:00 local (held until the morning otherwise), and within the owner-alert budget
 * (`ownerAlertGate`: past it, one "lots going on" summary, then dropped — it's all in the app).
 * A forwarding confirmation goes any time: the owner is setting forwarding up right then.
 */
import { isDoneForYou } from "@/lib/product-line";
import { appBaseUrlFor } from "@/server/services/platform-brand";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { isQuietHours, OWNER_ALERTS_SUMMARY, ownerAlertGate, sendOwnerSms } from "@/server/services/owner-channel/common";
import type { Db, InboundEmailRow, OwnerAlertStatus } from "./db-types";
import { alertLine, heldText } from "./format";
import type { EmailClerkCompany } from "./settings";
import { localDateOf } from "./time";

export function inboxLink(company: Pick<EmailClerkCompany, "platformBrand">): string {
  return `${appBaseUrlFor(isDoneForYou(company.platformBrand) ? "crankleads" : "empirevu")}/inbox`;
}

export function fullDraftLink(company: Pick<EmailClerkCompany, "platformBrand">, inboundEmailId: string): string {
  return `${appBaseUrlFor(isDoneForYou(company.platformBrand) ? "crankleads" : "empirevu")}/settings?section=front-desk&email=${inboundEmailId}`;
}

/** Send one owner text now, if the hour and the budget allow. */
export async function textOwner(admin: AdminClient, company: EmailClerkCompany, body: string, nowMs: number, opts: { anyHour?: boolean } = {}): Promise<OwnerAlertStatus> {
  if (!company.ownerPhone) return "dropped";
  if (!opts.anyHour && isQuietHours(nowMs, company.timeZone)) return "held";
  const gate = await ownerAlertGate(admin, company.companyId);
  if (gate !== "send") {
    if (gate === "summary") {
      await sendOwnerSms(admin, { to: company.ownerPhone, body: OWNER_ALERTS_SUMMARY, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
    }
    return "dropped";
  }
  const sent = await sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  if (sent.status === "sent") return "sent";
  return sent.status === "blocked" ? "dropped" : "held";
}

/** The line for one email (customer without a draft, bid invite, supplier on a PO). */
export function lineFor(company: EmailClerkCompany, row: InboundEmailRow, nowMs: number): string {
  return alertLine(row, { today: localDateOf(nowMs, company.timeZone), inboxLink: row.category === "customer" ? inboxLink(company) : null, task: Boolean(row.task_id) });
}

/**
 * Text the owner about one email now (or hold it). Claimed none → sending first, so two workers on
 * the same row never both text; the outcome is recorded on the row. Already alerted → its status.
 */
export async function alertForEmail(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow, nowMs: number): Promise<OwnerAlertStatus> {
  const db = admin as Db;
  const { data: claimed } = await db.from("inbound_emails").update({ owner_alert_status: "sending" }).eq("id", row.id).eq("owner_alert_status", "none").select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return row.owner_alert_status === "none" ? "sending" : row.owner_alert_status;
  const status = await textOwner(admin, company, lineFor(company, row, nowMs), nowMs);
  await db
    .from("inbound_emails")
    .update({ owner_alert_status: status, owner_alerted_at: status === "sent" ? new Date(nowMs).toISOString() : null })
    .eq("id", row.id)
    .eq("owner_alert_status", "sending");
  return status;
}

/**
 * Morning (08:00–21:00): the emails held overnight, in one text. Claimed held → sent before the
 * text (a second worker finds nothing); given back if the text fails.
 */
export async function flushHeldAlerts(admin: AdminClient, company: EmailClerkCompany, nowMs: number): Promise<number> {
  if (!company.ownerPhone || isQuietHours(nowMs, company.timeZone)) return 0;
  const db = admin as Db;
  const { data, error } = await db
    .from("inbound_emails")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("owner_alert_status", "held")
    .order("received_at", { ascending: true })
    .limit(20);
  if (error) throw error;
  const rows = (data ?? []) as InboundEmailRow[];
  if (rows.length === 0) return 0;
  const nowIso = new Date(nowMs).toISOString();
  const claimed: InboundEmailRow[] = [];
  for (const row of rows) {
    const { data: hit } = await db.from("inbound_emails").update({ owner_alert_status: "sent", owner_alerted_at: nowIso }).eq("id", row.id).eq("owner_alert_status", "held").select("id");
    if (((hit ?? []) as unknown[]).length) claimed.push(row);
  }
  if (claimed.length === 0) return 0;
  const body = claimed.length === 1 ? lineFor(company, claimed[0], nowMs) : heldText(claimed.map((r) => lineFor(company, r, nowMs)));
  const status = await textOwner(admin, company, body, nowMs);
  if (status !== "sent") {
    for (const row of claimed) {
      await db.from("inbound_emails").update({ owner_alert_status: status === "held" ? "held" : "dropped", owner_alerted_at: null }).eq("id", row.id).eq("owner_alert_status", "sent");
    }
    return 0;
  }
  return claimed.length;
}
