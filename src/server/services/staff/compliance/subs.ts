/** The company's subcontractors: add / edit / deactivate (Settings and the owner by text). */
import { ValidationError } from "@/server/organizations/context";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { toE164 } from "@/server/services/retell/payload";
import type { Db, SubcontractorRow } from "./db-types";
import { cleanText, namesMatch } from "./kinds";
import { subLabel } from "./holders";

export interface SubInput {
  name?: string | null;
  businessName?: string | null;
  trade?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean;
}

/** Checked, trimmed columns for a sub. Throws ValidationError with a plain message. PURE. */
export function subColumns(input: SubInput, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = (v: string | null | undefined, max: number) => (v == null ? null : cleanText(v, max));
  if (input.name !== undefined) out.name = text(input.name, 80);
  if (input.businessName !== undefined) out.business_name = text(input.businessName, 120);
  if (input.trade !== undefined) out.trade = text(input.trade, 60);
  if (input.notes !== undefined) out.notes = input.notes == null ? null : String(input.notes).trim().slice(0, 1000) || null;
  if (input.phone !== undefined) {
    const raw = input.phone?.trim();
    if (raw) {
      const e164 = toE164(raw);
      if (!e164 || !/^\+[1-9]\d{7,14}$/.test(e164)) throw new ValidationError("That cell number doesn't look right - use 10 digits, like 705-555-0142.");
      out.phone_e164 = e164;
    } else {
      out.phone_e164 = null;
    }
  }
  if (input.email !== undefined) {
    const raw = input.email?.trim().toLowerCase();
    if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new ValidationError("That email doesn't look right.");
    out.email = raw || null;
  }
  if (input.active !== undefined) out.active = input.active;
  if (!partial && !out.name && !out.business_name) throw new ValidationError("Give the sub a name or a business name.");
  return out;
}

export async function createSub(admin: AdminClient, scope: { organizationId: string; companyId: string }, input: SubInput): Promise<SubcontractorRow> {
  const cols = subColumns(input, false);
  const { data, error } = await (admin as Db)
    .from("subcontractors")
    .insert({ organization_id: scope.organizationId, company_id: scope.companyId, active: true, ...cols })
    .select("*")
    .single();
  if (error) throw error;
  return data as SubcontractorRow;
}

export async function updateSub(admin: AdminClient, scope: { organizationId: string; companyId: string }, id: string, input: SubInput): Promise<SubcontractorRow | null> {
  const cols = subColumns(input, true);
  const { data, error } = await (admin as Db)
    .from("subcontractors")
    .update(cols)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", id)
    .select("*");
  if (error) throw error;
  const row = ((data ?? []) as SubcontractorRow[])[0] ?? null;
  if (row && !row.name?.trim() && !row.business_name?.trim()) throw new ValidationError("Give the sub a name or a business name.");
  return row;
}

/** Subs whose name or business name matches the words. PURE. */
export function matchSubs(subs: SubcontractorRow[], words: string): SubcontractorRow[] {
  const w = words.trim();
  if (!w) return [];
  const exact = subs.filter((s) => subLabel(s).toLowerCase() === w.toLowerCase() || (s.name ?? "").toLowerCase() === w.toLowerCase());
  if (exact.length) return exact;
  return subs.filter((s) => namesMatch(s.business_name, w) || namesMatch(s.name, w));
}
