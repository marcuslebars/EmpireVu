/**
 * The Front Desk receptionist's tools, wired at provisioning time (general_tools on the Retell
 * LLM) so an auto-provisioned agent can actually quote, check availability, book, send the
 * deposit link, capture the lead and alert the owner — all against OUR /api/retell/functions/*
 * routes with the shared function secret header. docs/front-desk-ai.md → "## Phone answering".
 *
 * Marine companies (A1 and any company on the marine pack / with a shrink_wrap catalog item)
 * get the existing `quote_shrink_wrap` contract unchanged; every other trade gets the generic
 * price-list `quote_services`. Pure.
 */
import { RETELL_FUNCTION_SECRET_HEADER } from "./auth";

export interface ReceptionistToolsInput {
  /** Public origin of this app (APP_BASE_URL). */
  baseUrl: string;
  functionSecret: string;
  marine: boolean;
}

export const RECEPTIONIST_TOOL_PATHS = {
  quote_shrink_wrap: "/api/retell/functions/quote",
  quote_services: "/api/retell/functions/price-quote",
  check_availability: "/api/retell/functions/availability",
  book_job: "/api/retell/functions/book",
  send_deposit_link: "/api/retell/functions/deposit-link",
  capture_lead: "/api/retell/functions/capture-lead",
  alert_owner: "/api/retell/functions/urgent-alert",
} as const;

type Json = Record<string, unknown>;

function tool(
  input: ReceptionistToolsInput,
  name: keyof typeof RECEPTIONIST_TOOL_PATHS,
  description: string,
  parameters: Json,
  options: { speakDuring?: string; timeoutMs?: number; toolName?: string } = {},
): Json {
  return {
    type: "custom",
    name: options.toolName ?? name,
    description,
    url: `${input.baseUrl.replace(/\/+$/, "")}${RECEPTIONIST_TOOL_PATHS[name]}`,
    method: "POST",
    headers: { [RETELL_FUNCTION_SECRET_HEADER]: input.functionSecret },
    // Payload: args only stays OFF — the tenant comes from Retell's trusted `call` object.
    args_at_root: false,
    speak_during_execution: Boolean(options.speakDuring),
    ...(options.speakDuring ? { execution_message_description: options.speakDuring } : {}),
    speak_after_execution: true,
    timeout_ms: options.timeoutMs ?? 12_000,
    parameters,
  };
}

const str = (description: string): Json => ({ type: "string", description });
const num = (description: string): Json => ({ type: "number", description });

export function buildReceptionistTools(input: ReceptionistToolsInput): Json[] {
  const quote = input.marine
    ? tool(
        input,
        "quote_shrink_wrap",
        "Price shrink wrap (and winterization) from the company's price list and text the caller the quote. Needs name, boat length and hull type. Read back the `say` field.",
        {
          type: "object",
          properties: {
            name: str("Caller's first and last name"),
            phone: str("Only if different from the number they're calling from"),
            email: str("Optional"),
            boat_length_ft: num("Boat length in feet"),
            hull_type: { type: "string", enum: ["bowrider", "cuddy", "cruiser", "pontoon", "tritoon", "sailboat", "pwc", "other"] },
            winterization_engine: { type: "string", enum: ["outboard", "sterndrive", "inboard", "none"] },
            engine_count: num("Number of engines"),
            boat_location: str("driveway / trailer / storage lot / marina yard"),
            town: str("Town"),
            notes: str("Tower, arch, access…"),
            service: str("Optional catalog key; defaults to shrink_wrap"),
          },
          required: ["name", "boat_length_ft", "hull_type"],
        },
        { speakDuring: "Say you're pricing it now." },
      )
    : tool(
        input,
        "quote_services",
        "Price the caller's job from the company's price list ONLY and text them the quote link. Pass each service by the name the caller used, with a quantity or measurement when it's priced that way. If the result asks a question, ask the caller and call again. Never state a price that didn't come from this tool. Read back the `say` field.",
        {
          type: "object",
          properties: {
            services: {
              type: "array",
              description: "Each service the caller wants priced.",
              items: {
                type: "object",
                properties: {
                  name: str("The service, in the caller's words (e.g. 'furnace tune-up')"),
                  quantity: num("How many, for per-item services"),
                  measure: num("Size (feet, square feet, hours…) for services priced by size"),
                },
                required: ["name"],
              },
            },
            caller_name: str("Caller's first and last name"),
            phone: str("Mobile to text the quote to, only if different from caller ID"),
            email: str("Optional"),
            address: str("Job address or town"),
            notes: str("Anything else about the job"),
          },
          required: ["services", "caller_name"],
        },
        { speakDuring: "Say you're pricing it now." },
      );

  return [
    quote,
    tool(
      input,
      "check_availability",
      "Find the next open booking windows. Use after a quote when the caller wants to book.",
      {
        type: "object",
        properties: {
          preferred_date: str("YYYY-MM-DD the caller prefers, if any"),
          preferred_window: str("morning / afternoon, if they said"),
        },
      },
      { speakDuring: "Say you're checking the calendar." },
    ),
    tool(
      input,
      "book_job",
      "Book one of the open windows for a quote you created on this call. Only book a window check_availability offered.",
      {
        type: "object",
        properties: {
          quote_id: str("The quote_id from the quote tool"),
          date: str("YYYY-MM-DD"),
          window: str("The window key, e.g. morning"),
        },
        required: ["quote_id", "date", "window"],
      },
      { speakDuring: "Say you're booking it.", toolName: input.marine ? "book_wrap_date" : "book_job" },
    ),
    tool(
      input,
      "send_deposit_link",
      "Text (or email) the caller the link to approve the quote and pay the deposit that holds their booking.",
      {
        type: "object",
        properties: {
          quote_id: str("The quote_id from the quote tool"),
          phone: str("Only if different from caller ID"),
          email: str("Optional"),
        },
        required: ["quote_id"],
      },
    ),
    tool(
      input,
      "capture_lead",
      "Save the caller's details as soon as you have their name and what they need, even if they don't want a quote.",
      {
        type: "object",
        properties: {
          caller_name: str("Caller's name"),
          caller_email: str("Optional"),
          services_requested: { type: "array", items: { type: "string" }, description: "What they need" },
          summary: str("One-sentence summary of the request"),
          is_urgent: { type: "boolean", description: "True for an emergency / same-day need" },
        },
        required: ["caller_name"],
      },
    ),
    tool(
      input,
      "alert_owner",
      "Alert the owner RIGHT NOW about an emergency while the caller is on the line. Call it once.",
      {
        type: "object",
        properties: {
          what: str("What's happening"),
          address: str("Address or town"),
          caller_name: str("Caller's name"),
          callback_number: str("Callback number if different"),
        },
        required: ["what"],
      },
      { speakDuring: "Tell the caller you're alerting the team now.", timeoutMs: 8000 },
    ),
    { type: "end_call", name: "end_call", description: "End the call politely once the caller is done." },
  ];
}

/** Post-call analysis the receptionist fills (lead-adapter + voice/post-call read these names). */
export const RECEPTIONIST_ANALYSIS_FIELDS: Json[] = [
  { type: "string", name: "caller_name", description: "The caller's name." },
  { type: "string", name: "caller_email", description: "The caller's email, if given." },
  { type: "string", name: "job_description", description: "What they need, in a few words." },
  { type: "string", name: "service_address", description: "Job address or town." },
  { type: "boolean", name: "is_urgent", description: "True for an emergency or same-day need." },
  { type: "enum", name: "urgency", description: "How urgent.", choices: ["emergency", "urgent", "normal"] },
  { type: "boolean", name: "callback_requested", description: "True if they want a callback." },
  { type: "string", name: "callback_time", description: "When they want the callback, if said." },
];
