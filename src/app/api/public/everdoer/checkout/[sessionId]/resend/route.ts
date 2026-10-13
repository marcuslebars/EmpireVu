// Everdoer rebrand alias: /api/public/everdoer/checkout/[sessionId]/resend is the same handler as /api/public/crankleads/checkout/[sessionId]/resend
// (which stays, and counts its own use; see src/server/services/rebrand/route-alias.ts).
export { POST } from "@/app/api/public/crankleads/checkout/[sessionId]/resend/route";

// Route segment config must be declared in this file (Next reads it statically).
export const dynamic = "force-dynamic";
