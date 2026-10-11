/**
 * Matching import rows to the company's contacts: by phone (last 10 digits) or email, and — only
 * for a row with neither — by the exact same name on a contact that also has neither. Rows of the
 * same file that are the same customer resolve to one contact. Every read is pinned to the
 * organization AND company.
 */
import { chunks } from "./util";
import type { Db } from "./db-types";
import { displayName, phoneLast10, type ImportRecord } from "./normalize";

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

function nameKey(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

export class ContactResolver {
  private readonly byPhone = new Map<string, KnownContact>();
  private readonly byEmail = new Map<string, KnownContact>();
  private readonly byName = new Map<string, KnownContact>();

  constructor(
    private readonly db: Db,
    private readonly scope: { organizationId: string; companyId: string },
  ) {}

  private add(row: Record<string, unknown>, source: KnownContact["source"]): KnownContact {
    const contact: KnownContact = {
      id: String(row.id),
      first_name: (row.first_name as string | null) ?? null,
      last_name: (row.last_name as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      email: (row.email as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      customer_account_id: (row.customer_account_id as string | null) ?? null,
      metadata: row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null,
      source,
    };
    const p = phoneLast10(contact.phone);
    if (p && !this.byPhone.has(p)) this.byPhone.set(p, contact);
    const e = contact.email?.toLowerCase();
    if (e && !this.byEmail.has(e)) this.byEmail.set(e, contact);
    if (!p && !e) {
      const n = nameKey(contact.first_name, contact.last_name);
      if (n && !this.byName.has(n)) this.byName.set(n, contact);
    }
    return contact;
  }

  /** Load the company's contacts that could match these records (phones, emails, names). Throws on a read error. */
  async preload(records: ImportRecord[]): Promise<void> {
    const phones = [...new Set(records.map((r) => phoneLast10(r.phone)).filter((p): p is string => Boolean(p) && !this.byPhone.has(p!)))];
    const emails = [...new Set(records.map((r) => r.email).filter((e): e is string => Boolean(e) && !this.byEmail.has(e!)))];
    const firstNames = [...new Set(records.filter((r) => !r.phone && !r.email && r.firstName).map((r) => r.firstName!))];
    const base = () => this.db.from("contacts").select(KNOWN_CONTACT_COLUMNS).eq("organization_id", this.scope.organizationId).eq("company_id", this.scope.companyId);
    for (const list of chunks(phones)) {
      const { data, error } = await base().in("phone_last10", list).limit(5000);
      if (error) throw error;
      for (const row of (data ?? []) as Array<Record<string, unknown>>) this.add(row, "db");
    }
    for (const list of chunks(emails)) {
      const { data, error } = await base().in("email", list).limit(5000);
      if (error) throw error;
      for (const row of (data ?? []) as Array<Record<string, unknown>>) this.add(row, "db");
    }
    for (const list of chunks(firstNames)) {
      const { data, error } = await base().in("first_name", list).limit(5000);
      if (error) throw error;
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        if (!row.phone && !row.email) this.add(row, "db");
      }
    }
  }

  /** The contact this record is, if we know one. PURE over what was loaded. */
  find(r: ImportRecord): KnownContact | null {
    const p = phoneLast10(r.phone);
    if (p && this.byPhone.has(p)) return this.byPhone.get(p)!;
    if (r.email && this.byEmail.has(r.email)) return this.byEmail.get(r.email)!;
    if (!p && !r.email) {
      const n = nameKey(r.firstName, r.lastName) || displayName(r).toLowerCase();
      if (this.byName.has(n)) return this.byName.get(n)!;
    }
    return null;
  }

  /** Remember a contact this pass created (or, in a preview, would create). */
  remember(id: string, r: ImportRecord, extra: Partial<KnownContact> = {}): KnownContact {
    return this.add(
      { id, first_name: r.firstName, last_name: r.lastName, phone: r.phone, email: r.email, notes: r.notes, customer_account_id: null, metadata: null, ...extra },
      "batch",
    );
  }

  /** Also index a known contact under this record's other keys (a row with phone + email). */
  link(contact: KnownContact, r: ImportRecord): void {
    const p = phoneLast10(r.phone);
    if (p && !this.byPhone.has(p)) this.byPhone.set(p, contact);
    if (r.email && !this.byEmail.has(r.email)) this.byEmail.set(r.email, contact);
  }
}
