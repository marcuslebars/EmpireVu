/**
 * Matching import rows to the company's contacts, every read pinned to the organization AND
 * company:
 *
 *   • same phone (last 10 digits) or same email — AND a name that fits (same or missing first
 *     name, or one a short form of the other: "Pat" / "Patricia"; same or missing last name).
 *     A phone/email that belongs to someone with a clearly different name (a shared family line,
 *     a typo) is NOT merged: the row becomes its own contact and the preview says so
 *     (`conflict`). Rows of one file that are the same person resolve to one contact.
 *   • a row with no phone and no email is never matched by name (two John Smiths stay two). The
 *     only thing it matches is the contact an earlier upload made from the very same row
 *     (metadata.import.rowKey), so re-uploading the same file still creates nothing new.
 */
import type { Db } from "./db-types";
import { phoneLast10, type ImportRecord } from "./normalize";
import { chunks } from "./util";

export interface KnownContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  customer_account_id: string | null;
  metadata: Record<string, unknown> | null;
  /** "db" = was there before this pass; "batch" = this pass created (or planned) it. */
  source: "db" | "batch";
}

export const KNOWN_CONTACT_COLUMNS = "id, first_name, last_name, phone, phone_last10, email, notes, customer_account_id, metadata";

function norm(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
}

/** The record names a person (not just a business name standing in for one). PURE. */
function personName(r: Pick<ImportRecord, "firstName" | "lastName" | "company">): { first: string; last: string } | null {
  if (r.company && !r.lastName && r.firstName === r.company) return null;
  const first = norm(r.firstName);
  const last = norm(r.lastName);
  return first || last ? { first, last } : null;
}

/** Could these be the same person? Missing parts don't disagree; "Pat" fits "Patricia". PURE. */
export function namesFit(a: { first: string; last: string } | null, b: { first: string; last: string } | null): boolean {
  if (!a || !b) return true;
  const firstOk = !a.first || !b.first || a.first.startsWith(b.first) || b.first.startsWith(a.first);
  const lastOk = !a.last || !b.last || a.last === b.last;
  return firstOk && lastOk;
}

function contactName(c: KnownContact): { first: string; last: string } | null {
  const first = norm(c.first_name);
  const last = norm(c.last_name);
  return first || last ? { first, last } : null;
}

export interface Resolution {
  known: KnownContact | null;
  /** A contact with this phone/email but a clearly different name (not merged). */
  conflict: KnownContact | null;
}

export class ContactResolver {
  private readonly byPhone = new Map<string, KnownContact[]>();
  private readonly byEmail = new Map<string, KnownContact[]>();
  private readonly byRowKey = new Map<string, KnownContact>();
  private readonly ids = new Map<string, KnownContact>();

  constructor(
    private readonly db: Db,
    private readonly scope: { organizationId: string; companyId: string },
  ) {}

  private index(map: Map<string, KnownContact[]>, key: string | null | undefined, contact: KnownContact): void {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.includes(contact)) list.push(contact);
    map.set(key, list);
  }

  private add(row: Record<string, unknown>, source: KnownContact["source"]): KnownContact {
    const id = String(row.id);
    const existing = this.ids.get(id);
    if (existing) return existing;
    const contact: KnownContact = {
      id,
      first_name: (row.first_name as string | null) ?? null,
      last_name: (row.last_name as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      email: (row.email as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      customer_account_id: (row.customer_account_id as string | null) ?? null,
      metadata: row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null,
      source,
    };
    this.ids.set(id, contact);
    this.index(this.byPhone, phoneLast10(contact.phone), contact);
    this.index(this.byEmail, contact.email?.toLowerCase(), contact);
    const rowKey = (contact.metadata?.import as { rowKey?: unknown } | undefined)?.rowKey;
    if (typeof rowKey === "string" && !this.byRowKey.has(rowKey)) this.byRowKey.set(rowKey, contact);
    return contact;
  }

  /** Load the company's contacts that could match these records. Throws on a read error. */
  async preload(records: ImportRecord[]): Promise<void> {
    const phones = [...new Set(records.map((r) => phoneLast10(r.phone)).filter((p): p is string => Boolean(p) && !this.byPhone.has(p!)))];
    const emails = [...new Set(records.map((r) => r.email).filter((e): e is string => Boolean(e) && !this.byEmail.has(e!)))];
    const rowKeys = [...new Set(records.filter((r) => !r.phone && !r.email).map((r) => r.rowKey).filter((k) => !this.byRowKey.has(k)))];
    const base = () => this.db.from("contacts").select(KNOWN_CONTACT_COLUMNS).eq("organization_id", this.scope.organizationId).eq("company_id", this.scope.companyId);
    const load = async (column: string, values: string[]) => {
      for (const list of chunks(values)) {
        const { data, error } = await base().in(column, list).limit(5000);
        if (error) throw error;
        for (const row of (data ?? []) as Array<Record<string, unknown>>) this.add(row, "db");
      }
    };
    await load("phone_last10", phones);
    await load("email", emails);
    await load("metadata->import->>rowKey", rowKeys);
  }

  /** Who this record is, if we know them (and who we didn't merge it with). PURE over what was loaded. */
  find(r: ImportRecord): Resolution {
    if (!r.phone && !r.email) return { known: this.byRowKey.get(r.rowKey) ?? null, conflict: null };
    const name = personName(r);
    const candidates = [...(this.byPhone.get(phoneLast10(r.phone) ?? "") ?? []), ...(r.email ? (this.byEmail.get(r.email) ?? []) : [])];
    const fit = candidates.find((c) => namesFit(name, contactName(c)));
    return { known: fit ?? null, conflict: fit ? null : (candidates[0] ?? null) };
  }

  /** Remember a contact this pass created (or, in a preview, would create). */
  remember(id: string, r: ImportRecord, extra: Partial<KnownContact> = {}): KnownContact {
    const contact = this.add(
      { id, first_name: r.firstName, last_name: r.lastName, phone: r.phone, email: r.email, notes: r.notes, customer_account_id: null, metadata: null, ...extra },
      "batch",
    );
    if (!r.phone && !r.email) this.byRowKey.set(r.rowKey, contact);
    return contact;
  }

  /** Also index a known contact under this record's other keys (a row with phone + email). */
  link(contact: KnownContact, r: ImportRecord): void {
    this.index(this.byPhone, phoneLast10(r.phone), contact);
    if (r.email) this.index(this.byEmail, r.email, contact);
  }
}
