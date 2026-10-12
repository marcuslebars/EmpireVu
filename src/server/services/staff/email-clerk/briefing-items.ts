/**
 * Lines for the Office manager's 07:00 briefing (docs/ai-staff.md → "Email inbox"):
 *   "2 customer emails waiting on you"            (pending email_reply approvals)
 *   "Bid invite: Smith Build - roof, due Fri"     (bid invites due in the next 7 days, ≤ 2)
 * [] when the Email inbox is off for the company (house orgs), when nothing is waiting, or when a
 * read fails. Read-only; never throws.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { addDays } from "@/server/services/booking-windows";
import type { Db, InboundEmailRow } from "./db-types";
import { dayLabel, EMAIL_REPLY_KIND } from "./format";
import { clean } from "./parse";
import { emailClerkOn, inboundConfigured, loadEmailClerkCompany } from "./settings";

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string }, localDateKey: string): Promise<string[]> {
  try {
    if (!inboundConfigured()) return [];
    const company = await loadEmailClerkCompany(admin, scope.organizationId, scope.companyId);
    if (!emailClerkOn(company)) return [];
    const db = admin as Db;
    const items: string[] = [];
    const { data: approvals, error } = await db
      .from("owner_approvals")
      .select("id")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .eq("kind", EMAIL_REPLY_KIND)
      .eq("status", "pending")
      .limit(100);
    if (error) throw error;
    const waiting = ((approvals ?? []) as unknown[]).length;
    if (waiting > 0) items.push(`${waiting} customer ${waiting === 1 ? "email" : "emails"} waiting on you`);

    const { data: bids, error: bErr } = await db
      .from("inbound_emails")
      .select("id, from_name, from_address, subject, ai_summary, text_body, detail, received_at")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .eq("category", "bid_invite")
      .gte("received_at", new Date(Date.parse(`${localDateKey}T12:00:00Z`) - 30 * 86_400_000).toISOString())
      .limit(100);
    if (bErr) throw bErr;
    const until = addDays(localDateKey, 7);
    const due = ((bids ?? []) as InboundEmailRow[])
      .filter((b) => b.detail?.due_on && b.detail.due_on >= localDateKey && b.detail.due_on <= until)
      .sort((a, b) => String(a.detail?.due_on).localeCompare(String(b.detail?.due_on)));
    for (const b of due.slice(0, 2)) {
      const gc = clean(b.detail?.from_business, 30) || clean(b.from_name, 30) || clean(b.from_address, 40);
      const what = clean(b.detail?.project, 40) || clean(b.ai_summary, 40) || clean(b.subject, 40);
      items.push(`Bid invite: ${gc}${what ? ` - ${what}` : ""}, due ${dayLabel(b.detail?.due_on as string, localDateKey)}`);
    }
    return items;
  } catch (err) {
    console.error("[email-clerk] briefing items failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
