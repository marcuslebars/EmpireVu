/**
 * The daily owner money alert: at most one text a day, at 08:00 local (caught up until 11:00 if
 * a worker was down), and only when something is notable:
 *
 *   • an invoice crossed 30 or 60 days overdue
 *   • a card / bank payment failed
 *   • a promise to pay or a payment-plan instalment was missed
 *   • the accounting sync is failing for an invoice or payment (accounting_sync_jobs failed, or
 *     still pending after 3+ attempts)
 *   • reconciliation: an invoice marked paid with no succeeded payment (and no credit covering
 *     it), or a payment with no accounting sync after 24h while a connection is active
 *
 * Each item is reported once (money_alert_items, unique per company + key). The day is claimed
 * first (money_alerts, unique per company + local date), so overlapping workers send one text.
 * From the platform number to the verified owner cell.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { loadOpenInvoicesWithNames } from "./ar";
import { isOpen, loadCompanyCtx, owingCents, todayIn, type CompanyCtx } from "./context";
import type { BookkeeperInvoice, Db, InvoiceCollectionsRow, PaymentPlanRow } from "./db-types";
import { INVOICE_COLUMNS } from "./db-types";
import { addDays, daysBetween, localParts, ownerMoney, shortDate } from "./format";

export const ALERT_HOUR = 8;
/** If the 08:00 pass was missed (worker down), catch up until this hour. */
export const ALERT_LAST_HOUR = 11;
/** An instalment is "missed" this many days after its due date. */
export const PLAN_GRACE_DAYS = 2;
const MAX_ALERT = 600;

export type AlertKind = "payment_failed" | "promise_missed" | "plan_missed" | "overdue60" | "overdue30" | "sync_failed" | "unsynced_payment" | "paid_no_payment";

export interface AlertEntry {
  key: string;
  kind: AlertKind;
  /** Also mark these as told (an invoice that's already 60+ late never later gets a 30+ alert). */
  alsoKeys?: string[];
  /** The fragment for this entry, e.g. "Jamie Lee $1,240 (INV-12)". */
  text: string;
}

const KIND_ORDER: AlertKind[] = ["payment_failed", "promise_missed", "plan_missed", "overdue60", "overdue30", "sync_failed", "unsynced_payment", "paid_no_payment"];

function providerName(provider: string | null): string {
  return provider === "xero" ? "Xero" : provider === "quickbooks" ? "QuickBooks" : "your accounting";
}

function fragments(list: AlertEntry[], max = 3): string {
  const shown = list.slice(0, max).map((e) => e.text);
  return list.length > max ? `${shown.join(", ")} +${list.length - max} more` : shown.join(", ");
}

/** The alert text from the new entries. Null when there's nothing. PURE. */
export function composeMoneyAlert(companyName: string, entries: AlertEntry[], provider: string | null = null): string | null {
  if (entries.length === 0) return null;
  const by = new Map<AlertKind, AlertEntry[]>();
  for (const e of entries) by.set(e.kind, [...(by.get(e.kind) ?? []), e]);
  const lines: string[] = [];
  for (const kind of KIND_ORDER) {
    const list = by.get(kind);
    if (!list?.length) continue;
    switch (kind) {
      case "payment_failed":
        lines.push(`Payment failed: ${fragments(list)}.`);
        break;
      case "promise_missed":
        lines.push(`Missed promise to pay: ${fragments(list)}.`);
        break;
      case "plan_missed":
        lines.push(`Missed plan payment: ${fragments(list)}.`);
        break;
      case "overdue60":
        lines.push(`Now 60+ days overdue: ${fragments(list)}.`);
        break;
      case "overdue30":
        lines.push(`Now 30+ days overdue: ${fragments(list)}.`);
        break;
      case "sync_failed":
        lines.push(`Not syncing to ${providerName(provider)}: ${fragments(list)}. Check Settings > Accounting.`);
        break;
      case "unsynced_payment":
        lines.push(`${list.length === 1 ? "1 payment is" : `${list.length} payments are`} not in ${providerName(provider)} after a day.`);
        break;
      case "paid_no_payment":
        lines.push(`Marked paid with no payment recorded: ${fragments(list)}.`);
        break;
    }
  }
  const head = `Money check for ${companyName}:`;
  const foot = `Text "who owes me" for the full list.`;
  let body = [head, ...lines, foot].join("\n");
  while (body.length > MAX_ALERT && lines.length > 1) {
    lines.pop();
    body = [head, ...lines, "More in the app.", foot].join("\n");
  }
  return body.length > MAX_ALERT ? `${body.slice(0, MAX_ALERT - 3)}...` : body;
}

function invLabel(inv: Pick<BookkeeperInvoice, "invoice_number"> | null | undefined): string {
  return inv?.invoice_number ?? "an invoice";
}

/** Everything notable right now for one company (before de-duplication). */
export async function collectAlertEntries(admin: AdminClient, ctx: CompanyCtx, nowMs: number): Promise<{ entries: AlertEntry[]; provider: string | null }> {
  const db = admin as Db;
  const scope = { organizationId: ctx.organizationId, companyId: ctx.companyId };
  const today = todayIn(ctx, nowMs);
  const entries: AlertEntry[] = [];

  // Overdue crossings.
  const open = await loadOpenInvoicesWithNames(admin, scope);
  const names = new Map(open.map((i) => [i.id, i.customer]));
  for (const inv of open) {
    if (!inv.due_date) continue;
    const late = daysBetween(inv.due_date, today);
    const text = `${inv.customer} ${ownerMoney(owingCents(inv))} (${invLabel(inv)})`;
    if (late >= 60) entries.push({ key: `overdue60:${inv.id}`, kind: "overdue60", alsoKeys: [`overdue30:${inv.id}`], text });
    else if (late >= 30) entries.push({ key: `overdue30:${inv.id}`, kind: "overdue30", text });
  }

  // Failed payments (not ones staff removed as a mistake).
  const { data: failed } = await db
    .from("invoice_payments")
    .select("id, invoice_id, amount_cents, method, failure_reason, updated_at, status")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("status", "failed")
    .gte("updated_at", new Date(nowMs - 2 * 86_400_000).toISOString())
    .limit(50);
  const failedRows = ((failed ?? []) as Array<{ id: string; invoice_id: string; amount_cents: number; failure_reason: string | null }>).filter((p) => !/^removed/i.test(p.failure_reason ?? ""));
  const extraIds = [...new Set(failedRows.map((p) => p.invoice_id).filter((id) => !names.has(id)))];
  const invoicesById = new Map<string, BookkeeperInvoice & { customer?: string }>(open.map((i) => [i.id, i]));
  if (extraIds.length) {
    const { data } = await db.from("invoices").select(INVOICE_COLUMNS).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("id", extraIds);
    for (const inv of (data ?? []) as BookkeeperInvoice[]) invoicesById.set(inv.id, inv);
  }
  for (const p of failedRows) {
    const inv = invoicesById.get(p.invoice_id);
    entries.push({ key: `payment_failed:${p.id}`, kind: "payment_failed", text: `${names.get(p.invoice_id) ?? "a customer"} ${ownerMoney(p.amount_cents)} (${invLabel(inv)})` });
  }

  // Promises to pay: kept (paid) or missed (date passed, still owing).
  const { data: promises } = await db.from("invoice_collections").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("promise_status", "open").limit(200);
  for (const row of (promises ?? []) as InvoiceCollectionsRow[]) {
    const inv = invoicesById.get(row.invoice_id) ?? ((await db.from("invoices").select(INVOICE_COLUMNS).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", row.invoice_id).maybeSingle()).data as BookkeeperInvoice | null);
    if (!inv || !isOpen(inv)) {
      await db.from("invoice_collections").update({ promise_status: "kept" }).eq("id", row.id).eq("organization_id", scope.organizationId).eq("promise_status", "open");
      continue;
    }
    if (!row.promise_date || row.promise_date >= today) continue;
    await db.from("invoice_collections").update({ promise_status: "missed" }).eq("id", row.id).eq("organization_id", scope.organizationId).eq("promise_status", "open");
    entries.push({ key: `promise_missed:${row.invoice_id}:${row.promise_date}`, kind: "promise_missed", text: `${names.get(inv.id) ?? "a customer"}, ${ownerMoney(owingCents(inv))} by ${shortDate(row.promise_date)}` });
  }

  // Payment-plan instalments that are past due (with a little grace) and not covered.
  const { data: plans } = await db.from("payment_plans").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("status", "active").limit(200);
  for (const plan of (plans ?? []) as PaymentPlanRow[]) {
    const inv = invoicesById.get(plan.invoice_id);
    if (!inv) continue;
    const missed = missedInstalment(plan, owingCents(inv), today);
    if (missed) {
      entries.push({
        key: `plan_missed:${plan.id}:${missed.n}`,
        kind: "plan_missed",
        text: `${names.get(inv.id) ?? "a customer"}, payment ${missed.n} of ${plan.instalments.length} (${ownerMoney(missed.amountCents)}, due ${shortDate(missed.dueDate)})`,
      });
    }
  }

  // Accounting: failing syncs and reconciliation.
  const { data: connRows } = await db.from("accounting_connections").select("provider, status, connected_at, sync_start_date").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).limit(1);
  const conn = ((connRows ?? []) as Array<{ provider: string; status: string; connected_at: string | null; sync_start_date: string | null }>)[0] ?? null;
  const { data: jobs } = await db
    .from("accounting_sync_jobs")
    .select("id, entity_type, entity_id, status, attempts")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("status", ["failed", "pending"])
    .limit(200);
  for (const job of (jobs ?? []) as Array<{ id: string; entity_type: string; entity_id: string; status: string; attempts: number }>) {
    if (job.entity_type !== "invoice" && job.entity_type !== "payment") continue;
    if (job.status === "pending" && (job.attempts ?? 0) < 3) continue;
    const inv = job.entity_type === "invoice" ? invoicesById.get(job.entity_id) : null;
    entries.push({ key: `sync_failed:${job.id}`, kind: "sync_failed", text: job.entity_type === "invoice" ? invLabel(inv) : "a payment" });
  }

  const since90 = new Date(nowMs - 90 * 86_400_000).toISOString();
  const { data: paid } = await db
    .from("invoices")
    .select("id, invoice_number, total_cents, credit_cents, paid_at")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("status", "paid")
    .gte("paid_at", since90)
    .limit(500);
  const paidRows = (paid ?? []) as Array<{ id: string; invoice_number: string | null; total_cents: number; credit_cents: number }>;
  if (paidRows.length) {
    const { data: pays } = await db.from("invoice_payments").select("invoice_id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("status", "succeeded").in("invoice_id", paidRows.map((r) => r.id));
    const withPayment = new Set(((pays ?? []) as Array<{ invoice_id: string }>).map((p) => p.invoice_id));
    for (const r of paidRows) {
      if (withPayment.has(r.id) || (r.credit_cents ?? 0) >= (r.total_cents ?? 0)) continue;
      entries.push({ key: `paid_no_payment:${r.id}`, kind: "paid_no_payment", text: r.invoice_number ?? "an invoice" });
    }
  }

  if (conn && conn.status === "active") {
    const startMs = Math.max(conn.connected_at ? Date.parse(conn.connected_at) : 0, conn.sync_start_date ? Date.parse(`${conn.sync_start_date}T00:00:00Z`) : 0, nowMs - 30 * 86_400_000);
    const { data: recent } = await db
      .from("invoice_payments")
      .select("id, created_at")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("status", "succeeded")
      .gte("created_at", new Date(startMs).toISOString())
      .lt("created_at", new Date(nowMs - 86_400_000).toISOString())
      .limit(200);
    const ids = ((recent ?? []) as Array<{ id: string }>).map((p) => p.id);
    if (ids.length) {
      const [{ data: links }, { data: skipped }] = await Promise.all([
        db.from("accounting_links").select("local_key").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("entity_type", "payment").in("local_key", ids),
        db.from("accounting_sync_jobs").select("entity_id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("entity_type", "payment").in("status", ["skipped", "failed", "pending", "running"]).in("entity_id", ids),
      ]);
      const known = new Set([...((links ?? []) as Array<{ local_key: string }>).map((l) => l.local_key), ...((skipped ?? []) as Array<{ entity_id: string }>).map((j) => j.entity_id)]);
      const missing = ids.filter((id) => !known.has(id));
      for (const id of missing) entries.push({ key: `unsynced_payment:${id}`, kind: "unsynced_payment", text: "a payment" });
    }
  }
  return { entries, provider: conn?.provider ?? null };
}

/** The latest instalment past due (+grace) that what's been paid doesn't cover. PURE. */
export function missedInstalment(plan: Pick<PaymentPlanRow, "instalments" | "starting_balance_cents">, owingNowCents: number, today: string) {
  const paid = Math.max(0, plan.starting_balance_cents - owingNowCents);
  let cumulative = 0;
  let missed: PaymentPlanRow["instalments"][number] | null = null;
  for (const inst of [...plan.instalments].sort((a, b) => a.n - b.n)) {
    cumulative += inst.amountCents;
    if (addDays(inst.dueDate, PLAN_GRACE_DAYS) < today && paid < cumulative) missed = inst;
  }
  return missed;
}

/** Drop entries the owner was already told about. */
async function newEntries(admin: AdminClient, ctx: CompanyCtx, entries: AlertEntry[]): Promise<AlertEntry[]> {
  if (entries.length === 0) return [];
  const { data } = await (admin as Db)
    .from("money_alert_items")
    .select("item_key")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", ctx.companyId)
    .in("item_key", entries.map((e) => e.key));
  const told = new Set(((data ?? []) as Array<{ item_key: string }>).map((r) => r.item_key));
  return entries.filter((e) => !told.has(e.key));
}

export interface DailyAlertOutcome {
  companyId: string;
  status: "sent" | "skipped" | "failed" | "claimed_elsewhere";
  body?: string | null;
}

/** One company's alert for today. Exported for tests and the CLI-free manual run. */
export async function runCompanyMoneyAlert(admin: AdminClient, ctx: CompanyCtx, nowMs: number): Promise<DailyAlertOutcome> {
  const db = admin as Db;
  const today = todayIn(ctx, nowMs);
  const { data: claim, error } = await db
    .from("money_alerts")
    .insert({ organization_id: ctx.organizationId, company_id: ctx.companyId, alert_date: today, status: "claimed" })
    .select("id")
    .single();
  if (error || !claim) return { companyId: ctx.companyId, status: "claimed_elsewhere" };
  const alertId = (claim as { id: string }).id;
  const finish = (patch: Record<string, unknown>) => db.from("money_alerts").update(patch).eq("id", alertId).eq("organization_id", ctx.organizationId);
  try {
    const { entries, provider } = await collectAlertEntries(admin, ctx, nowMs);
    const fresh = await newEntries(admin, ctx, entries);
    const body = composeMoneyAlert(ctx.name, fresh, provider);
    if (!body || !ctx.ownerPhone) {
      await finish({ status: "skipped", items: fresh.map((e) => e.key) });
      return { companyId: ctx.companyId, status: "skipped", body };
    }
    const keys = [...new Set(fresh.flatMap((e) => [e.key, ...(e.alsoKeys ?? [])]))];
    for (const key of keys) {
      await db.from("money_alert_items").insert({ organization_id: ctx.organizationId, company_id: ctx.companyId, item_key: key, alert_date: today });
    }
    const sent = await sendOwnerSms(admin, { to: ctx.ownerPhone, body, organizationId: ctx.organizationId, companyId: ctx.companyId, platformBrand: ctx.platformBrand });
    if (sent.status === "sent") {
      await finish({ status: "sent", body, items: keys, sent_at: new Date(nowMs).toISOString() });
      return { companyId: ctx.companyId, status: "sent", body };
    }
    // Not sent: forget the items so tomorrow's alert carries them.
    await db.from("money_alert_items").delete().eq("organization_id", ctx.organizationId).eq("company_id", ctx.companyId).eq("alert_date", today);
    await finish({ status: "failed", body, last_error: sent.reason ?? sent.status });
    return { companyId: ctx.companyId, status: "failed", body };
  } catch (err) {
    await finish({ status: "failed", last_error: err instanceof Error ? err.message : String(err) });
    return { companyId: ctx.companyId, status: "failed" };
  }
}

/** Scheduler pass: every company whose local time is 08:00–10:59 and has the alert on. */
export async function runDailyMoneyAlerts(admin: AdminClient, nowMs: number = Date.now()): Promise<DailyAlertOutcome[]> {
  const db = admin as Db;
  const { data } = await db.from("companies").select("id, organization_id, timezone, owner_phone_e164").not("owner_phone_verified_at", "is", null).limit(5000);
  const outcomes: DailyAlertOutcome[] = [];
  for (const c of (data ?? []) as Array<{ id: string; organization_id: string; timezone: string | null; owner_phone_e164: string | null }>) {
    if (!c.owner_phone_e164) continue;
    const hour = localParts(nowMs, c.timezone).hour;
    if (hour < ALERT_HOUR || hour >= ALERT_LAST_HOUR) continue;
    try {
      const ctx = await loadCompanyCtx(admin, c.organization_id, c.id);
      if (!ctx || !ctx.settings.enabled || !ctx.settings.dailyAlert || !ctx.ownerPhone) continue;
      outcomes.push(await runCompanyMoneyAlert(admin, ctx, nowMs));
    } catch (err) {
      console.error("[bookkeeper] money alert failed", c.id, err instanceof Error ? err.message : err);
    }
  }
  return outcomes;
}
