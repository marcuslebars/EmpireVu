/**
 * The preview the owner sees before anything is written: new contacts, matches to existing ones
 * (phone last-10 or email — blanks filled, nothing overwritten), skipped rows with the reason,
 * past jobs, open balances and their total, sample rows. Reads only.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, ImportBatchRow, ImportField, ImportPreview, PreviewSample } from "./db-types";
import { balanceKey, buildRecord, dateOrdersFor, displayName, jobKey, type DateOrder, type ImportRecord } from "./normalize";
import { ContactResolver } from "./resolver";
import { chunks, readAllPages } from "./util";

export const MAX_ISSUES = 100;
export const MAX_SAMPLES = 8;

export interface LoadedRow {
  row_index: number;
  cells: string[];
}

export async function loadBatchRows(admin: AdminClient, batch: Pick<ImportBatchRow, "id" | "organization_id">, afterIndex = -1, limit?: number): Promise<LoadedRow[]> {
  const db = admin as Db;
  const query = (from: number, to: number) =>
    db.from("import_rows").select("row_index, cells").eq("organization_id", batch.organization_id).eq("batch_id", batch.id).gt("row_index", afterIndex).order("row_index", { ascending: true }).range(from, to);
  if (limit !== undefined) {
    const { data, error } = await query(0, limit - 1);
    if (error) throw error;
    return (data ?? []) as LoadedRow[];
  }
  return readAllPages<LoadedRow>(query, 30_000);
}

/** Existing past jobs / balances among these keys (a re-upload finds what it brought in last time). */
export async function existingKeys(admin: AdminClient, scope: { organizationId: string; companyId: string }, jobKeys: string[], balanceKeys: string[]): Promise<{ jobs: Set<string>; balances: Set<string> }> {
  const db = admin as Db;
  const jobs = new Set<string>();
  const balances = new Set<string>();
  for (const list of chunks([...new Set(jobKeys)])) {
    const { data, error } = await db.from("bookings").select("source_call_id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("source_call_id", list);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ source_call_id: string }>) jobs.add(r.source_call_id);
  }
  for (const list of chunks([...new Set(balanceKeys)])) {
    const { data, error } = await db.from("invoices").select("import_key").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("import_key", list);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ import_key: string }>) balances.add(r.import_key);
  }
  return { jobs, balances };
}

/** Business names that already have a customer account (exact name, this org). */
export async function existingAccounts(admin: AdminClient, organizationId: string, names: string[]): Promise<Map<string, string>> {
  const db = admin as Db;
  const out = new Map<string, string>();
  for (const list of chunks([...new Set(names)])) {
    const { data, error } = await db.from("customer_accounts").select("id, name").eq("organization_id", organizationId).in("name", list).is("archived_at", null);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; name: string }>) if (!out.has(r.name.toLowerCase())) out.set(r.name.toLowerCase(), r.id);
  }
  return out;
}

export interface PreviewInput {
  batch: Pick<ImportBatchRow, "id" | "organization_id" | "company_id" | "file_sha256"> & { mapping: ImportField[] };
  today: string;
  nowMs: number;
}

export async function computePreview(admin: AdminClient, input: PreviewInput): Promise<{ preview: ImportPreview; dateOrders: DateOrder[] }> {
  const { batch } = input;
  const scope = { organizationId: batch.organization_id, companyId: batch.company_id };
  const rows = await loadBatchRows(admin, batch);
  const width = input.batch.mapping.length;
  const dateOrders = dateOrdersFor(rows.map((r) => r.cells), width);

  const built = rows.map((r) => ({ index: r.row_index, result: buildRecord(r.cells, batch.mapping, { dateOrders, today: input.today }) }));
  const valid = built.filter((b): b is { index: number; result: { ok: true; record: ImportRecord } } => b.result.ok);
  const resolver = new ContactResolver(admin as Db, scope);
  await resolver.preload(valid.map((v) => v.result.record));

  const preview: ImportPreview = {
    totalRows: rows.length,
    newContacts: 0,
    matchedContacts: 0,
    repeatRows: 0,
    invalidRows: 0,
    issues: [],
    pastJobs: 0,
    jobsAlreadyImported: 0,
    openBalances: 0,
    openBalanceCents: 0,
    balancesAlreadyImported: 0,
    accounts: 0,
    samples: [],
    sameFileImportedAt: null,
    computedAt: new Date(input.nowMs).toISOString(),
  };
  const matched = new Set<string>();
  const jobKeys: Array<{ key: string; index: number }> = [];
  const balKeys: Array<{ key: string; cents: number }> = [];
  const companies = new Set<string>();
  const seenJobs = new Set<string>();
  const seenBalances = new Set<string>();

  for (const b of built) {
    if (!b.result.ok) {
      preview.invalidRows++;
      if (preview.issues.length < MAX_ISSUES) preview.issues.push({ row: b.index + 2, reason: b.result.reason });
      if (preview.samples.length < MAX_SAMPLES) preview.samples.push({ row: b.index + 2, name: "-", phone: null, email: null, address: null, company: null, match: "invalid", jobs: 0, balanceCents: 0, reason: b.result.reason });
      continue;
    }
    const r = b.result.record;
    let match: PreviewSample["match"];
    let contactId: string;
    const known = resolver.find(r);
    if (known && known.source === "db") {
      match = "existing";
      contactId = known.id;
      if (!matched.has(known.id)) {
        matched.add(known.id);
        preview.matchedContacts++;
      } else preview.repeatRows++;
      resolver.link(known, r);
    } else if (known) {
      match = "same_as_earlier_row";
      contactId = known.id;
      preview.repeatRows++;
      resolver.link(known, r);
    } else {
      match = "new";
      contactId = `new:${b.index}`;
      resolver.remember(contactId, r);
      preview.newContacts++;
    }
    if (r.company) companies.add(r.company);
    if (r.warnings.length && preview.issues.length < MAX_ISSUES) preview.issues.push({ row: b.index + 2, reason: r.warnings.join("; ") });

    let jobs = 0;
    if (r.job) {
      const key = jobKey(batch.company_id, contactId, r.job);
      if (!seenJobs.has(key)) {
        seenJobs.add(key);
        jobs = 1;
        preview.pastJobs++;
        if (!contactId.startsWith("new:")) jobKeys.push({ key, index: b.index });
      }
    }
    if (r.balanceCents > 0) {
      const key = balanceKey(contactId, r);
      if (!seenBalances.has(key)) {
        seenBalances.add(key);
        preview.openBalances++;
        preview.openBalanceCents += r.balanceCents;
        if (!contactId.startsWith("new:")) balKeys.push({ key, cents: r.balanceCents });
      }
    }
    if (preview.samples.length < MAX_SAMPLES) {
      preview.samples.push({ row: b.index + 2, name: displayName(r), phone: r.phone, email: r.email, address: r.address, company: r.company, match, jobs, balanceCents: r.balanceCents });
    }
  }

  // A re-upload: what this company already has from an earlier import is skipped, not duplicated.
  const existing = await existingKeys(admin, scope, jobKeys.map((j) => j.key), balKeys.map((b) => b.key));
  for (const j of jobKeys) {
    if (existing.jobs.has(j.key)) {
      preview.pastJobs--;
      preview.jobsAlreadyImported++;
    }
  }
  for (const b of balKeys) {
    if (existing.balances.has(b.key)) {
      preview.openBalances--;
      preview.openBalanceCents -= b.cents;
      preview.balancesAlreadyImported++;
    }
  }
  const accounts = await existingAccounts(admin, batch.organization_id, [...companies]);
  preview.accounts = [...new Set([...companies].map((c) => c.toLowerCase()))].filter((c) => !accounts.has(c)).length;

  if (batch.file_sha256) {
    const { data } = await (admin as Db)
      .from("import_batches")
      .select("id, import_finished_at, status")
      .eq("organization_id", batch.organization_id)
      .eq("company_id", batch.company_id)
      .eq("file_sha256", batch.file_sha256)
      .eq("status", "done")
      .limit(5);
    const prior = ((data ?? []) as Array<{ id: string; import_finished_at: string | null }>).find((p) => p.id !== batch.id);
    preview.sameFileImportedAt = prior?.import_finished_at ?? null;
  }
  return { preview, dateOrders };
}
