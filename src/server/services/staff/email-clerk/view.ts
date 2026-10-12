/**
 * Settings → AI front desk → Email inbox (docs/ai-staff.md → "Email inbox"): the switches for
 * everyone; for owners/admins the inbox address (made on first view when the feature is on), the
 * forwarding status, and the recent emails by kind with any draft waiting on their Y. Writes go
 * through updateAiSettings (only ai_settings.email_clerk).
 */
import { isAIConfigured } from "@/server/ai/claude";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, EmailCategory, InboundEmailRow, ReplyStatus } from "./db-types";
import { askOf, EMAIL_REPLY_KIND, senderLabel } from "./format";
import { ensureInbox, loadInbox } from "./inboxes";
import { clean } from "./parse";
import { emailClerkOn, inboundConfigured, loadEmailClerkCompany, mergeEmailClerkSettings, type EmailClerkSettings, type EmailClerkSettingsPatch } from "./settings";

type Scope = { organizationId: string; companyId: string };

export interface RecentEmailView {
  id: string;
  receivedAt: string;
  from: string;
  fromAddress: string | null;
  subject: string;
  category: EmailCategory | null;
  summary: string;
  replyStatus: ReplyStatus;
  /** The full draft while it waits on the owner (owners/admins only). */
  draft: string | null;
  approvalCode: number | null;
  attachments: number;
}

export interface EmailClerkView {
  companyId: string;
  companyName: string;
  configured: boolean;
  settings: EmailClerkSettings;
  ownerPhoneOnFile: boolean;
  aiAvailable: boolean;
  /** Owners/admins only (null for members, or before the inbox exists). */
  inbox: { address: string; forwardingConfirmedAt: string | null; forwardingRequestedAt: string | null; lastReceivedAt: string | null } | null;
  /** Last 7 days by kind (owners/admins only). */
  counts: Record<string, number> | null;
  recent: RecentEmailView[] | null;
}

export async function getEmailClerkView(admin: AdminClient, scope: Scope, opts: { manager: boolean; nowMs?: number }): Promise<EmailClerkView | null> {
  const company = await loadEmailClerkCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return null;
  const configured = inboundConfigured();
  const base: EmailClerkView = {
    companyId: company.companyId,
    companyName: company.name,
    configured,
    settings: company.settings,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    aiAvailable: isAIConfigured(),
    inbox: null,
    counts: null,
    recent: null,
  };
  if (!opts.manager || !configured) return base;
  const nowMs = opts.nowMs ?? Date.now();
  const inbox = emailClerkOn(company) ? await ensureInbox(admin, company, nowMs) : await loadInbox(admin, company);
  if (!inbox) return base;
  const db = admin as Db;
  const { data, error } = await db
    .from("inbound_emails")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .gte("received_at", new Date(nowMs - 7 * 86_400_000).toISOString())
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as InboundEmailRow[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category ?? "unsorted"] = (counts[r.category ?? "unsorted"] ?? 0) + 1;
  const recent = rows.slice(0, 30);
  const approvalIds = recent.map((r) => r.approval_id).filter((id): id is string => Boolean(id));
  const codes = new Map<string, number | null>();
  if (approvalIds.length) {
    const { data: approvals } = await db.from("owner_approvals").select("id, short_code, status").eq("organization_id", scope.organizationId).eq("kind", EMAIL_REPLY_KIND).in("id", approvalIds);
    for (const a of (approvals ?? []) as Array<{ id: string; short_code: number | null; status: string }>) if (a.status === "pending") codes.set(a.id, a.short_code);
  }
  const files = new Map<string, number>();
  if (recent.length) {
    const { data: atts } = await db.from("email_attachments").select("inbound_email_id").eq("company_id", scope.companyId).eq("status", "stored").in("inbound_email_id", recent.map((r) => r.id));
    for (const a of (atts ?? []) as Array<{ inbound_email_id: string }>) files.set(a.inbound_email_id, (files.get(a.inbound_email_id) ?? 0) + 1);
  }
  return {
    ...base,
    inbox: { address: inbox.address, forwardingConfirmedAt: inbox.forwarding_confirmed_at, forwardingRequestedAt: inbox.forwarding_requested_at, lastReceivedAt: inbox.last_received_at },
    counts,
    recent: recent.map((r) => ({
      id: r.id,
      receivedAt: r.received_at,
      from: senderLabel(r),
      fromAddress: r.from_address,
      subject: clean(r.subject, 160),
      category: r.category,
      summary: askOf(r, 160),
      replyStatus: r.reply_status,
      draft: r.reply_status === "awaiting_owner" ? r.draft_reply : null,
      approvalCode: r.approval_id && codes.has(r.approval_id) ? codes.get(r.approval_id) ?? null : null,
      attachments: files.get(r.id) ?? 0,
    })),
  };
}

/** Owner/admin: merge ONLY ai_settings.email_clerk. */
export async function updateEmailClerkSettings(admin: AdminClient, scope: Scope, patch: EmailClerkSettingsPatch): Promise<EmailClerkView | null> {
  const written = await updateAiSettings(admin, scope, (current) => mergeEmailClerkSettings(current, patch));
  if (!written) return null;
  return getEmailClerkView(admin, scope, { manager: true });
}
