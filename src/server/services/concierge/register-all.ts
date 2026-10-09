/**
 * The concierge action registry, fully loaded: the built-in actions (actions.ts) plus the
 * done-for-you ones (dfy-actions.ts). Concierge routes import from HERE so every action is
 * registered before the first list / run. docs/done-for-you.md → "Concierge console".
 */
import "@/server/services/concierge/actions";
import "@/server/services/concierge/dfy-actions";
import "@/server/services/concierge/voice-actions";

export { actionRequestSchema, getConciergeAction, listConciergeActions, runConciergeAction } from "@/server/services/concierge/actions";
