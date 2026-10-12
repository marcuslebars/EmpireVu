/**
 * Keep your number (docs/ai-staff.md → "Keep your number"): the owner's existing business line
 * moves to our Twilio account. Everything is automated except one operator step (Twilio takes
 * Canadian port-ins only through its web form): the owner fills /port/:token (bill + e-signed
 * LOA, account number and PIN encrypted), an operator submits it from the concierge, the hourly
 * sweep spots the number landing, attaches it as a `business_line` (ring the owner first, then
 * the AI) and texts the owner at every step. No approval kinds (nothing here acts on a customer
 * or on money); owner tools start_number_port / number_port_status; three sweeps.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { sweepPortCompletions, sweepPortNotifications, sweepPortPurge } from "@/server/services/staff/porting/completion";
import { portingOwnerTools } from "@/server/services/staff/porting/owner-tools";
import { portingActiveFor } from "@/server/services/staff/porting/settings";
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";

export const PORTING_SWEEPS: StaffSweep[] = [
  { name: "porting:completion", intervalMs: 60 * 60_000, run: async (admin: AdminClient, nowMs) => void (await sweepPortCompletions(admin, nowMs)) },
  { name: "porting:notify", intervalMs: 5 * 60_000, run: (admin, nowMs) => sweepPortNotifications(admin, nowMs) },
  { name: "porting:purge", intervalMs: 60 * 60_000, run: async (admin, nowMs) => void (await sweepPortPurge(admin, nowMs)) },
];

export const portingRole: StaffRoleModule = {
  ...emptyRole("porting"),
  activeFor: portingActiveFor,
  ownerTools: portingOwnerTools(),
  ownerPromptNotes: [
    "Keep your number: when the owner wants to keep their existing business number (\"keep my number\", \"can I port my number\", \"move my number over\"), use start_number_port and reply with its tell_owner_exactly text word for word (it carries their form link). For where it stands, use number_port_status. Never ask for or repeat their carrier account number or PIN by text - those go only in the secure form. If they ask: they must NOT cancel their old phone service (the move ends it), and when their carrier texts asking to approve the transfer they must answer YES within 90 minutes.",
  ],
  sweeps: PORTING_SWEEPS,
};
