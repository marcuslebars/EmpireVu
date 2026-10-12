/**
 * The owner texts a photo or PDF of a certificate (staff/types.ts ownerMedia), up to 3 files
 * (front + back pages) filed as ONE document. Registry order is tax_clerk → service_plans →
 * compliance → purchasing; the tax clerk reads the picture and passes when its reader says it isn't
 * a receipt, so certificates reach us.
 *
 * We claim the text when:
 *   • our reader says it's a compliance document (words or not); when the reader says it ISN'T
 *     one we always pass ("building permit fee Jones job", "insurance payment", a parking ticket);
 *   • our reader couldn't read it at all (no key, timeout, 5xx) AND the words name a specific
 *     document ("our WSIB clearance", "truck insurance") with no payment words (paid, payment, fee,
 *     invoice, receipt, bill). "permit", "policy", "ticket" alone are never enough.
 * A bare picture the reader can't place is never claimed: the owner still gets the old "Got the
 * picture…" reply. A document with no readable date never replaces a live one (documents.ts), so
 * a misfiled receipt can't switch the expiry chase off. Never throws (returns null on any error).
 *
 * Idempotent on input.logId (source_key `sms:<logId>`): a redelivered text gets the same reply.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { OwnerMediaHandler, OwnerMediaInput, OwnerMediaResult } from "@/server/services/staff/types";
import type { Db } from "./db-types";
import { complianceDeps } from "./deps";
import { fileDocument, findBySourceKey, savedLine, describeDocument, trackUpload } from "./documents";
import { loadCrew, loadSubs, pickHolder, whoseQuestion, type HolderContext } from "./holders";
import { prettyDate, wordsClaim } from "./kinds";
import { mergeReadings, type ComplianceReading } from "./reader";
import { loadComplianceCompany, type ComplianceCompany } from "./settings";
import { docPathFor } from "./storage";
import { localDate } from "./time";

export const MEDIA_INTENT = "compliance_doc";
/** Pages per text (front + back). */
export const MAX_PAGES = 3;

export async function holderContext(admin: AdminClient, company: ComplianceCompany, extraNames: string[] = []): Promise<HolderContext> {
  const [crew, subs] = await Promise.all([loadCrew(admin, company.organizationId), loadSubs(admin, company)]);
  const { data } = await (admin as Db).from("companies").select("name, brand_from_name").eq("id", company.companyId).maybeSingle();
  const row = (data ?? {}) as { name?: string | null; brand_from_name?: string | null };
  const companyNames = [company.name, row.name, row.brand_from_name, ...extraNames].filter((n): n is string => Boolean(n && n.trim()));
  return { companyNames, crew, subs };
}

export async function handleComplianceMedia(admin: AdminClient, input: OwnerMediaInput): Promise<OwnerMediaResult | null> {
  const company = await loadComplianceCompany(admin, input.scope);
  if (!company || !company.settings.enabled) return null;
  const sourceKey = `sms:${input.logId}`;
  const already = await findBySourceKey(admin, company.companyId, sourceKey);
  if (already) return { reply: already.intake_reply ?? "Got it - that one's already saved.", intent: MEDIA_INTENT, result: { documentId: already.id, duplicate: true } };

  // Words alone only count when they name a specific document and say nothing about paying
  // ("our WSIB clearance" yes; "permit", "policy", "ticket", "insurance payment" no).
  const wordKind = wordsClaim(input.body);
  const deps = complianceDeps();
  const files = (await deps.fetchMedia(input.media)).slice(0, MAX_PAGES);
  if (files.length === 0) {
    if (!wordKind) return null;
    return { reply: "I couldn't open that file. Send a clear photo or a PDF of the certificate and I'll save it.", intent: MEDIA_INTENT, result: { saved: false, reason: "unreadable_media" } };
  }

  const today = localDate(input.nowMs, company.timeZone);
  const readings: Array<ComplianceReading | null> = [];
  for (const file of files) readings.push(await deps.read({ bytes: file.bytes, contentType: file.contentType, today, scope: company }));
  const reading = mergeReadings(readings);
  // The reader decides when it could read the picture; words only when it couldn't (no key, timeout).
  if (reading && !reading.isComplianceDocument) return null;
  if (!reading && !wordKind) return null;

  const kind = reading?.kind && reading.kind !== "other" ? reading.kind : wordKind ?? reading?.kind ?? "other";
  const ctx = await holderContext(admin, company);
  const holder = pickHolder({ words: input.body, holderName: reading?.holderName ?? null, kind }, ctx);

  const paths: string[] = [];
  try {
    const storage = deps.storage(admin);
    for (const file of files) {
      const path = docPathFor(company.organizationId, company.companyId, file.contentType);
      if (!path) continue;
      await trackUpload(admin, company, path, input.nowMs);
      await storage.upload(path, file.bytes, file.contentType);
      paths.push(path);
    }
  } catch (err) {
    console.error("[compliance] could not store the document:", err instanceof Error ? err.message : err);
    return { reply: "I couldn't save that file just now. Text it to me again in a few minutes.", intent: MEDIA_INTENT, result: { saved: false, reason: "storage" } };
  }
  if (paths.length === 0) return null;
  const pages = paths.length > 1 ? ` (${paths.length} pages)` : "";

  const details = { kind, title: reading?.title ?? null, issuer: reading?.issuer ?? null, number: reading?.number ?? null };
  const question = (): string => {
    const expiry = reading?.expiresOn ? `, expires ${prettyDate(reading.expiresOn)}` : "";
    const ask =
      holder.reason === "several"
        ? `Whose is it - ${(holder.candidates ?? []).slice(0, 3).join(" or ")}?`
        : holder.reason === "unknown_sub"
          ? holder.candidates?.length
            ? `Which sub is it - ${(holder.candidates ?? []).slice(0, 3).join(", ")}, or someone new (text me their name)?`
            : "Which sub is it? Text me their business name and I'll add them."
          : whoseQuestion(ctx, reading?.holderName ?? null);
    return `Got it${pages}: ${describeDocument(details)}${expiry}. ${ask}`;
  };
  const saved = (replacedCount: number, keptExpiresOn?: string | null): string =>
    savedLine({ ...details, expiresOn: reading?.expiresOn ?? null, holderLabel: holder.holder?.label ?? null, today, reminders: company.settings.reminders, replacedCount, keptExpiresOn }).replace(/^Saved:/, `Saved${pages}:`);
  let reply = holder.holder ? saved(0) : question();

  const filed = await fileDocument(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    ...details,
    holder: holder.holder,
    holderName: reading?.holderName ?? null,
    issuedOn: reading?.issuedOn ?? null,
    expiresOn: reading?.expiresOn ?? null,
    filePath: paths[0],
    fileContentType: files[0].contentType,
    extraFilePaths: paths.slice(1),
    uploadedVia: "sms",
    uploadedBy: `owner_sms:${input.ownerPhone}`,
    sourceKey,
    aiRead: reading ? { ...reading } : null,
    intakeReply: reply,
    today,
    nowMs: input.nowMs,
  });
  if (filed.duplicate) return { reply: filed.doc.intake_reply ?? reply, intent: MEDIA_INTENT, result: { documentId: filed.doc.id, duplicate: true } };
  if (holder.holder && (filed.replaced.length || filed.kept.length)) {
    reply = saved(filed.replaced.length, filed.replaced.length ? undefined : filed.kept[0].expires_on ?? "");
    await (admin as Db).from("compliance_documents").update({ intake_reply: reply }).eq("id", filed.doc.id).eq("company_id", company.companyId);
  }
  return {
    reply,
    intent: MEDIA_INTENT,
    result: { documentId: filed.doc.id, kind, status: filed.doc.status, pendingHolder: !holder.holder, read: Boolean(reading), pages: paths.length },
  };
}

export const complianceOwnerMedia: OwnerMediaHandler = {
  async run(admin, input) {
    try {
      return await handleComplianceMedia(admin, input);
    } catch (err) {
      console.error("[compliance] owner media failed:", err instanceof Error ? err.message : err);
      return null;
    }
  },
};
