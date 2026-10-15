// Old path kept for the Everdoer rebrand: /api/public/crankleads/checkout/[sessionId]/resend is the same handler as /api/public/everdoer/checkout/[sessionId]/resend
// (counted as legacy use by the handler; see src/server/services/rebrand/route-alias.ts).
export { POST } from "@/app/api/public/everdoer/checkout/[sessionId]/resend/route";

// Route segment config must be declared in this file (Next reads it statically).
export const dynamic = "force-dynamic";
