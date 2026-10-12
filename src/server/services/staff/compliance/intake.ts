/**
 * The owner texts a photo or PDF of a certificate (staff/types.ts ownerMedia). Registry order is
 * tax_clerk → service_plans → compliance → purchasing; the tax clerk passes on compliance words
 * and on pictures its reader says aren't a supplier receipt, so they reach us.
 *
 * We claim the text when:
 *   • the words name a compliance document (insurance, WSIB, licence, ticket, cert, …) — unless our
 *     reader clearly says the picture isn't one (then we pass, so a parking ticket isn't filed); or
 *   • our reader says it is one, words or not.
 * A bare picture the reader can't place (or no model) is never claimed: the owner still gets the
 * old "Got the picture…" reply. Never throws (returns null on any error).
 *
 * Idempotent on input.logId (source_key `sms:<logId>`): a redelivered text gets the same reply.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { OwnerMediaHandler, OwnerMediaInput, OwnerMediaResult } from "@/server/services/staff/types";
import type { Db } from "./db-types";
import { complianceDeps } from "./deps";
import { fileDocument, findBySourceKey, savedLine, describeDocument } from "./documents";
import { loadCrew, loadSubs, pickHolder, whoseQuestion, type HolderContext } from "./holders";
import { kindFromWords, mentionsCompliance, prettyDate } from "./kinds";
import { loadComplianceCompany, type ComplianceCompany } from "./settings";
import { docPathFor } from "./storage";
import { localDate } from "./time";

export const MEDIA_INTENT = "compliance_doc";

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

  const words = mentionsCompliance(input.body);
  const deps = complianceDeps();
  const file = await deps.fetchMedia(input.media);
  if (!file) {
    if (!words) return null;
    return { reply: "I couldn't open that file. Send a clear photo or a PDF of the certificate and I'll save it.", intent: MEDIA_INTENT, result: { saved: false, reason: "unreadable_media" } };
  }

  const today = localDate(input.nowMs, company.timeZone);
  const reading = await deps.read({ bytes: file.bytes, contentType: file.contentType, today, scope: company });
  if (!words && !reading?.isComplianceDocument) return null;
  if (words && reading && !reading.isComplianceDocument) return null;

  const wordKind = kindFromWords(input.body);
  const kind = reading?.kind && !(reading.kind === "other" && wordKind) ? reading.kind : wordKind ?? "other";
  const ctx = await holderContext(admin, company);
  const holder = pickHolder({ words: input.body, holderName: reading?.holderName ?? null, kind }, ctx);

  const path = docPathFor(company.organizationId, company.companyId, file.contentType);
  if (!path) return null;
  try {
    await deps.storage(admin).upload(path, file.bytes, file.contentType);
  } catch (err) {
    console.error("[compliance] could not store the document:", err instanceof Error ? err.message : err);
    return { reply: "I couldn't save that file just now. Text it to me again in a few minutes.", intent: MEDIA_INTENT, result: { saved: false, reason: "storage" } };
  }

  const details = { kind, title: reading?.title ?? null, issuer: reading?.issuer ?? null, number: reading?.number ?? null };
  let reply: string;
  if (holder.holder) {
    reply = savedLine({ ...details, expiresOn: reading?.expiresOn ?? null, holderLabel: holder.holder.label, today, reminders: company.settings.reminders });
  } else {
    const expiry = reading?.expiresOn ? `, expires ${prettyDate(reading.expiresOn)}` : "";
    const question =
      holder.reason === "several"
        ? `Whose is it - ${(holder.candidates ?? []).slice(0, 3).join(" or ")}?`
        : holder.reason === "unknown_sub"
          ? holder.candidates?.length
            ? `Which sub is it - ${(holder.candidates ?? []).slice(0, 3).join(", ")}, or someone new (text me their name)?`
            : "Which sub is it? Text me their business name and I'll add them."
          : whoseQuestion(ctx, reading?.holderName ?? null);
    reply = `Got it: ${describeDocument(details)}${expiry}. ${question}`;
  }

  const filed = await fileDocument(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    ...details,
    holder: holder.holder,
    holderName: reading?.holderName ?? null,
    issuedOn: reading?.issuedOn ?? null,
    expiresOn: reading?.expiresOn ?? null,
    filePath: path,
    fileContentType: file.contentType,
    uploadedVia: "sms",
    uploadedBy: `owner_sms:${input.ownerPhone}`,
    sourceKey,
    aiRead: reading ? { ...reading } : null,
    intakeReply: reply,
    today,
    nowMs: input.nowMs,
  });
  if (filed.duplicate) return { reply: filed.doc.intake_reply ?? reply, intent: MEDIA_INTENT, result: { documentId: filed.doc.id, duplicate: true } };
  if (filed.replaced.length && holder.holder) {
    reply = savedLine({ ...details, expiresOn: reading?.expiresOn ?? null, holderLabel: holder.holder.label, today, reminders: company.settings.reminders, replacedCount: filed.replaced.length });
    await (admin as Db).from("compliance_documents").update({ intake_reply: reply }).eq("id", filed.doc.id).eq("company_id", company.companyId);
  }
  return {
    reply,
    intent: MEDIA_INTENT,
    result: { documentId: filed.doc.id, kind, status: filed.doc.status, pendingHolder: !holder.holder, read: Boolean(reading) },
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
