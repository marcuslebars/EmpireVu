// Everdoer rebrand alias: /api/public/everdoer/setup-reminders is the same handler as /api/public/crankleads/setup-reminders
// (which stays, and counts its own use; see src/server/services/rebrand/route-alias.ts).
export { GET, POST } from "@/app/api/public/crankleads/setup-reminders/route";

// Route segment config must be declared in this file (Next reads it statically).
export const dynamic = "force-dynamic";
