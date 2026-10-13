/**
 * One private inbox per business: `<slug>-<8 random>@${INBOUND_EMAIL_DOMAIN}`. The owner sets their
 * mailbox (Gmail / Outlook / anything) to auto-forward there. The random part keeps the address
 * unguessable — anyone who knows it can drop mail into the business's inbox. Made only where the
 * feature is on (Settings, or the owner's `email_setup`), never for a house org that hasn't
 * switched it on.
 */
import { randomBytes } from "node:crypto";

import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, EmailInboxRow } from "./db-types";
import { normalizeAddress } from "./parse";
import { inboundDomain, inboundDomains, noteInboundDomainUse, ourInboundDomainOf } from "./settings";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** 8 lower-case letters/digits (no look-alikes). */
export function randomPart(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** The local part's readable half: the company slug (or name), a-z0-9 and dashes, ≤ 24. PURE. */
export function slugPart(slug: string | null, name: string): string {
  const base = (slug || name || "inbox")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return base || "inbox";
}

export function buildAddress(slug: string | null, name: string, domain: string, random = randomPart()): string {
  return `${slugPart(slug, name)}-${random}@${domain}`;
}

export async function loadInbox(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<EmailInboxRow | null> {
  const { data, error } = await (admin as Db).from("email_inboxes").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).maybeSingle();
  if (error) throw error;
  return (data as EmailInboxRow | null) ?? null;
}

export async function loadInboxById(admin: AdminClient, id: string): Promise<EmailInboxRow | null> {
  const { data, error } = await (admin as Db).from("email_inboxes").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as EmailInboxRow | null) ?? null;
}

/**
 * The company's inbox, made on first ask. Null when the server has no INBOUND_EMAIL_DOMAIN.
 * Callers check the feature is on first. Safe under races (unique company_id → re-read).
 */
export async function ensureInbox(
  admin: AdminClient,
  company: { organizationId: string; companyId: string; slug: string | null; name: string },
  nowMs: number = Date.now(),
): Promise<EmailInboxRow | null> {
  const existing = await loadInbox(admin, company);
  if (existing) return existing;
  const domain = inboundDomain();
  if (!domain) return null;
  const db = admin as Db;
  for (let attempt = 0; attempt < 4; attempt++) {
    const nowIso = new Date(nowMs).toISOString();
    const { data, error } = await db
      .from("email_inboxes")
      .insert({ organization_id: company.organizationId, company_id: company.companyId, address: buildAddress(company.slug, company.name, domain), created_at: nowIso, updated_at: nowIso })
      .select("*")
      .single();
    if (!error) return data as EmailInboxRow;
    if ((error as { code?: string }).code !== "23505") throw error;
    const raced = await loadInbox(admin, company);
    if (raced) return raced;
    // An address collision (vanishingly rare): try another random part.
  }
  throw new Error("Could not make an inbox address.");
}

/**
 * The inbox an email was for: the first of the given addresses that is one of ours (the caller
 * passes the envelope recipients — Resend's received_for — and falls back to To / Cc / Bcc only
 * when those are missing). "Ours" means on ANY configured inbound domain (INBOUND_EMAIL_DOMAINS).
 * Unknown → null. A match on an old-brand domain is counted (inbound_email_domain).
 */
export async function findInboxFor(admin: AdminClient, candidates: Array<string | null | undefined>): Promise<EmailInboxRow | null> {
  const domains = inboundDomains();
  if (domains.length === 0) return null;
  const ours: string[] = [];
  for (const raw of candidates) {
    for (const part of (raw ?? "").split(",")) {
      const a = normalizeAddress(part);
      if (a && ourInboundDomainOf(a, domains) && !ours.includes(a)) ours.push(a);
    }
  }
  if (ours.length === 0) return null;
  const { data, error } = await (admin as Db).from("email_inboxes").select("*").in("address", ours.slice(0, 20));
  if (error) throw error;
  const rows = (data ?? []) as EmailInboxRow[];
  for (const a of ours) {
    const hit = rows.find((r) => r.address === a);
    if (hit) {
      noteInboundDomainUse(ourInboundDomainOf(a, domains));
      return hit;
    }
  }
  return null;
}
