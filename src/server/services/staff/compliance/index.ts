/**
 * Compliance (docs/ai-staff.md → "Compliance"): insurance, WSIB, licences, tickets and subs.
 *
 *   Intake    the owner texts a photo / PDF of a certificate (ownerMedia) → AI read (kind, issuer,
 *             number, holder, expiry) → filed under the business, a crew member or a sub (or we
 *             ask whose it is; file_compliance_doc takes the answer). Settings uploads too.
 *   Chase     compliance:expiry texts the owner 30 days and 7 days before, and on the day; a
 *             sub's document becomes a `request_sub_docs` approval → the sub gets an upload link
 *             (/compliance/upload/:token, 14 days) → AI read → filed → the owner is told.
 *   Sharing   the texting assistant's share_compliance_doc → `share_compliance_doc` approval → the
 *             customer / GC gets a 7-day link through our own revocable, audited redirect.
 *
 * On for done-for-you orgs (passive until a document exists), off for house orgs unless switched on.
 */
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { complianceAgentTools } from "./agent-tools";
import { REQUEST_SUB_DOCS_KIND, SHARE_DOC_KIND } from "./approvals";
import { complianceOwnerMedia } from "./intake";
import { complianceOwnerTools } from "./owner-tools";
import { executeRequestSubDocs } from "./requests";
import { complianceActiveFor } from "./settings";
import { executeShareDoc } from "./shares";
import { sweepExpiry, sweepOrphanUploads, sweepOutbox } from "./sweeps";

export const COMPLIANCE_SWEEPS: StaffSweep[] = [
  { name: "compliance:expiry", intervalMs: 15 * 60_000, run: async (admin, nowMs) => void (await sweepExpiry(admin, nowMs)) },
  { name: "compliance:outbox", intervalMs: 2 * 60_000, run: (admin, nowMs) => sweepOutbox(admin, nowMs) },
  { name: "compliance:orphans", intervalMs: 60 * 60_000, run: async (admin, nowMs) => void (await sweepOrphanUploads(admin, nowMs)) },
];

export const complianceRole: StaffRoleModule = {
  ...emptyRole("compliance"),
  activeFor: complianceActiveFor,
  ownerMedia: complianceOwnerMedia,
  approvalExecutors: {
    [REQUEST_SUB_DOCS_KIND]: (admin, approval, decision) => executeRequestSubDocs(admin, approval, decision),
    [SHARE_DOC_KIND]: (admin, approval, decision) => executeShareDoc(admin, approval, decision),
  },
  agentTools: complianceAgentTools,
  agentPromptNotes: [
    "Insurance / WSIB / licences: if someone asks for the business's proof of insurance, certificate of insurance (COI), WSIB clearance, licence or bond (customers, general contractors and property managers often do), call share_compliance_doc with the document they want. It only asks the owner; tell them you're checking and will text it shortly. Never say whether the business has a document, never describe what's on it, and never send a link yourself.",
    "Subcontractors: a text from a subcontractor about uploading their WSIB clearance or insurance for this business (they got an upload link from the business) is not a customer enquiry: don't quote or book; tell them the link in their text is the way to send it, and use hand_off_to_owner for anything else.",
  ],
  ownerTools: complianceOwnerTools(),
  ownerPromptNotes: [
    "Compliance (insurance, WSIB, licences, tickets, subs): when the owner texts a photo of a certificate it's saved for them. When the owner then says whose a certificate is (\"it's ours\", \"that's Mike's\", \"for Mike's Electric\") or corrects one (\"expires Mar 31 2027\", \"that's vehicle insurance\"), call file_compliance_doc and reply with its tell_owner. For \"what's expiring\", \"am I covered\", \"which subs are missing a clearance\" use compliance_status. \"Ask Mike's Electric for a new clearance\" → ask_sub_for_docs and relay tell_owner_exactly word for word (it carries the Y code). Add subs with add_subcontractor; stop_sharing turns off the certificate links sent to customers. We keep the paperwork and remind; we never file anything with WSIB or an insurer.",
  ],
  sweeps: COMPLIANCE_SWEEPS,
};
