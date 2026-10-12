/**
 * Whose document is it: the company, a crew member (an org member's profile) or a sub. Reads the
 * company's crew and subs; picks the holder from the owner's words, then from the name printed on
 * the document. When neither is clear we ask the owner rather than guess (PURE parts are tested).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { ComplianceKind, Db, HolderType, SubcontractorRow } from "./db-types";
import { nameTokens, namesMatch } from "./kinds";

export interface CrewMember {
  profileId: string;
  name: string;
  role: string;
}

export interface HolderPick {
  type: HolderType;
  profileId: string | null;
  subcontractorId: string | null;
  /** "you" / "Mike" / "Mike's Electric" */
  label: string;
}

export const COMPANY_HOLDER: HolderPick = { type: "company", profileId: null, subcontractorId: null, label: "you" };

export function subLabel(sub: Pick<SubcontractorRow, "business_name" | "name">): string {
  return sub.business_name?.trim() || sub.name?.trim() || "your sub";
}

export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** "Mike's Electric's" / "Mike's" / "your". */
export function possessive(label: string): string {
  if (label === "you") return "your";
  return /s$/i.test(label) ? `${label}'` : `${label}'s`;
}

export async function loadCrew(admin: AdminClient, organizationId: string): Promise<CrewMember[]> {
  const db = admin as Db;
  const { data, error } = await db.from("organization_memberships").select("profile_id, role").eq("organization_id", organizationId).limit(500);
  if (error) throw error;
  const members = (data ?? []) as Array<{ profile_id: string; role: string | null }>;
  if (members.length === 0) return [];
  const { data: profiles, error: pErr } = await db.from("profiles").select("id, full_name").in("id", members.map((m) => m.profile_id));
  if (pErr) throw pErr;
  const names = new Map(((profiles ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name?.trim() || ""]));
  return members.map((m) => ({ profileId: m.profile_id, name: names.get(m.profile_id) ?? "", role: m.role ?? "member" })).filter((m) => m.name);
}

export async function loadSubs(admin: AdminClient, scope: { organizationId: string; companyId: string }, options: { activeOnly?: boolean } = {}): Promise<SubcontractorRow[]> {
  let query = (admin as Db).from("subcontractors").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (options.activeOnly) query = query.eq("active", true);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(1000);
  if (error) throw error;
  return (data ?? []) as SubcontractorRow[];
}

/** Every token of `candidate` appears in `words` (so "Mike's Electric" is found in "for mike's electric"). */
function mentioned(words: string[], candidate: string | null | undefined): boolean {
  const tokens = nameTokens(candidate);
  if (tokens.length === 0) return false;
  const set = new Set(words);
  return tokens.every((t) => set.has(t));
}

const COMPANY_WORDS = /\b(ours?|mine|my own|our own|us|the company|the business|company's|business's)\b/i;
const SUB_WORDS = /\b(subs?|sub-?contractors?|subbie)\b/i;
/** Kinds a business normally holds itself: with no name on it and no hint, it's the owner's own. */
const COMPANY_KINDS: ReadonlySet<ComplianceKind> = new Set(["liability_insurance", "wsib_account", "vehicle_insurance", "business_licence", "bond"]);

export interface HolderContext {
  companyNames: string[];
  crew: CrewMember[];
  subs: SubcontractorRow[];
}

export interface HolderResult {
  holder: HolderPick | null;
  /** Why there's no holder (null when there is one). */
  reason?: "unclear" | "several" | "unknown_sub";
  candidates?: string[];
}

/**
 * The holder from the owner's words, else the name printed on the document, else the kind (an
 * unnamed policy of a company kind is the owner's). PURE.
 */
export function pickHolder(input: { words: string; holderName: string | null; kind: ComplianceKind | null }, ctx: HolderContext): HolderResult {
  const words = nameTokens(input.words);
  const subHits = ctx.subs.filter((s) => mentioned(words, s.business_name) || mentioned(words, s.name));
  // Crew are found by full name, or by first name when it's unique in the crew.
  const crewHits = ctx.crew.filter((m) => {
    if (mentioned(words, m.name)) return true;
    const first = firstName(m.name);
    return first.length > 1 && mentioned(words, first) && ctx.crew.filter((o) => firstName(o.name).toLowerCase() === first.toLowerCase()).length === 1;
  });
  // A sub's name usually contains a first name too ("Mike's Electric" vs crew Mike): the sub wins
  // when its whole business name was given.
  const strongSubs = subHits.filter((s) => mentioned(words, s.business_name));
  if (strongSubs.length === 1) return { holder: forSub(strongSubs[0]) };
  const hits = [...subHits.map((s) => ({ kind: "sub" as const, s })), ...crewHits.map((m) => ({ kind: "crew" as const, m }))];
  if (hits.length === 1) return { holder: hits[0].kind === "sub" ? forSub(hits[0].s) : forCrew(hits[0].m) };
  if (hits.length > 1) return { holder: null, reason: "several", candidates: hits.map((h) => (h.kind === "sub" ? subLabel(h.s) : firstName(h.m.name))) };
  if (SUB_WORDS.test(input.words)) return { holder: null, reason: "unknown_sub", candidates: ctx.subs.filter((s) => s.active).map(subLabel).slice(0, 5) };
  if (COMPANY_WORDS.test(input.words)) return { holder: COMPANY_HOLDER };

  const printed = input.holderName;
  if (printed) {
    if (ctx.companyNames.some((n) => namesMatch(n, printed))) return { holder: COMPANY_HOLDER };
    const subByName = ctx.subs.filter((s) => namesMatch(s.business_name, printed) || namesMatch(s.name, printed));
    const crewByName = ctx.crew.filter((m) => namesMatch(m.name, printed) && nameTokens(printed).length >= 2);
    if (subByName.length + crewByName.length === 1) return { holder: subByName[0] ? forSub(subByName[0]) : forCrew(crewByName[0]) };
    return { holder: null, reason: "unclear", candidates: [] };
  }
  if (input.kind && COMPANY_KINDS.has(input.kind)) return { holder: COMPANY_HOLDER };
  return { holder: null, reason: "unclear", candidates: [] };
}

export function forSub(sub: SubcontractorRow): HolderPick {
  return { type: "subcontractor", profileId: null, subcontractorId: sub.id, label: subLabel(sub) };
}

export function forCrew(member: CrewMember): HolderPick {
  return { type: "crew", profileId: member.profileId, subcontractorId: null, label: firstName(member.name) || member.name };
}

/** "Is this for you, Mike (crew) or a sub?" — the crew who aren't owners, first names, up to 3. PURE. */
export function whoseQuestion(ctx: HolderContext, printedName: string | null): string {
  const crew = ctx.crew.filter((m) => m.role !== "owner").map((m) => firstName(m.name)).filter(Boolean);
  const unique = [...new Set(crew)].slice(0, 3);
  const crewPart = unique.length ? `, ${unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(", ")} or ${unique.at(-1)}`} (crew)` : "";
  const printed = printedName ? ` It says "${printedName}".` : "";
  return `Is this for you${crewPart} or a sub?${printed}`;
}
