/**
 * Settings → Accounting: connect / disconnect a QuickBooks or Xero file per company,
 * the account mapping, the sync start date, and the status list.
 *
 * Reads go through the caller's session (owners/admins can select connections, links and
 * jobs under RLS). Writes to those tables and every token read are server-only:
 * SANCTIONED EXCEPTION (service role) — each one is for a company the caller was just
 * shown to own/administer (`requireManagerCompany`), or for the company named in an OAuth
 * `state` this server signed for that same owner/admin.
 */
import { z } from "zod";

import { AuthorizationError, ValidationError } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { PROVIDER_LABELS, providerConfigured, quickBooksConfig, redirectUri, type ProviderId } from "./config";
import { signState, verifyState } from "./crypto";
import { providerFor } from "./providers";
import { suggestSettings } from "./suggest";
import { saveTokens, readTokens, sessionFor } from "./tokens";
import { missingSettings, parseSettings, settingsSchema, type AccountingSettings, type ProviderOptions } from "./types";

export function assertManagerRole(role: string): void {
  if (role !== "owner" && role !== "admin") throw new AuthorizationError("Only owners and admins can manage the accounting connection.");
}

async function requireManagerCompany(ctx: TenantServiceContext, role: string, companyId: string): Promise<void> {
  assertManagerRole(role);
  await assertCompanyInOrganization(ctx, companyId);
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface AccountingJobView {
  id: string;
  entityType: "invoice" | "payment" | "expense";
  entityId: string;
  label: string;
  status: string;
  detail: string | null;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
}

export interface AccountingStatus {
  companyId: string;
  providers: Array<{ id: ProviderId; label: string; configured: boolean }>;
  connection: null | {
    provider: ProviderId;
    providerLabel: string;
    remoteName: string | null;
    status: "active" | "needs_reauth";
    environment: string;
    connectedAt: string;
    lastSyncAt: string | null;
    lastError: string | null;
    syncStartDate: string;
    settings: AccountingSettings;
    missing: { invoices: string[]; expenses: string[] };
  };
  counts: { pending: number; failed: number; synced: number };
  recent: AccountingJobView[];
}

export async function getAccountingStatus(ctx: TenantServiceContext, role: string, companyId: string): Promise<AccountingStatus> {
  await requireManagerCompany(ctx, role, companyId);
  const providers = (["quickbooks", "xero"] as const).map((id) => ({ id, label: PROVIDER_LABELS[id], configured: providerConfigured(id) }));
  const { data: conn, error } = await ctx.supabase.from("accounting_connections").select("*").eq("company_id", companyId).eq("organization_id", ctx.organizationId).maybeSingle();
  if (error) throw error;

  const count = async (status: string) => {
    const { count: n, error: e } = await ctx.supabase
      .from("accounting_sync_jobs")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("organization_id", ctx.organizationId)
      .eq("status", status);
    if (e) throw e;
    return n ?? 0;
  };
  const [pending, failed, recentRows, synced] = await Promise.all([
    count("pending"),
    count("failed"),
    ctx.supabase
      .from("accounting_sync_jobs")
      .select("*")
      .eq("company_id", companyId)
      .eq("organization_id", ctx.organizationId)
      .order("updated_at", { ascending: false })
      .limit(40),
    ctx.supabase
      .from("accounting_links")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("organization_id", ctx.organizationId)
      .in("entity_type", ["invoice", "payment", "expense"]),
  ]);
  if (recentRows.error) throw recentRows.error;
  const recent = await labelJobs(ctx, recentRows.data ?? []);

  const settings = parseSettings(conn?.settings);
  return {
    companyId,
    providers,
    connection: conn
      ? {
          provider: conn.provider as ProviderId,
          providerLabel: PROVIDER_LABELS[conn.provider as ProviderId],
          remoteName: conn.remote_name,
          status: conn.status === "needs_reauth" ? "needs_reauth" : "active",
          environment: conn.environment,
          connectedAt: conn.connected_at,
          lastSyncAt: conn.last_sync_at,
          lastError: conn.last_error,
          syncStartDate: conn.sync_start_date,
          settings,
          missing: missingSettings(settings, conn.provider as ProviderId),
        }
      : null,
    counts: { pending, failed, synced: synced.count ?? 0 },
    recent,
  };
}

async function labelJobs(ctx: TenantServiceContext, rows: Array<{ id: string; entity_type: string; entity_id: string; status: string; detail: string | null; last_error: string | null; attempts: number; updated_at: string }>): Promise<AccountingJobView[]> {
  const ids = (t: string) => [...new Set(rows.filter((r) => r.entity_type === t).map((r) => r.entity_id))];
  const [inv, pay, exp] = await Promise.all([
    ids("invoice").length ? ctx.supabase.from("invoices").select("id, invoice_number, total_cents").eq("organization_id", ctx.organizationId).in("id", ids("invoice")) : Promise.resolve({ data: [] as Array<{ id: string; invoice_number: string | null; total_cents: number }> }),
    ids("payment").length ? ctx.supabase.from("invoice_payments").select("id, amount_cents, invoice_id").eq("organization_id", ctx.organizationId).in("id", ids("payment")) : Promise.resolve({ data: [] as Array<{ id: string; amount_cents: number; invoice_id: string }> }),
    ids("expense").length ? ctx.supabase.from("expenses").select("id, vendor, description, amount_cents").eq("organization_id", ctx.organizationId).in("id", ids("expense")) : Promise.resolve({ data: [] as Array<{ id: string; vendor: string | null; description: string | null; amount_cents: number }> }),
  ]);
  const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
  const invMap = new Map((inv.data ?? []).map((i) => [i.id, i]));
  const payMap = new Map((pay.data ?? []).map((p) => [p.id, p]));
  const expMap = new Map((exp.data ?? []).map((e) => [e.id, e]));
  return rows.map((r) => {
    let label = r.entity_type === "invoice" ? "Invoice" : r.entity_type === "payment" ? "Payment" : "Expense";
    if (r.entity_type === "invoice") {
      const i = invMap.get(r.entity_id);
      if (i) label = `Invoice ${i.invoice_number ?? ""} · ${$(i.total_cents)}`.replace("  ", " ");
    } else if (r.entity_type === "payment") {
      const p = payMap.get(r.entity_id);
      if (p) label = `Payment ${$(p.amount_cents)}${invMap.get(p.invoice_id)?.invoice_number ? ` on ${invMap.get(p.invoice_id)?.invoice_number}` : ""}`;
    } else {
      const e = expMap.get(r.entity_id);
      label = e ? `Expense ${$(e.amount_cents)}${e.vendor ? ` · ${e.vendor}` : e.description ? ` · ${e.description}` : ""}` : "Expense (deleted)";
    }
    return {
      id: r.id,
      entityType: r.entity_type as AccountingJobView["entityType"],
      entityId: r.entity_id,
      label,
      status: r.status,
      detail: r.detail,
      lastError: r.last_error,
      attempts: r.attempts,
      updatedAt: r.updated_at,
    };
  });
}

// ── Connect ──────────────────────────────────────────────────────────────────

export async function startConnect(ctx: TenantServiceContext, role: string, companyId: string, provider: ProviderId): Promise<{ url: string }> {
  await requireManagerCompany(ctx, role, companyId);
  if (!providerConfigured(provider)) throw new ValidationError(`${PROVIDER_LABELS[provider]} isn't set up on this server yet.`);
  if (!ctx.actorProfileId) throw new AuthorizationError("Sign in again to connect.");
  const state = signState({ provider, organizationId: ctx.organizationId, companyId, profileId: ctx.actorProfileId });
  return { url: providerFor(provider).authorizeUrl(state, redirectUri(provider)) };
}

/**
 * The provider sent the owner back. The signed `state` says who started it, for which
 * company; that person must still be an owner/admin there. Returns the company id.
 */
export async function completeConnect(provider: ProviderId, params: URLSearchParams, f: typeof fetch = fetch): Promise<{ companyId: string; organizationId: string; remoteName: string | null }> {
  const state = verifyState(params.get("state"));
  if (!state || state.provider !== provider) throw new ValidationError("That sign-in link expired or wasn't started here — try connecting again.");
  const providerError = params.get("error");
  if (providerError) throw new ValidationError(providerError === "access_denied" ? "Connection cancelled." : `The accounting service said: ${providerError}.`);
  const code = params.get("code");
  if (!code) throw new ValidationError("The accounting service didn't send a sign-in code — try again.");

  const admin = createSupabaseAdminClient();
  const { data: member } = await admin
    .from("organization_memberships")
    .select("role")
    .eq("organization_id", state.organizationId)
    .eq("profile_id", state.profileId)
    .maybeSingle();
  if (!member || (member.role !== "owner" && member.role !== "admin")) throw new AuthorizationError("Only owners and admins can connect accounting.");
  const { data: company } = await admin.from("companies").select("id").eq("id", state.companyId).eq("organization_id", state.organizationId).maybeSingle();
  if (!company) throw new ValidationError("That company no longer exists.");

  const { tokens, file } = await providerFor(provider).exchangeCode({ code, redirectUri: redirectUri(provider), query: params }, f);
  const { data: previous } = await admin.from("accounting_connections").select("*").eq("company_id", state.companyId).maybeSingle();
  const sameFile = previous && previous.provider === provider && previous.remote_tenant_id === file.tenantId;
  const environment = provider === "quickbooks" ? quickBooksConfig().environment : "production";
  // Reconnecting the same file keeps its mapping and start date; a new file starts fresh.
  const base = sameFile ? parseSettings(previous.settings) : parseSettings({});
  const settings: AccountingSettings = { ...base, country: file.country ?? base.country ?? null, currency: file.currency ?? base.currency ?? null };
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await admin.from("accounting_connections").upsert(
    {
      company_id: state.companyId,
      organization_id: state.organizationId,
      provider,
      status: "active",
      remote_tenant_id: file.tenantId,
      remote_name: file.name,
      environment,
      settings: settings as never,
      sync_start_date: sameFile ? previous.sync_start_date : today,
      connected_by: state.profileId,
      connected_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "company_id" },
  );
  if (error) throw error;
  await saveTokens(admin, state.companyId, tokens);
  if (sameFile) {
    // Jobs that were paused waiting for the reconnect go now.
    await admin.from("accounting_sync_jobs").update({ available_at: new Date().toISOString() }).eq("company_id", state.companyId).eq("status", "pending");
  } else {
    // A different file: queued work was meant for the old one.
    await admin.from("accounting_sync_jobs").update({ status: "skipped", detail: "Connected to a different file.", done_at: new Date().toISOString() }).eq("company_id", state.companyId).eq("status", "pending");
  }
  return { companyId: state.companyId, organizationId: state.organizationId, remoteName: file.name };
}

export async function disconnect(ctx: TenantServiceContext, role: string, companyId: string): Promise<void> {
  await requireManagerCompany(ctx, role, companyId);
  const admin = createSupabaseAdminClient();
  const { data: conn } = await admin.from("accounting_connections").select("*").eq("company_id", companyId).eq("organization_id", ctx.organizationId).maybeSingle();
  if (!conn) return;
  const tokens = await readTokens(admin, companyId);
  if (tokens) {
    try {
      await providerFor(conn.provider).revoke({ ...tokens, tenantId: conn.remote_tenant_id });
    } catch (err) {
      console.error("[accounting] revoke failed (disconnecting anyway):", err instanceof Error ? err.message : err);
    }
  }
  await admin.from("accounting_sync_jobs").update({ status: "skipped", detail: "Disconnected.", done_at: new Date().toISOString() }).eq("company_id", companyId).eq("status", "pending");
  // Links stay, so reconnecting the same file later updates records instead of duplicating them.
  const { error } = await admin.from("accounting_connections").delete().eq("company_id", companyId).eq("organization_id", ctx.organizationId);
  if (error) throw error;
}

// ── Mapping ──────────────────────────────────────────────────────────────────

async function connectionOrThrow(ctx: TenantServiceContext, companyId: string) {
  const admin = createSupabaseAdminClient();
  const { data: conn, error } = await admin.from("accounting_connections").select("*").eq("company_id", companyId).eq("organization_id", ctx.organizationId).maybeSingle();
  if (error) throw error;
  if (!conn) throw new ValidationError("Connect QuickBooks or Xero first.");
  return { admin, conn };
}

export async function getOptions(ctx: TenantServiceContext, role: string, companyId: string): Promise<{ options: ProviderOptions; suggested: Partial<AccountingSettings> }> {
  await requireManagerCompany(ctx, role, companyId);
  const { admin, conn } = await connectionOrThrow(ctx, companyId);
  const session = await sessionFor(admin, conn);
  const options = await providerFor(conn.provider).options(session);
  return { options, suggested: suggestSettings(options, conn.provider as ProviderId, parseSettings(conn.settings)) };
}

export const settingsUpdateSchema = z.object({
  settings: settingsSchema.partial().omit({ country: true, currency: true }).optional(),
  syncStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Save the mapping / start date, then queue everything from the start date that isn't synced yet. */
export async function updateAccountingSettings(ctx: TenantServiceContext, role: string, companyId: string, input: z.infer<typeof settingsUpdateSchema>): Promise<AccountingStatus> {
  await requireManagerCompany(ctx, role, companyId);
  const { admin, conn } = await connectionOrThrow(ctx, companyId);
  const current = parseSettings(conn.settings);
  const next = settingsSchema.parse({ ...current, ...(input.settings ?? {}), country: current.country, currency: current.currency });
  const start = input.syncStartDate ?? conn.sync_start_date;
  if (start > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) throw new ValidationError("The start date can't be in the future.");
  const { error } = await admin.from("accounting_connections").update({ settings: next as never, sync_start_date: start }).eq("company_id", companyId).eq("organization_id", ctx.organizationId);
  if (error) throw error;
  await queueBackfill(admin, { ...conn, settings: next as never, sync_start_date: start });
  return getAccountingStatus(ctx, role, companyId);
}

/** Queue every record from the start date that isn't linked yet (+ failed ones). Idempotent. */
export async function queueBackfill(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  conn: { company_id: string; organization_id: string; provider: string; remote_tenant_id: string; settings: unknown; sync_start_date: string },
): Promise<number> {
  const s = parseSettings(conn.settings);
  const missing = missingSettings(s, conn.provider as ProviderId);
  const { data: linked } = await admin
    .from("accounting_links")
    .select("entity_type, local_key")
    .eq("company_id", conn.company_id)
    .eq("provider", conn.provider)
    .eq("remote_tenant_id", conn.remote_tenant_id)
    .in("entity_type", ["invoice", "payment", "expense"])
    .limit(50000);
  const done = new Set((linked ?? []).map((l) => `${l.entity_type}:${l.local_key}`));
  const queue: Array<["invoice" | "payment" | "expense", string]> = [];
  if (s.syncInvoices && missing.invoices.length === 0) {
    const { data: invs } = await admin
      .from("invoices")
      .select("id")
      .eq("company_id", conn.company_id)
      .eq("organization_id", conn.organization_id)
      .neq("status", "draft")
      .neq("status", "void")
      .gte("issue_date", conn.sync_start_date)
      .limit(5000);
    for (const i of invs ?? []) if (!done.has(`invoice:${i.id}`)) queue.push(["invoice", i.id]);
  }
  if (s.syncExpenses && missing.expenses.length === 0) {
    const { data: exps } = await admin.from("expenses").select("id").eq("company_id", conn.company_id).eq("organization_id", conn.organization_id).gte("spent_on", conn.sync_start_date).limit(5000);
    for (const e of exps ?? []) if (!done.has(`expense:${e.id}`)) queue.push(["expense", e.id]);
  }
  for (const [type, id] of queue) await admin.rpc("enqueue_accounting_sync", { p_company_id: conn.company_id, p_entity_type: type, p_entity_id: id });
  // Failed jobs get another go (the mapping may have just been fixed).
  const { data: failed } = await admin.from("accounting_sync_jobs").select("entity_type, entity_id").eq("company_id", conn.company_id).eq("status", "failed").limit(1000);
  for (const j of failed ?? []) await admin.rpc("enqueue_accounting_sync", { p_company_id: conn.company_id, p_entity_type: j.entity_type, p_entity_id: j.entity_id });
  if (failed?.length) await admin.from("accounting_sync_jobs").update({ status: "skipped", detail: "Retried." }).eq("company_id", conn.company_id).eq("status", "failed");
  return queue.length;
}

/** "Sync now": retry failures, catch up anything missed, and make queued work due now. */
export async function syncNow(ctx: TenantServiceContext, role: string, companyId: string): Promise<{ queued: number }> {
  await requireManagerCompany(ctx, role, companyId);
  const { admin, conn } = await connectionOrThrow(ctx, companyId);
  if (conn.status !== "active") throw new ValidationError("Reconnect the accounting file first.");
  const queued = await queueBackfill(admin, conn);
  await admin.from("accounting_sync_jobs").update({ available_at: new Date().toISOString() }).eq("company_id", companyId).eq("status", "pending");
  return { queued };
}

/** For the invoice / expense screens: has this record reached the file? */
export async function syncStateFor(ctx: TenantServiceContext, companyId: string, entityType: "invoice" | "expense", id: string): Promise<null | { provider: string; status: "synced" | "pending" | "failed" | "not_synced"; note: string | null; syncedAt: string | null; error: string | null }> {
  const { data: conn } = await ctx.supabase.from("accounting_connections").select("provider, remote_tenant_id").eq("company_id", companyId).eq("organization_id", ctx.organizationId).maybeSingle();
  if (!conn) return null;
  const [{ data: link }, { data: job }] = await Promise.all([
    ctx.supabase.from("accounting_links").select("synced_at, note").eq("company_id", companyId).eq("provider", conn.provider).eq("remote_tenant_id", conn.remote_tenant_id).eq("entity_type", entityType).eq("local_key", id).maybeSingle(),
    ctx.supabase.from("accounting_sync_jobs").select("status, last_error").eq("company_id", companyId).eq("entity_type", entityType).eq("entity_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const status = job?.status === "pending" || job?.status === "running" ? "pending" : job?.status === "failed" ? "failed" : link ? "synced" : "not_synced";
  return { provider: PROVIDER_LABELS[conn.provider as ProviderId], status, note: link?.note ?? null, syncedAt: link?.synced_at ?? null, error: status === "failed" ? (job?.last_error ?? null) : null };
}
