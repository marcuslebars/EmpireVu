// Old path kept for the Everdoer rebrand: /api/public/crankleads/setup-reminders is the same handler as /api/public/everdoer/setup-reminders
// (counted as legacy use by the handler; see src/server/services/rebrand/route-alias.ts).
export { GET, POST } from "@/app/api/public/everdoer/setup-reminders/route";

// Route segment config must be declared in this file (Next reads it statically).
export const dynamic = "force-dynamic";
