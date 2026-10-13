// Everdoer rebrand alias: /api/public/everdoer/checkout/[sessionId] is the same handler as /api/public/crankleads/checkout/[sessionId]
// (which stays, and counts its own use; see src/server/services/rebrand/route-alias.ts).
export { GET } from "@/app/api/public/crankleads/checkout/[sessionId]/route";

// Route segment config must be declared in this file (Next reads it statically).
export const dynamic = "force-dynamic";
