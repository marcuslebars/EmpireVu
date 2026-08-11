/**
 * Dev-only: simulate a signed Retell `call_analyzed` webhook and prove the whole
 * transform end-to-end WITHOUT a database:
 *   sign (exactly as Retell does) → verify the signature → read the analysis fields →
 *   build the canonical lead envelope → validate it against the intake schema.
 *
 * Run:  npx tsx scripts/dev/retell-simulate.ts
 *
 * The DB-write leg (retell_calls + raw_leads) is covered by the intake's own tests and
 * runs on the gated deploy; this script proves the signature + transform contract.
 */
import { createHmac } from "node:crypto";

import { parseLeadEnvelope } from "@/server/services/lead-intake/envelope";
import { buildPhoneLeadEnvelope, readRetellCallFields } from "@/server/services/retell/lead-adapter";
import { verifyRetellSignature } from "@/server/services/retell/signature";

const API_KEY = process.env.RETELL_API_KEY || "key_dev_simulated";
const SOURCE_SITE = process.env.RETELL_SOURCE_SITE || "a1marinestorage";
const LEAD_SOURCE = process.env.RETELL_LEAD_SOURCE || "retell_voice_agent";

const payload = {
  event: "call_analyzed",
  call: {
    call_id: "call_dev_sim0001",
    agent_id: "agent_dev",
    direction: "inbound",
    from_number: "+17055550188",
    to_number: "+17055551000",
    transcript: "Agent: A1 Marine Storage, how can I help?\nUser: I need winterization and storage.",
    transcript_object: [{ role: "agent", content: "A1 Marine Storage, how can I help?" }],
    call_analysis: {
      call_summary:
        "Caller wants winterization + shrink wrap, then outdoor storage before the first freeze.",
      user_sentiment: "Positive",
      call_successful: true,
      in_voicemail: false,
      custom_analysis_data: {
        caller_name: "Paul Genereux",
        caller_email: "paul@example.com",
        boat_make_model: "2017 Sea Ray SPX 210",
        boat_length_ft: "24 feet",
        boat_type: "bowrider",
        engine_type: "outboard",
        engine_count: "twin",
        boat_location: "Midland",
        on_trailer: "yes",
        services_requested: ["Winterization", "Shrink Wrapping", "Outdoor Storage"],
        is_urgent: "yes",
      },
    },
  },
};

const rawBody = JSON.stringify(payload);
const ts = 1_754_000_000_000; // fixed clock for a reproducible signature
const digest = createHmac("sha256", API_KEY)
  .update(rawBody + String(ts), "utf8")
  .digest("hex");
const header = `v=${ts},d=${digest}`;

const sigOk = verifyRetellSignature(rawBody, header, API_KEY, 5 * 60 * 1000, ts);
console.log("1) X-Retell-Signature verified:", sigOk);
if (!sigOk) process.exit(1);

const fields = readRetellCallFields(JSON.parse(rawBody));
const envelope = buildPhoneLeadEnvelope(fields, SOURCE_SITE, LEAD_SOURCE);
const parsed = parseLeadEnvelope(envelope);

console.log("2) canonical phone-lead envelope:");
console.log(JSON.stringify(envelope, null, 2));
console.log("3) intake schema valid:", parsed.valid, parsed.reason ? `(reason: ${parsed.reason})` : "");
console.log("   urgent:", fields.urgent, "| contact:", JSON.stringify(envelope.contact));

process.exit(parsed.valid ? 0 : 1);
