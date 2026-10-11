/**
 * SANCTIONED EXCEPTION (service role): the concierge's porting queue (operator-only routes run
 * requireOperator first). Every open port across accounts, with each Twilio port-in form field
 * formatted for copy-paste. The account number shows only as its last four and the PIN only as
 * "on file": revealing them is a separate, audited concierge action (port_reveal_secrets).
 */
import { prettyPhone } from "@/lib/carrier-forwarding";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, NumberPortRow, PinStatus, PortStatus } from "@/server/services/staff/porting/db-types";
import { focDateText, OPEN_STATUSES, STATUS_LABELS } from "@/server/services/staff/porting/status";

/** Twilio wants the LOA and the bill dated within the last 30 days. */
export const DOC_MAX_AGE_MS = 30 * 86_400_000;

export interface TwilioFormField {
  label: string;
  value: string;
  /** False for the masked account number / PIN (filled by the reveal, never copied masked). */
  copy: boolean;
}

export interface OperatorPortView {
  id: string;
  organizationId: string;
  companyId: string;
  companyName: string;
  status: PortStatus;
  statusLabel: string;
  ownerPhone: string | null;
  numbers: string[];
  createdAt: string;
  readyAt: string | null;
  submittedAt: string | null;
  focDate: string | null;
  focDateText: string | null;
  twilioPortRequestId: string | null;
  rejectionReason: string | null;
  pinStatus: PinStatus;
  accountLast4: string | null;
  secretsPurged: boolean;
  hasLoa: boolean;
  hasBill: boolean;
  loaSignedAt: string | null;
  billUploadedAt: string | null;
  warnings: string[];
  twilioForm: TwilioFormField[];
}

function pinText(status: PinStatus, hasAccount: boolean): string {
  if (status === "stored") return "On file - reveal";
  if (status === "call") return hasAccount ? "Call the owner for the PIN" : "Call the owner for the account number and PIN";
  return "No PIN (owner says none)";
}

export function operatorPortView(port: NumberPortRow, company: { name: string | null; owner_phone_e164: string | null } | null, nowMs: number): OperatorPortView {
  const warnings: string[] = [];
  const loaAge = port.loa_signed_at ? nowMs - Date.parse(port.loa_signed_at) : null;
  const billAge = port.bill_uploaded_at ? nowMs - Date.parse(port.bill_uploaded_at) : null;
  const preSubmit = port.status === "ready" || port.status === "collecting" || port.status === "rejected";
  if (preSubmit && loaAge !== null && loaAge > DOC_MAX_AGE_MS) warnings.push("LOA is over 30 days old - mark rejected so the owner re-signs.");
  if (preSubmit && billAge !== null && billAge > DOC_MAX_AGE_MS) warnings.push("Bill was uploaded over 30 days ago - ask for a newer one.");
  if (port.pin_status === "call") warnings.push(port.account_number_enc ? "Call the owner for the PIN." : "Call the owner for the account number and PIN (no encryption key when they filled it in).");
  if (port.secrets_purged_at) warnings.push("Account number and PIN were purged.");

  const address = port.service_address;
  const form: TwilioFormField[] = [
    { label: "Numbers to port", value: port.numbers.join("\n"), copy: true },
    { label: "Billing telephone number (BTN)", value: port.numbers[0] ?? "", copy: true },
    { label: "Losing carrier", value: port.carrier ?? "", copy: true },
    { label: "Business name (as on the account)", value: port.business_name ?? "", copy: true },
    { label: "Authorized representative", value: port.authorized_name ?? "", copy: true },
    { label: "Service address - street", value: address ? [address.line1, address.line2].filter(Boolean).join(", ") : "", copy: true },
    { label: "City", value: address?.city ?? "", copy: true },
    { label: "Province / state", value: address?.province ?? "", copy: true },
    { label: "Postal / ZIP code", value: address?.postalCode ?? "", copy: true },
    { label: "Country", value: address?.country ?? "", copy: true },
    { label: "Account number", value: port.account_number_enc ? `ending ${port.account_number_last4 ?? "????"} - reveal` : "Call the owner", copy: false },
    { label: "PIN / passcode", value: pinText(port.pin_status, Boolean(port.account_number_enc)), copy: false },
    { label: "LOA signed", value: port.loa_signed_at ? `${port.loa_signed_name ?? ""} on ${port.loa_signed_at.slice(0, 10)}` : "", copy: true },
    { label: "Owner cell (carrier approval text)", value: company?.owner_phone_e164 ? prettyPhone(company.owner_phone_e164) : "", copy: true },
  ];
  return {
    id: port.id,
    organizationId: port.organization_id,
    companyId: port.company_id,
    companyName: company?.name ?? port.business_name ?? "Unknown business",
    status: port.status,
    statusLabel: STATUS_LABELS[port.status],
    ownerPhone: company?.owner_phone_e164 ?? null,
    numbers: port.numbers,
    createdAt: port.created_at,
    readyAt: port.ready_at,
    submittedAt: port.submitted_at,
    focDate: port.foc_date,
    focDateText: port.foc_date ? focDateText(port.foc_date) : null,
    twilioPortRequestId: port.twilio_port_request_id,
    rejectionReason: port.rejection_reason,
    pinStatus: port.pin_status,
    accountLast4: port.account_number_enc ? port.account_number_last4 : null,
    secretsPurged: Boolean(port.secrets_purged_at),
    hasLoa: Boolean(port.loa_path),
    hasBill: Boolean(port.bill_path),
    loaSignedAt: port.loa_signed_at,
    billUploadedAt: port.bill_uploaded_at,
    warnings,
    twilioForm: form,
  };
}

const STATUS_ORDER: Record<PortStatus, number> = { ready: 0, rejected: 1, submitted: 2, foc_scheduled: 3, collecting: 4, completed: 5, cancelled: 6 };

/** Every open port (ready first), across accounts. */
export async function listOperatorPorts(admin: AdminClient, nowMs: number = Date.now()): Promise<OperatorPortView[]> {
  const db = admin as Db;
  const { data, error } = await db.from("number_port_requests").select("*").in("status", OPEN_STATUSES).order("created_at", { ascending: true }).limit(500);
  if (error) throw error;
  const ports = (data ?? []) as NumberPortRow[];
  if (ports.length === 0) return [];
  const { data: companies } = await db
    .from("companies")
    .select("id, name, owner_phone_e164")
    .in("id", [...new Set(ports.map((p) => p.company_id))]);
  const byId = new Map(((companies ?? []) as Array<{ id: string; name: string | null; owner_phone_e164: string | null }>).map((c) => [c.id, c]));
  return ports
    .map((p) => operatorPortView(p, byId.get(p.company_id) ?? null, nowMs))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.createdAt.localeCompare(b.createdAt));
}

/** One port by id across accounts (operator file downloads) — the caller audits with its org. */
export async function loadPortForOperator(admin: AdminClient, portId: string): Promise<NumberPortRow | null> {
  const { data, error } = await (admin as Db).from("number_port_requests").select("*").eq("id", portId).maybeSingle();
  if (error) throw error;
  return (data as NumberPortRow | null) ?? null;
}
