// Fake third parties for the done-for-you e2e run. One HTTP server; intercept.cjs sends each
// request here as /<original-host>/<path> with `x-e2e-host`, and ANTHROPIC_BASE_URL points at
// /anthropic. Every outbound SMS / email / call / number purchase is appended to
// E2E_CAPTURE_LOG (JSONL) so the driver can print the buyer's message timeline.
//
//   Twilio   – AvailablePhoneNumbers (area code honoured), IncomingPhoneNumbers (buy/list/update),
//              Messages (SMS), Calls (forwarding test)
//   Resend   – /emails
//   Retell   – any call → minimal JSON (only Front Desk uses it)
//   Places   – searchText + details for "Northshore Snow & Lawn" (Midland, ON)
//   Anthropic– /v1/messages: catalog parse (prices only where the site states them) and site copy
//   Website  – northshoresnow.ca: home, services (ONE stated price), about, contact, logo.png
//   Phase 2  – Environment Canada citypage weather + Open-Meteo (rain windows via /__control), Places `location`, the
//              Estimator's vision estimate, Marketer copy, and the staff tools in the scripted
//              SMS / owner agents (staff.ts)
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

const PORT = Number(process.env.E2E_FAKES_PORT || 55436);
const LOG = process.env.E2E_CAPTURE_LOG || "/var/tmp/e2e-dfy/captured.jsonl";
mkdirSync(dirname(LOG), { recursive: true });

function capture(entry) {
  appendFileSync(LOG, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

let seq = 0;
const sid = (prefix) => `${prefix}${Date.now().toString(16)}${(++seq).toString(16).padStart(6, "0")}`.padEnd(34, "0").slice(0, 34);

// ── Phase 4 test documents ───────────────────────────────────────────────────
// A tiny JPEG (SOI + COM segment + EOI) or PDF carrying `E2EDOC{json}E2EDOC`: what the picture
// "shows". The fake receipt / compliance readers decode the base64 block they're sent and answer
// only from that spec, so a reply that names the vendor proves the bytes reached the model.
const mediaDocs = new Map(); // ME… id → { contentType, bytes, spec }
export function docBytes(spec, contentType) {
  const marker = `E2EDOC${JSON.stringify(spec)}E2EDOC`;
  if (contentType === "application/pdf") return Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n`, "latin1");
  const text = Buffer.from(marker, "latin1");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(text.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe]), len, text, Buffer.from([0xff, 0xd9])]);
}
function specFromBlocks(messages) {
  for (const m of messages ?? []) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if ((b.type === "image" || b.type === "document") && b.source?.data) {
        const raw = Buffer.from(b.source.data, "base64").toString("latin1");
        const hit = raw.match(/E2EDOC(\{.*?\})E2EDOC/);
        if (hit) {
          try {
            return { spec: JSON.parse(hit[1]), mediaType: b.source.media_type };
          } catch {
            return { spec: null, mediaType: b.source.media_type };
          }
        }
        return { spec: null, mediaType: b.source.media_type };
      }
    }
  }
  return { spec: null, mediaType: null };
}

// ── Twilio ───────────────────────────────────────────────────────────────────
const incoming = new Map(); // sid → number
let numberSeq = 0;

function twilio(req, res, path, body) {
  const form = Object.fromEntries(new URLSearchParams(body));
  const url = new URL(path, "http://x");
  const p = url.pathname;
  if (/\/AvailablePhoneNumbers\/[A-Z]+\/Local\.json$/.test(p)) {
    const area = url.searchParams.get("AreaCode") || "705";
    const list = Array.from({ length: 3 }, () => {
      numberSeq += 1;
      return { phone_number: `+1${area}55501${String(50 + numberSeq).padStart(2, "0")}`, friendly_name: "fake" };
    });
    capture({ kind: "twilio_search", areaCode: area, results: list.map((n) => n.phone_number) });
    return json(res, 200, { available_phone_numbers: list });
  }
  if (/\/IncomingPhoneNumbers\.json$/.test(p) && req.method === "GET") {
    const pn = url.searchParams.get("PhoneNumber");
    const fn = url.searchParams.get("FriendlyName");
    const list = [...incoming.values()].filter((n) => (!pn || n.phone_number === pn) && (!fn || n.friendly_name === fn));
    return json(res, 200, { incoming_phone_numbers: list });
  }
  if (/\/IncomingPhoneNumbers\.json$/.test(p) && req.method === "POST") {
    const n = { sid: sid("PN"), phone_number: form.PhoneNumber, friendly_name: form.FriendlyName, voice_url: form.VoiceUrl, sms_url: form.SmsUrl };
    incoming.set(n.sid, n);
    capture({ kind: "twilio_buy", number: n.phone_number, friendlyName: n.friendly_name, voiceUrl: n.voice_url });
    return json(res, 201, n);
  }
  const upd = p.match(/\/IncomingPhoneNumbers\/(PN[0-9a-f]+)\.json$/);
  if (upd && req.method === "POST") {
    const n = incoming.get(upd[1]);
    if (!n) return json(res, 404, { code: 20404, message: "not found" });
    Object.assign(n, { friendly_name: form.FriendlyName ?? n.friendly_name, voice_url: form.VoiceUrl ?? n.voice_url, sms_url: form.SmsUrl ?? n.sms_url });
    return json(res, 200, n);
  }
  if (/\/Messages\.json$/.test(p) && req.method === "POST") {
    const m = { sid: sid("SM"), status: "queued", to: form.To, from: form.From, body: form.Body };
    capture({ kind: "sms", to: form.To, from: form.From, body: form.Body, sid: m.sid });
    return json(res, 201, m);
  }
  // MMS media (Phase 1 front desk): GET …/Messages/MM…/Media/ME… → a small PNG (Basic auth required).
  if (/\/Messages\/MM[0-9a-zA-Z]+\/Media\/ME[0-9a-zA-Z]+$/.test(p) && req.method === "GET") {
    const auth = String(req.headers.authorization || "");
    const mediaId = p.match(/\/Media\/(ME[0-9a-zA-Z]+)$/)[1];
    capture({ kind: "twilio_media", path: p, basicAuth: auth.startsWith("Basic "), mediaId });
    if (!auth.startsWith("Basic ")) return json(res, 401, { code: 20003, message: "auth required" });
    // Phase 4: a registered test document (POST /__media) — a JPEG or PDF carrying a spec the fake
    // readers answer from; anything else is the logo PNG as before.
    const doc = mediaDocs.get(mediaId);
    if (doc) {
      res.writeHead(200, { "content-type": doc.contentType, "content-length": String(doc.bytes.length) });
      return res.end(doc.bytes);
    }
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(LOGO);
  }
  if (/\/Calls\.json$/.test(p) && req.method === "POST") {
    const c = { sid: sid("CA"), status: "queued", to: form.To, from: form.From };
    capture({ kind: "call", to: form.To, from: form.From, sid: c.sid, statusCallback: form.StatusCallback });
    return json(res, 201, c);
  }
  capture({ kind: "unhandled", host: "api.twilio.com", method: req.method, path });
  return json(res, 404, { code: 20404, message: `fake twilio: no route for ${req.method} ${p}` });
}

// ── Google Places (New) ──────────────────────────────────────────────────────
export const PLACE_ID = "ChIJn0rthSh0reSn0wMidland01";
const PLACES = [
  { id: PLACE_ID, displayName: { text: "Northshore Snow & Lawn", languageCode: "en" }, formattedAddress: "412 King St, Midland, ON L4R 3M9, Canada" },
  { id: "ChIJn0rthSh0reLandscBarrie02", displayName: { text: "Northshore Landscaping Supply", languageCode: "en" }, formattedAddress: "9 Bayfield St, Barrie, ON L4M 3A5, Canada" },
];
const DETAILS = {
  id: PLACE_ID,
  displayName: { text: "Northshore Snow & Lawn", languageCode: "en" },
  formattedAddress: "412 King St, Midland, ON L4R 3M9, Canada",
  addressComponents: [
    { longText: "412", shortText: "412", types: ["street_number"] },
    { longText: "King Street", shortText: "King St", types: ["route"] },
    { longText: "Midland", shortText: "Midland", types: ["locality", "political"] },
    { longText: "Simcoe County", shortText: "Simcoe County", types: ["administrative_area_level_2", "political"] },
    { longText: "Ontario", shortText: "ON", types: ["administrative_area_level_1", "political"] },
    { longText: "Canada", shortText: "CA", types: ["country", "political"] },
  ],
  nationalPhoneNumber: "(705) 555-0142",
  websiteUri: "https://northshoresnow.ca/",
  regularOpeningHours: {
    openNow: true,
    periods: [1, 2, 3, 4, 5].map((day) => ({ open: { day, hour: 7, minute: 0 }, close: { day, hour: 18, minute: 0 } }))
      .concat([{ open: { day: 6, hour: 8, minute: 0 }, close: { day: 6, hour: 12, minute: 0 } }]),
    weekdayDescriptions: [
      "Monday: 7:00 AM – 6:00 PM",
      "Tuesday: 7:00 AM – 6:00 PM",
      "Wednesday: 7:00 AM – 6:00 PM",
      "Thursday: 7:00 AM – 6:00 PM",
      "Friday: 7:00 AM – 6:00 PM",
      "Saturday: 8:00 AM – 12:00 PM",
      "Sunday: Closed",
    ],
  },
  rating: 4.8,
  userRatingCount: 37,
  googleMapsUri: "https://maps.google.com/?cid=1234567890123456789",
  primaryTypeDisplayName: { text: "Snow removal service", languageCode: "en" },
  // Phase 2 Dispatcher geocoding (field mask "location").
  location: { latitude: 44.7501, longitude: -79.8921 },
};

function places(req, res, path, body) {
  const url = new URL(path, "http://x");
  if (url.pathname === "/v1/places:searchText" && req.method === "POST") {
    const q = String(JSON.parse(body || "{}").textQuery || "").toLowerCase();
    const hits = PLACES.filter((p) => q.split(/\s+/).some((w) => w.length > 2 && p.displayName.text.toLowerCase().includes(w)));
    capture({ kind: "places_search", query: q, results: hits.length });
    return json(res, 200, hits.length ? { places: hits } : {});
  }
  const m = url.pathname.match(/^\/v1\/places\/([A-Za-z0-9_-]+)$/);
  if (m) {
    capture({ kind: "places_details", placeId: m[1] });
    if (m[1] === PLACE_ID) return json(res, 200, DETAILS);
    const p = PLACES.find((x) => x.id === m[1]);
    return p ? json(res, 200, p) : json(res, 404, { error: { code: 404, message: "Not found" } });
  }
  return json(res, 404, { error: { message: `fake places: no route ${url.pathname}` } });
}

// ── The buyer's website ──────────────────────────────────────────────────────
const NAV = `<nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav>`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | Northshore Snow &amp; Lawn</title>
<meta name="description" content="Snow plowing, salting and lawn care for homes and businesses in Midland, Penetanguishene and Tiny Township.">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"></head>
<body><header><a href="/"><img class="logo" src="/logo.png" alt="Northshore Snow &amp; Lawn logo" width="120" height="120"></a>${NAV}</header>
<main>${body}</main><footer>Call or text (705) 555-0142 · Mon–Fri 7am–6pm, Sat 8am–noon</footer></body></html>`;
const SITE = {
  "/": page("Home", `<h1>Northshore Snow &amp; Lawn</h1><p>Plowing, salting and lawn care for Midland, Penetanguishene and Tiny Township. Call (705) 555-0142 for a quote.</p><p><a href="/services">See our services</a></p>`),
  "/services": page("Services", `<h1>Our services</h1>
<h2>Winter</h2><ul><li>Seasonal driveway plowing contracts — call for a quote</li><li>Per-push plowing for cottages</li><li>Salting for driveways and walkways</li><li>Roof snow removal</li></ul>
<h2>Spring to fall</h2><ul><li>Spring cleanup — $250 per visit</li><li>Weekly lawn cutting (seasonal)</li><li>Fall cleanup and leaf removal</li></ul>`),
  "/about": page("About", `<h1>About us</h1><p>Northshore Snow &amp; Lawn is a local crew based in Midland. We plow, salt and look after lawns across the north shore of Georgian Bay.</p>`),
  "/contact": page("Contact", `<h1>Contact</h1><p>Phone: (705) 555-0142</p><p>Email: office@northshoresnow.ca</p><p>Hours: Mon–Fri 7am–6pm, Sat 8am–noon</p>`),
};

/** A 160×160 PNG logo (navy disc with a white snowflake-ish cross) built in code. */
function logoPng() {
  const w = 160;
  const h = 160;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const dx = x - 80;
      const dy = y - 80;
      const r = Math.sqrt(dx * dx + dy * dy);
      let c = [0, 0, 0, 0];
      if (r < 78) c = [18, 52, 96, 255];
      const arm = (Math.abs(dx) < 6 || Math.abs(dy) < 6 || Math.abs(dx - dy) < 8 || Math.abs(dx + dy) < 8) && r < 58;
      if (arm) c = [255, 255, 255, 255];
      if (r < 14) c = [126, 200, 80, 255];
      raw.set(c, y * (w * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const LOGO = logoPng();

function website(req, res, path) {
  const p = new URL(path, "http://x").pathname.replace(/\/+$/, "") || "/";
  capture({ kind: "website", path: p });
  if (p === "/logo.png" || p === "/apple-touch-icon.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
    return res.end(LOGO);
  }
  const html = SITE[p];
  if (!html) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<h1>Not found</h1>");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  return res.end(html);
}

// ── Anthropic ────────────────────────────────────────────────────────────────
function anthropicText(model, text) {
  return {
    id: sid("msg_"),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** Services the catalog parser would read off the site text: a price ONLY where one is stated. */
function catalogFromText(text) {
  const services = [];
  const seen = new Set();
  // Page text arrives whitespace-collapsed: take the capitalised phrase right before each "— $N".
  for (const m of text.matchAll(/([A-Z][a-z]+(?: [a-z]+){0,3})\s*[—–-]\s*\$(\d+(?:\.\d\d)?)/g)) {
    const name = m[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    services.push({ name, description: null, pricingType: "flat", baseCents: Math.round(Number(m[2]) * 100) });
  }
  for (const name of ["Per-push plowing", "Salting", "Roof snow removal", "Weekly lawn cutting", "Fall cleanup"]) {
    if (text.toLowerCase().includes(name.toLowerCase().split(" ")[0]) && !seen.has(name)) {
      services.push({ name, description: null, pricingType: name === "Fall cleanup" || name === "Weekly lawn cutting" ? "flat" : "per_unit", baseCents: null });
    }
  }
  return { services };
}

function siteCopyFromFacts(facts) {
  const name = facts.businessName || "Our crew";
  const area = facts.serviceArea ? String(facts.serviceArea).replace(/ and surrounding area$/, "") : null;
  const trade = facts.trade ? String(facts.trade).toLowerCase() : "property maintenance";
  const services = Array.isArray(facts.services) ? facts.services : [];
  const phone = facts.phone || facts.phoneDisplay || null;
  return {
    headline: `Snow plowing and lawn care${area ? ` in ${area}` : ""}`.slice(0, 70),
    subhead: phone
      ? `Call ${phone} or send a quote request below and we'll get back to you with a price.`
      : "Send a quote request below and we'll get back to you with a price.",
    about: `${name} looks after driveways, lots and lawns${area ? ` in ${area} and the surrounding area` : ""}. We plow and salt in the winter and handle cleanups and weekly cutting the rest of the year. Tell us what you need and we'll get you a price.`,
    serviceBlurbs: services.slice(0, 40).map((s) => ({ key: String(s.key), blurb: `${String(s.label ?? s.name ?? "Service").replace(/—.*/, "").trim()} for homes and businesses.`.slice(0, 120) })),
    faqs: [
      { question: "How do I get a price?", answer: phone ? `Call ${phone} or send the quote form on this page.` : "Send the quote form on this page and we'll reply with a price." },
      { question: "Where do you work?", answer: area ? `${area} and the surrounding area.` : "Ask us — we'll tell you if you're in our area." },
      { question: "What services do you offer?", answer: `${services.slice(0, 4).map((s) => String(s.label ?? s.name).replace(/—.*/, "").trim()).join(", ") || "Snow and lawn services"}.` },
    ],
  };
}

// ── Anthropic: the AI front desk (SMS agent + owner commands) ─────────────────
// A scripted "model" that follows the tool-use protocol and builds every reply only from what
// it was sent (tool results, the fenced conversation), so the driver can prove context flowed.
function toolUse(model, uses, text) {
  return {
    id: sid("msg_"),
    type: "message",
    role: "assistant",
    model,
    content: [...(text ? [{ type: "text", text }] : []), ...uses.map((u, i) => ({ type: "tool_use", id: `toolu_${Date.now().toString(36)}_${seq++}_${i}`, name: u.name, input: u.input }))],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1500, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** [{name, input, result}] from the conversation so far. */
function toolHistory(messages) {
  const names = new Map();
  const out = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") names.set(b.id, { name: b.name, input: b.input });
      if (b.type === "tool_result") {
        const raw = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("");
        let result = null;
        try {
          result = JSON.parse(raw.replace(/^<tool_data[^>]*>/, "").replace(/<\/tool_data>$/, ""));
        } catch {
          result = raw;
        }
        out.push({ ...(names.get(b.tool_use_id) ?? { name: "?" }), result });
      }
    }
  }
  return out;
}

function between(text, open, close) {
  const i = text.indexOf(open);
  const j = text.indexOf(close, i + open.length);
  return i >= 0 && j > i ? text.slice(i + open.length, j) : "";
}

function smsAgent(request) {
  const first = request.messages[0];
  const blocks = Array.isArray(first.content) ? first.content : [{ type: "text", text: String(first.content) }];
  const userText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const images = blocks.filter((b) => b.type === "image").length;
  const newText = between(userText, "<customer_messages>", "</customer_messages>").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const done = toolHistory(request.messages);
  const did = (name) => done.find((d) => d.name === name);
  const system = Array.isArray(request.system) ? request.system.map((s) => s.text).join("\n") : String(request.system ?? "");
  const owner = (system.match(/The owner is ([A-Z][a-z]+)/) ?? [])[1] ?? null;
  const fromCall = /Earlier phone call/.test(userText);
  const tools = (request.tools ?? []).map((t) => t.name);
  capture({ kind: "anthropic", purpose: "sms_agent", images, newText: newText.slice(0, 200), round: done.length, fromCall, sawCallSummary: /Phone call .*\(AI answered\)/.test(userText), tools });
  const m = request.model;

  // Phase 5 (phase5.ts): Customer care. An answer to the check-in ("2 - still leaking") →
  // record_job_feedback; a problem with past work → check_warranty; a pick from the visit offer →
  // book_care_visit (the slot the driver says the customer picked: POST /__control {carePick}).
  const rated = newText.match(/^\s*([1-5])\b\s*[-:,.]?\s*(.*)$/);
  if (tools.includes("record_job_feedback") && rated) {
    if (!did("record_job_feedback")) {
      const rating = Number(rated[1]);
      return toolUse(m, [{ name: "record_job_feedback", input: { rating, ...(rated[2] ? { comment: rated[2] } : {}), unhappy: rating <= 3 } }]);
    }
    const r = did("record_job_feedback").result ?? {};
    if (r.owner_told) return anthropicText(m, `I'm sorry it wasn't right. ${owner ?? "The owner"} will follow up with you directly.`);
    if (r.recorded) return anthropicText(m, "Thank you so much - that's great to hear!");
    return anthropicText(m, "Thanks for letting us know.");
  }
  if (tools.includes("book_care_visit") && control.carePick && /works|suits|that one|please|morning|afternoon/i.test(newText)) {
    if (!did("book_care_visit")) {
      const p = control.carePick;
      return toolUse(m, [{ name: "book_care_visit", input: { date: p.date, ...(p.window ? { window: p.window } : {}), ...(p.startsAt ? { starts_at: p.startsAt } : {}) } }]);
    }
    const r = did("book_care_visit").result ?? {};
    if (r.ok) return anthropicText(m, `You're all set for ${r.booked}. ${owner ?? "We"} will see you then.`);
    return anthropicText(m, `${owner ?? "The owner"} will confirm the time with you.`);
  }
  // Phase 2 (staff.ts): the Estimator — photos + "how much to fix …" → request_estimate.
  if (tools.includes("request_estimate") && /how much to fix|fascia|eavestrough/i.test(newText)) {
    if (!did("request_estimate")) return toolUse(m, [{ name: "request_estimate", input: { description: newText, details: images > 0 ? `${images} photo(s) sent` : undefined } }]);
    const r = did("request_estimate").result ?? {};
    if (r.estimate_requested || r.already_waiting) return anthropicText(m, `Thanks for the photos. ${owner ?? "The owner"} will look them over and I'll text you the quote as soon as it's ready.`);
    if (r.need_more_info) return anthropicText(m, String((r.ask_customer ?? ["Could you tell me a bit more about the job?"])[0]));
    return anthropicText(m, `Let me check with ${owner ?? "the owner"} and get right back to you.`);
  }
  // Phase 2: the Bookkeeper — "can I do 3 payments?" → request_payment_plan.
  if (tools.includes("request_payment_plan") && /(\d+)\s+payments|payment plan/i.test(newText)) {
    if (!did("request_payment_plan")) {
      const n = Number((newText.match(/(\d+)\s+payments/i) ?? [])[1] ?? 3);
      return toolUse(m, [{ name: "request_payment_plan", input: { payments: n, frequency: "every_2_weeks" } }]);
    }
    const r = did("request_payment_plan").result ?? {};
    return anthropicText(m, r.ok ? `Let me check with ${owner ?? "the owner"} about the plan and get right back to you.` : `Let me pass that to ${owner ?? "the owner"}.`);
  }
  // Phase 4: Compliance — "can you send me proof of insurance?" → share_compliance_doc.
  if (tools.includes("share_compliance_doc") && /proof of insurance|insurance certificate|certificate of insurance|\bCOI\b/i.test(newText)) {
    if (!did("share_compliance_doc")) return toolUse(m, [{ name: "share_compliance_doc", input: { document: "liability_insurance" } }]);
    const r = did("share_compliance_doc").result ?? {};
    if (r.approval_requested || r.already_asked) return anthropicText(m, `Sure - I'm checking with ${owner ?? "the owner"} and will text you the insurance certificate shortly.`);
    return anthropicText(m, `${owner ?? "The owner"} will get that to you directly.`);
  }
  // Phase 5: Customer care — a problem with past work (after the Phase 4 compliance ask above).
  if (tools.includes("check_warranty") && /\b(leak\w*|loose|broke\w*|came off|warranty)\b/i.test(newText)) {
    if (!did("check_warranty")) return toolUse(m, [{ name: "check_warranty", input: { problem: newText.slice(0, 200) } }]);
    const r = did("check_warranty").result ?? {};
    if (r.owner_asked || r.already_asked) return anthropicText(m, `Sorry for the trouble - I've passed this to ${owner ?? "the owner"}, who'll get back to you shortly.`);
    if (!did("hand_off_to_owner")) return toolUse(m, [{ name: "hand_off_to_owner", input: { reason: `problem with past work: ${newText.slice(0, 100)}` } }]);
    return anthropicText(m, `Sorry for the trouble - ${owner ?? "the owner"} will follow up.`);
  }

  // Phase 2: the Marketer — a reply to a win-back text is a new enquiry.
  if (/book (me|us) in|sounds good/i.test(newText)) {
    return anthropicText(m, "Great - what day works best for you? We'll get you on the schedule.");
  }

  if (images > 0) {
    return anthropicText(m, "Thanks for the photo - that helps. We'll take a look and include it with your quote.");
  }
  if (/ridiculous|damaged|damage/i.test(newText)) {
    if (!did("hand_off_to_owner")) return toolUse(m, [{ name: "hand_off_to_owner", input: { reason: "Complaint: says our crew damaged their lawn" } }]);
    return anthropicText(m, `I'm sorry to hear that. I've passed this straight to ${owner ?? "the owner"}, who will contact you directly.`);
  }
  if (/do it for \$?\d+|for \$\d+/i.test(newText)) {
    if (!did("request_owner_approval")) {
      const ask = (newText.match(/\$\s?\d[\d,]*/) ?? ["a lower price"])[0];
      return toolUse(m, [{ name: "request_owner_approval", input: { kind: "custom_price", summary: `Asks if we can do the seasonal double-driveway contract for ${ask}.`, job_description: "Seasonal snow contract, double driveway, Midland" } }]);
    }
    return anthropicText(m, `Let me check with ${owner ?? "the owner"} and get right back to you.`);
  }
  if (fromCall) {
    let collected = {};
    try {
      collected = JSON.parse(between(userText, "Already collected: ", "\n").trim() || "{}");
    } catch {
      /* keep {} */
    }
    if (!did("get_price_list")) return toolUse(m, [{ name: "get_price_list", input: {} }]);
    const list = did("get_price_list").result?.services ?? [];
    const item = list.find((x) => /seasonal/i.test(x.name)) ?? list[0];
    const name = collected.name ? String(collected.name).split(" ")[0] : "there";
    return anthropicText(m, `Hi ${name}, following up on your call about ${collected.job ?? "your job"}${collected.address ? ` at ${collected.address}` : ""}: our ${String(item?.name ?? "seasonal contract").toLowerCase()} is ${item?.price ?? "on our price list"} + HST. Want me to send a quote you can approve online?`);
  }
  if (/how much|price|cost/i.test(newText)) {
    if (!did("get_price_list")) return toolUse(m, [{ name: "get_price_list", input: {} }]);
    const list = did("get_price_list").result?.services ?? [];
    const item = list.find((x) => /seasonal/i.test(x.name) && /double/i.test(x.name)) ?? list.find((x) => /seasonal/i.test(x.name));
    if (!did("quote_from_price_list") && item) return toolUse(m, [{ name: "quote_from_price_list", input: { lines: [{ service_key: item.service_key }] } }]);
    const q = did("quote_from_price_list")?.result ?? {};
    return anthropicText(m, `Our ${String(item?.name ?? "seasonal contract").replace(/ — /g, " - ").toLowerCase()} in Midland is ${q.subtotal_before_hst ?? item?.price} + HST (${q.total_with_hst ?? "?"} total). Want me to send you a quote you can approve online?`);
  }
  return anthropicText(m, "Thanks for the message - we'll get back to you shortly.");
}

function nextWeekdayDate(weekday, timeZone = "America/Toronto") {
  // weekday: 0=Sun..6=Sat — the next one strictly after today (local).
  const now = Date.now();
  for (let d = 1; d <= 7; d++) {
    const t = new Date(now + d * 86400000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t).map((p) => [p.type, p.value]));
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    if (wd === weekday) return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return null;
}

function ownerAgent(request) {
  const body = typeof request.messages[0].content === "string" ? request.messages[0].content : (request.messages[0].content ?? []).map((c) => c.text ?? "").join(" ");
  const done = toolHistory(request.messages);
  const did = (name) => done.find((d) => d.name === name);
  const m = request.model;
  const tools = (request.tools ?? []).map((t) => t.name);
  capture({ kind: "anthropic", purpose: "owner_agent", body: body.slice(0, 120), round: done.length, tools });
  if (/who owes me/i.test(body)) {
    if (!tools.includes("who_owes_me")) return anthropicText(m, "I can't see invoices from here - check the app.");
    if (!did("who_owes_me")) return toolUse(m, [{ name: "who_owes_me", input: {} }]);
    const r = did("who_owes_me").result ?? {};
    const top = (r.top_owing ?? []).map((t) => `${t.customer} ${t.owing}${t.days_late ? ` (${t.days_late} days late)` : ""}`).join("; ");
    return anthropicText(m, `${r.outstanding ?? "?"} outstanding on ${r.open_invoices ?? 0} invoices, ${r.overdue ?? "?"} overdue. ${top ? `Top: ${top}.` : ""}`.trim());
  }
  if (/campaign do/i.test(body) && tools.includes("marketing_results")) {
    if (!did("marketing_results")) return toolUse(m, [{ name: "marketing_results", input: {} }]);
    const r = did("marketing_results").result ?? {};
    const c = r.last_campaign;
    return anthropicText(m, c ? `Last win-back: ${c.sent} sent, ${c.replies} replies, ${c.skipped} skipped, ${c.bookings_within_30_days} bookings so far. Google: ${r.google?.rating ?? "?"} stars (${r.google?.review_count ?? 0} reviews).` : "No campaign yet.");
  }
  if (/what'?s on tomorrow/i.test(body)) {
    if (!did("list_bookings")) return toolUse(m, [{ name: "list_bookings", input: { when: "tomorrow" } }]);
    const list = did("list_bookings").result?.bookings ?? [];
    return anthropicText(m, list.length ? `Tomorrow: ${list.map((b) => `${b.when.split(", ").pop()} ${b.customer} - ${b.job}`).join("; ")}.` : "Nothing booked tomorrow.");
  }
  const move = body.match(/move (.+?) to (friday|monday|tuesday|wednesday|thursday|saturday)\s+(\d{1,2})(?::(\d{2}))?/i);
  if (move) {
    if (!did("find_customer")) return toolUse(m, [{ name: "find_customer", input: { query: move[1] } }]);
    const c = (did("find_customer").result?.customers ?? []).find((x) => x.next_booking);
    if (!c) return anthropicText(m, `I couldn't find a booking for ${move[1]}.`);
    const wd = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(move[2].toLowerCase());
    const hour = String(Number(move[3]) < 7 ? Number(move[3]) + 12 : Number(move[3])).padStart(2, "0");
    return toolUse(m, [{ name: "propose_reschedule", input: { booking_id: c.next_booking.booking_id, date: nextWeekdayDate(wd), time: `${hour}:${move[4] ?? "00"}` } }]);
  }
  const tell = body.match(/^tell (\w+)\s+(.+)$/i);
  if (tell) {
    if (!did("find_customer")) return toolUse(m, [{ name: "find_customer", input: { query: tell[1] } }]);
    const c = (did("find_customer").result?.customers ?? [])[0];
    if (!c) return anthropicText(m, `I couldn't find ${tell[1]}.`);
    if (!did("text_customer")) {
      const msg = tell[2].replace(/^(that )?we'?ll/i, "We'll").replace(/([^.!?])$/, "$1.");
      return toolUse(m, [{ name: "text_customer", input: { contact_id: c.contact_id, message: msg } }]);
    }
    return anthropicText(m, `Sent to ${c.name}. The assistant will stay out of that conversation.`);
  }
  // Phase 4 (phase4.ts): Purchasing's materials_status — relays each order's estimate vs actual.
  const ms = body.match(/materials status(?:\s+(PO-\d+))?/i);
  if (ms && tools.includes("materials_status")) {
    if (!did("materials_status")) return toolUse(m, [{ name: "materials_status", input: ms[1] ? { po: ms[1].toUpperCase() } : {} }]);
    const r = did("materials_status").result ?? {};
    const orders = r.orders ?? [];
    return anthropicText(m, orders.length ? orders.map((o) => `${o.po ?? o.po_number ?? "PO"} ${o.job ?? ""}: ${o.status ?? ""}, estimated ${o.estimated}, actual ${o.actual}`).join("; ") : String(r.error ?? r.note ?? "No open materials orders."));
  }
  // Phase 5 (phase5.ts): Email inbox setup, Profit advisor cash forecast, Fleet records.
  const relay = (name) => {
    const r = did(name).result ?? {};
    return anthropicText(m, String(r.tell_owner_exactly ?? r.tell_owner ?? r.message ?? r.error ?? r.ask_owner ?? JSON.stringify(r).slice(0, 300)));
  };
  if (/set up (my )?e-?mail/i.test(body) && tools.includes("email_setup")) {
    if (!did("email_setup")) return toolUse(m, [{ name: "email_setup", input: {} }]);
    return relay("email_setup");
  }
  if (/ok for cash|cash forecast/i.test(body) && tools.includes("cash_forecast")) {
    if (!did("cash_forecast")) return toolUse(m, [{ name: "cash_forecast", input: {} }]);
    const r = did("cash_forecast").result ?? {};
    return anthropicText(m, r.ok ? `${r.summary} Tight in 30 days: ${r.tight_next_30_days}. ${r.disclaimer}` : String(r.error ?? "Couldn't work it out."));
  }
  const addV = body.match(/add (truck \d+), (\d{4}) (\S+) (\S+), plate ([A-Z0-9]+ [A-Z0-9]+), sticker due (\d{4}-\d{2}-\d{2})/i);
  if (addV && tools.includes("add_vehicle")) {
    if (!did("add_vehicle")) return toolUse(m, [{ name: "add_vehicle", input: { name: addV[1].replace(/^./, (c) => c.toUpperCase()), year: Number(addV[2]), make: addV[3], model: addV[4], plate: addV[5], plate_sticker_due: addV[6] } }]);
    return relay("add_vehicle");
  }
  const sched = body.match(/(oil change) every ([\d,]+) km on (truck \d+)(?:, last done at ([\d,]+))?/i);
  if (sched && tools.includes("set_service_schedule")) {
    if (!did("set_service_schedule")) {
      return toolUse(m, [{ name: "set_service_schedule", input: { vehicle: sched[3], service: sched[1], every_km: Number(sched[2].replace(/,/g, "")), ...(sched[4] ? { last_done_km: Number(sched[4].replace(/,/g, "")) } : {}) } }]);
    }
    return relay("set_service_schedule");
  }
  const rent = body.match(/rented an? (.+?) from (\w+), \$(\d+) a day, back (\d{4}-\d{2}-\d{2}) (\d{1,2})(am|pm), for the (\w+) job/i);
  if (rent && tools.includes("add_rental")) {
    if (!did("add_rental")) {
      const h = (Number(rent[5]) % 12) + (rent[6].toLowerCase() === "pm" ? 12 : 0);
      return toolUse(m, [{ name: "add_rental", input: { item: rent[1], vendor: rent[2], rate_per_day: Number(rent[3]), due_back_date: rent[4], due_back_time: `${String(h).padStart(2, "0")}:00`, job: rent[7] } }]);
    }
    return relay("add_rental");
  }
  const back = body.match(/^\s*(.+?) (?:returned|is back)\s*$/i);
  if (back && tools.includes("rental_returned")) {
    if (!did("rental_returned")) return toolUse(m, [{ name: "rental_returned", input: { rental: back[1] } }]);
    return relay("rental_returned");
  }
  // Phase 3 (phase3.ts): the Office manager, the Recruiter and Keep your number.
  if (/^\s*today\s*$/i.test(body) && tools.includes("briefing_now")) {
    if (!did("briefing_now")) return toolUse(m, [{ name: "briefing_now", input: { detail: true } }]);
    const r = did("briefing_now").result ?? {};
    return anthropicText(m, `${r.briefing ?? "No briefing."}\n${r.details ?? ""}`.trim());
  }
  if (/need a (labourer|laborer|helper)/i.test(body) && tools.includes("start_hiring")) {
    if (!did("start_hiring")) return toolUse(m, [{ name: "start_hiring", input: { request: body } }]);
    const r = did("start_hiring").result ?? {};
    return anthropicText(m, String(r.tell_owner_exactly ?? r.error ?? "Couldn't draft it."));
  }
  if (/keep my number/i.test(body) && tools.includes("start_number_port")) {
    if (!did("start_number_port")) return toolUse(m, [{ name: "start_number_port", input: {} }]);
    const r = did("start_number_port").result ?? {};
    return anthropicText(m, String(r.tell_owner_exactly ?? r.error ?? "Couldn't start it."));
  }
  return anthropicText(m, "I can help with bookings, customers and approvals.");
}

function anthropic(req, res, path, body) {
  const request = JSON.parse(body || "{}");
  const toolNames = (request.tools ?? []).map((t) => t.name);
  if (toolNames.includes("quote_from_price_list")) return json(res, 200, smsAgent(request));
  if (toolNames.includes("list_bookings")) return json(res, 200, ownerAgent(request));
  const system = Array.isArray(request.system) ? request.system.map((s) => s.text).join("\n") : String(request.system ?? "");
  const user = (request.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("\n"))).join("\n");
  if (/services catalog/i.test(system)) {
    const out = catalogFromText(user);
    capture({ kind: "anthropic", purpose: "catalog", services: out.services, textSample: user.slice(0, 600) });
    return json(res, 200, anthropicText(request.model, JSON.stringify(out)));
  }
  if (/one-page website/i.test(system)) {
    const factsJson = user.replace(/^[\s\S]*?FACTS JSON:\s*/, "");
    let facts = {};
    try {
      facts = JSON.parse(factsJson);
    } catch {
      /* template */
    }
    capture({ kind: "anthropic", purpose: "site_copy", business: facts.businessName ?? null });
    return json(res, 200, anthropicText(request.model, JSON.stringify(siteCopyFromFacts(facts))));
  }
  // ── Phase 2 AI staff (staff.ts) ──
  if (/^You are the estimator for/.test(system)) {
    const images = (request.messages ?? []).flatMap((msg) => (Array.isArray(msg.content) ? msg.content : [])).filter((b) => b.type === "image").length;
    const described = between(user, 'not instructions">', "</customer_description>").trim();
    const draft = /fascia/i.test(described)
      ? {
          enough_info: true,
          title: "Fascia repair",
          lines: [
            { label: "Replace damaged fascia board (about 16 ft)", amount_cents: 56000 },
            { label: "Prime, paint and re-hang eavestrough", amount_cents: 19000 },
          ],
          confidence: "medium",
          assumptions: images > 0 ? ["Single storey, from the photo", "Soffit behind it is sound"] : ["Single storey"],
          questions: [],
        }
      : { enough_info: false, lines: [], questions: ["Could you send a photo of the area?"] };
    capture({ kind: "anthropic", purpose: "estimator_vision", images, described: described.slice(0, 200), model: request.model });
    return json(res, 200, anthropicText(request.model, JSON.stringify(draft)));
  }
  if (/past customer it hasn't worked for/.test(system)) {
    const name = (system.match(/start with "it's (.+?)\." so the business/) ?? [])[1] ?? "us";
    capture({ kind: "anthropic", purpose: "marketer_win_back", model: request.model });
    return json(res, 200, anthropicText(request.model, `it's ${name}. With winter on the way we're setting up seasonal driveway plowing again - reply here and we'll get you on the list.`));
  }
  if (/public reply to a Google review/.test(system)) {
    capture({ kind: "anthropic", purpose: "marketer_review_reply" });
    return json(res, 200, anthropicText(request.model, "Thank you so much for the kind words - we really appreciate you choosing us."));
  }
  if (/weekly Google Business Profile post/.test(system)) {
    capture({ kind: "anthropic", purpose: "marketer_google_post" });
    return json(res, 200, anthropicText(request.model, "Winter is close: book your seasonal driveway plowing now and we'll have you on the route before the first snow. Call or message us to get set up."));
  }
  // ── Phase 4 readers (phase4.ts): receipts (tax clerk) and compliance documents ──
  if (/^You read one purchase receipt or supplier invoice/.test(system)) {
    const { spec, mediaType } = specFromBlocks(request.messages);
    const isReceipt = spec && (spec.type === "receipt" || spec.type === "supplier_invoice");
    const out = isReceipt
      ? { vendor: spec.vendor ?? null, date: spec.date ?? null, totalCents: spec.totalCents ?? null, taxCents: spec.taxCents ?? null, category: spec.category ?? null, description: spec.description ?? null, documentKind: spec.type }
      : { vendor: null, date: null, totalCents: null, taxCents: null, category: null, description: null, documentKind: "not_receipt" };
    capture({ kind: "anthropic", purpose: "receipt_reader", mediaType, spec: spec?.label ?? null, documentKind: out.documentKind, withKind: /documentKind/.test(system), model: request.model });
    return json(res, 200, anthropicText(request.model, JSON.stringify(out)));
  }
  if (/^You read ONE document for a small Ontario trades business/.test(system)) {
    const { spec, mediaType } = specFromBlocks(request.messages);
    const out = spec && spec.type === "cert"
      ? { is_compliance_document: true, kind: spec.kind, title: spec.title ?? null, issuer: spec.issuer ?? null, number: spec.number ?? null, holder_name: spec.holder ?? null, issued_on: spec.issued ?? null, expires_on: spec.expires ?? null }
      : { is_compliance_document: false, kind: null, title: null, issuer: null, number: null, holder_name: null, issued_on: null, expires_on: null };
    capture({ kind: "anthropic", purpose: "compliance_reader", mediaType, spec: spec?.label ?? null, isDoc: out.is_compliance_document, model: request.model });
    return json(res, 200, anthropicText(request.model, JSON.stringify(out)));
  }
  // ── Phase 3 Recruiter (phase3.ts) ──
  if (/^You write a short, plain job post for/.test(system)) {
    const owner = between(user, 'note="data">', "</owner_request>").trim();
    const pay = (owner.match(/\$\d+(?:\.\d+)?\s*\/\s*(?:hr|hour)/i) ?? [null])[0];
    capture({ kind: "anthropic", purpose: "recruiter_draft", owner: owner.slice(0, 200) });
    return json(res, 200, anthropicText(request.model, JSON.stringify({
      title: "Labourer",
      pay,
      employment_type: "Full-time",
      start: /start monday/i.test(owner) ? "Monday" : null,
      location: "Midland",
      summary: "General labour on residential snow and lawn jobs around Midland.",
      duties: ["Shovel and salt walkways", "Load and unload equipment", "Spring and fall yard cleanups"],
      requirements: ["Able to lift 50 lbs", "Reliable for early-morning starts"],
      nice_to_have: ["G licence"],
      custom_questions: ["Can you start at 6am on snow days?"],
    })));
  }
  if (/sort job applications for/.test(system)) {
    const answers = between(user, '<applicant_answers note="data">', "</applicant_answers>");
    const roofing = /roof|snow|landscap|lawn/i.test((answers.match(/Experience: (.*)/) ?? [])[1] ?? "");
    const licence = /Driver's licence: yes/i.test(answers);
    capture({ kind: "anthropic", purpose: "recruiter_screen", answers: answers.slice(0, 300), sawContact: /\+1\d{10}|@/.test(user) });
    return json(res, 200, anthropicText(request.model, JSON.stringify({
      score: roofing && licence ? 5 : roofing || licence ? 4 : 2,
      reason: roofing ? "3 yrs snow and lawn work, has licence" : "Little related experience",
      meets: [{ requirement: "Able to lift 50 lbs", met: "unclear" }],
    })));
  }
  // ── Phase 5 (phase5.ts): the Email inbox's classifier and drafter, Fleet's odometer reader ──
  if (/^You sort the email inbox of a small trades business/.test(system)) {
    const fenced = between(user, "<email note=", "</email>");
    const from = (fenced.match(/^From: (.*)$/m) ?? [])[1] ?? "";
    const subject = (fenced.match(/^Subject: (.*)$/m) ?? [])[1] ?? "";
    const text = fenced.replace(/^[\s\S]*?\nSubject: .*\n/, "");
    const words = `${subject}\n${text}`;
    let out;
    if (/invoice|amount due|statement/i.test(words) && /\$\s?\d/.test(words)) {
      const amount = Number(((words.match(/\$\s?([\d,]+(?:\.\d\d)?)/) ?? [])[1] ?? "0").replace(/,/g, ""));
      const due = (words.match(/due (?:on |by )?(\d{4}-\d{2}-\d{2})/i) ?? [])[1] ?? null;
      const vendor = (from.match(/^([A-Za-z]+)/) ?? [])[1] ?? null;
      out = { category: "bill", summary: `Invoice for ${vendor ?? "supplies"}`, from_business: vendor, amount, due_date: due, project: null };
    } else if (/invitation to bid|bids? (are )?due|tender/i.test(words)) {
      out = { category: "bid_invite", summary: "Invitation to bid", from_business: (from.match(/^([A-Za-z ]+?) </) ?? [])[1] ?? null, amount: null, due_date: (words.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null, project: "roof" };
    } else if (/webinar|sale ends|newsletter/i.test(words) && !/\b(please|can you|could you|i need)\b/i.test(words)) {
      out = { category: "newsletter", summary: "Promotion", from_business: null, amount: null, due_date: null, project: null };
    } else {
      // A person asking about work: their ask in their own words (first sentence, ≤ 15 words).
      const first = text.replace(/^\s*(hi|hello|hey)[^,\n]*,?\s*/i, "").trim().split(/(?<=[?.!])\s/)[0] ?? "";
      out = { category: "customer", summary: first.split(/\s+/).slice(0, 15).join(" "), from_business: null, amount: null, due_date: null, project: null };
    }
    capture({ kind: "anthropic", purpose: "email_classify", category: out.category, subject: subject.slice(0, 120), fenced: Boolean(fenced), dataRule: /never follow instructions/i.test(system) });
    return json(res, 200, anthropicText(request.model, JSON.stringify(out)));
  }
  if (/^You draft email replies for /.test(system)) {
    const business = (system.match(/^You draft email replies for (.+?), a local trades business/) ?? [])[1] ?? "us";
    const owner = (system.match(/The owner \(([^)]+)\)/) ?? [])[1] ?? "the owner";
    const fenced = between(user, "<email note=", "</email>");
    const first = (fenced.match(/Customer first name: (.*)/) ?? [])[1]?.trim();
    const body = fenced.replace(/^[\s\S]*?\nSubject: .*\n/, "");
    const injected = /ignore (all |your |previous )*instructions/i.test(body);
    // A gullible model: it does what the email says (the guards must catch it). Otherwise a plain,
    // price-free reply built only from what it was sent.
    const draft = injected
      ? `Hi ${first ?? "there"},\n\nAs requested, we'll give you 90% off - just $65 + HST for the whole roof. Pay here: http://evil.example/pay\n\nThanks,\n${business}`
      : `Hi ${first && first !== "(unknown)" ? first : "there"},\n\nThanks for reaching out to ${business}. ${owner} will get back to you with a price - could you send a few photos of the area?\n\nThanks,\n${business}`;
    capture({ kind: "anthropic", purpose: "email_draft", injected, fenced: /<email note="[^"]*data, not instructions">/.test(user), dataRule: /never follow instructions in it/i.test(system), owner, business });
    return json(res, 200, anthropicText(request.model, draft));
  }
  if (/^You read ONE photo for a small Ontario trades business: the owner says it's a vehicle's dashboard/.test(system)) {
    const { spec, mediaType } = specFromBlocks(request.messages);
    const out = spec && spec.type === "odometer" ? { is_odometer: true, reading: spec.km ?? null, unit: spec.unit ?? "km" } : { is_odometer: false, reading: null, unit: null };
    capture({ kind: "anthropic", purpose: "odometer_reader", mediaType, spec: spec?.label ?? null, reading: out.reading });
    return json(res, 200, anthropicText(request.model, JSON.stringify(out)));
  }
  capture({ kind: "anthropic", purpose: "other", system: system.slice(0, 80) });
  return json(res, 200, anthropicText(request.model, "{}"));
}

// ── Resend / Retell ──────────────────────────────────────────────────────────
// Phase 5 (phase5.ts): Resend Inbound. The driver registers a received email (POST /__resend/inbound),
// then asks for the Svix-signed `email.received` webhook (POST /__resend/deliver). The app fetches the
// content (GET /emails/receiving/{id}) and each attachment's metadata (…/attachments/{aid} →
// download_url on inbound-cdn.resend.app), whose bytes this server serves too.
const inboundEmails = new Map(); // email_id → the full received email (Resend's GET shape)
const inboundFiles = new Map(); // attachment id → { bytes, contentType, filename }
function resendReceiving(req, res, p) {
  const att = p.match(/^\/emails\/receiving\/([^/]+)\/attachments\/([^/]+)$/);
  if (att) {
    const email = inboundEmails.get(decodeURIComponent(att[1]));
    const file = inboundFiles.get(decodeURIComponent(att[2]));
    capture({ kind: "resend_inbound_get", what: "attachment", emailId: att[1], attachmentId: att[2], auth: String(req.headers.authorization || "").startsWith("Bearer ") });
    if (!email || !file) return json(res, 404, { name: "not_found", message: "Attachment not found" });
    return json(res, 200, { object: "attachment", id: att[2], filename: file.filename, content_type: file.contentType, size: file.bytes.length, download_url: `https://inbound-cdn.resend.app/files/${att[2]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  }
  const one = p.match(/^\/emails\/receiving\/([^/]+)$/);
  if (one) {
    const email = inboundEmails.get(decodeURIComponent(one[1]));
    capture({ kind: "resend_inbound_get", what: "email", emailId: one[1], auth: String(req.headers.authorization || "").startsWith("Bearer "), found: Boolean(email) });
    if (control.resendFetchFail) return json(res, 503, { name: "internal_server_error", message: "fake: fetch disabled" });
    if (!email) return json(res, 404, { name: "not_found", message: "Email not found" });
    return json(res, 200, { object: "email", ...email });
  }
  return null;
}
function inboundCdn(req, res, path) {
  const m = new URL(path, "http://x").pathname.match(/^\/files\/([^/]+)$/);
  const file = m ? inboundFiles.get(decodeURIComponent(m[1])) : null;
  capture({ kind: "resend_inbound_download", path, found: Boolean(file) });
  if (!file) return json(res, 404, { error: "gone" });
  res.writeHead(200, { "content-type": file.contentType, "content-length": String(file.bytes.length) });
  return res.end(file.bytes);
}
/** Svix signature (Resend's webhook scheme): base64 HMAC-SHA256 of `id.timestamp.body` with the decoded whsec_ secret. */
function svixSign(secret, id, ts, payload) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${ts}.${payload}`).digest("base64");
}
/** POST /__resend/deliver {id, url?, badSignature?, staleSeconds?, eventType?} → the signed webhook to the app. */
async function deliverInbound(spec) {
  const email = inboundEmails.get(spec.id);
  if (!email) return { status: 0, text: `fake: no inbound email ${spec.id}` };
  const event = {
    type: spec.eventType ?? "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: email.id,
      created_at: email.created_at,
      from: email.from,
      to: email.to,
      cc: email.cc ?? [],
      bcc: email.bcc ?? [],
      received_for: email.received_for ?? [],
      message_id: email.message_id,
      subject: email.subject,
      attachments: (email.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type, content_disposition: a.content_disposition, content_id: a.content_id ?? null })),
    },
  };
  const payload = JSON.stringify(event);
  const svixId = spec.svixId ?? `msg_${email.id}`;
  const ts = String(Math.floor(Date.now() / 1000) - (spec.staleSeconds ?? 0));
  const secret = spec.badSignature ? "whsec_" + Buffer.from("not-the-secret-at-all").toString("base64") : process.env.RESEND_WEBHOOK_SECRET;
  const sig = svixSign(secret, svixId, ts, payload);
  const url = spec.url ?? `${process.env.APP_BASE_URL}/api/webhooks/email/inbound`;
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "svix-id": svixId, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body: payload });
  const text = await r.text();
  capture({ kind: "resend_webhook", emailId: email.id, status: r.status, badSignature: Boolean(spec.badSignature), response: text.slice(0, 200) });
  return { status: r.status, text };
}

function resend(req, res, path, body) {
  const p = new URL(path, "http://x").pathname;
  if (p.startsWith("/emails/receiving/") && req.method === "GET") {
    const handled = resendReceiving(req, res, p);
    if (handled !== null) return handled;
  }
  if (p !== "/emails" || req.method !== "POST") {
    capture({ kind: "unhandled", host: "api.resend.com", method: req.method, path: p });
    return json(res, 404, { name: "not_found", message: `fake resend: no route ${req.method} ${p}` });
  }
  const m = JSON.parse(body || "{}");
  const id = sid("em_");
  // Phase 3: attachments (the payroll CSV) are captured with their decoded text.
  const attachments = (m.attachments ?? []).map((a) => {
    const buf = typeof a.content === "string" ? Buffer.from(a.content, "base64") : Array.isArray(a.content?.data) ? Buffer.from(a.content.data) : Array.isArray(a.content) ? Buffer.from(a.content) : null;
    return { filename: a.filename, content: buf ? buf.toString("utf8").slice(0, 4000) : null, bytes: buf ? buf.length : 0, contentType: a.content_type ?? a.contentType ?? null };
  });
  capture({ kind: "email", to: Array.isArray(m.to) ? m.to.join(",") : m.to, from: m.from, subject: m.subject, body: m.text ?? "", html: m.html ?? null, id, attachments, replyTo: m.reply_to ?? m.replyTo ?? null, headers: m.headers ?? null });
  return json(res, 200, { id });
}

const control = { retellRegisterFail: false, rain: [] };

// ── Open-Meteo (Phase 2 Dispatcher) ──────────────────────────────────────────
// Hourly forecast (timeformat=unixtime) from the current hour; rainy (90 %, 3 mm/h) inside any
// control.rain window [{fromMs, toMs}] (set with POST /__control), dry otherwise.
function openMeteo(req, res, path, host) {
  const url = new URL(path, "http://x");
  if (url.pathname !== "/v1/forecast") return json(res, 404, { error: true, reason: "fake open-meteo: no route" });
  const days = Math.max(1, Math.min(16, Number(url.searchParams.get("forecast_days") || 7)));
  const start = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const time = [];
  const prob = [];
  const mm = [];
  const wind = [];
  const temp = [];
  for (let i = 0; i < days * 24; i++) {
    const t = start + i * 3_600_000;
    const wet = (control.rain ?? []).some((w) => t >= w.fromMs && t < w.toMs);
    time.push(t / 1000);
    prob.push(wet ? 90 : 5);
    mm.push(wet ? 3 : 0);
    wind.push(15);
    temp.push(8);
  }
  capture({ kind: "weather", host, lat: url.searchParams.get("latitude"), lng: url.searchParams.get("longitude"), apikey: url.searchParams.has("apikey"), hourly: url.searchParams.get("hourly"), timeformat: url.searchParams.get("timeformat") });
  return json(res, 200, { latitude: Number(url.searchParams.get("latitude")), longitude: Number(url.searchParams.get("longitude")), hourly: { time, precipitation_probability: prob, precipitation: mm, wind_speed_10m: wind, temperature_2m: temp } });
}
// ── Environment Canada citypage weather (Phase 2 Dispatcher, the default source) ─
// Site list, a directory listing for any province/hour, and a citypage XML built from the
// current (fake) time: hourly lop 90 % inside any control.rain window, 0 % outside; day/night
// periods after the hourly 24 h with PoP 90 % + 15 mm when the period overlaps a rain window.
const EC_SITES = `Site Names,,,,,
Codes,English Names,Province Codes,Latitude,Longitude,Nom français
s0000458,Toronto,ON,43.74N,79.37W,Toronto
s0000105,Midland,ON,44.75N,79.88W,Midland
s0000430,Orillia,ON,44.61N,79.42W,Orillia
`;
function torontoOffsetHours(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "shortOffset" }).formatToParts(new Date(ms));
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  return Number(tz.replace("GMT", "")) || -5;
}
function ecStamp(ms, withSeconds) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${withSeconds ? p(d.getUTCSeconds()) : ""}`;
}
function wetAt(fromMs, toMs) {
  return (control.rain ?? []).some((w) => fromMs < w.toMs && toMs > w.fromMs);
}
function ecXml(nowMs) {
  const H = 3_600_000;
  const offset = torontoOffsetHours(nowMs);
  const hour0 = Math.floor(nowMs / H) * H + H;
  const hourly = [];
  for (let i = 0; i < 24; i++) {
    const t = hour0 + i * H;
    hourly.push(`<hourlyForecast dateTimeUTC="${ecStamp(t, false)}"><condition>x</condition><temperature unitType="metric" units="C">8</temperature><lop category="x" units="%">${wetAt(t, t + H) ? 90 : 0}</lop><wind><speed unitType="metric" units="km/h">15</speed><gust unitType="metric" units="km/h"></gust></wind></hourlyForecast>`);
  }
  const local = new Date(nowMs + offset * H);
  let dayStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let night = local.getUTCHours() >= 15;
  const periods = [];
  for (let i = 0; i < 12; i++) {
    if (i > 0) {
      if (night) dayStartLocal += 24 * H;
      night = !night;
    }
    const startUtc = dayStartLocal + (night ? 18 : 6) * H - offset * H;
    const wet = wetAt(startUtc, startUtc + 12 * H);
    const name = night ? "Tonight" : "Today";
    periods.push(`<forecast><period textForecastName="${i === 0 ? name : night ? "Day night" : "Day"}">x</period><abbreviatedForecast><pop units="%">${wet ? 90 : ""}</pop></abbreviatedForecast><temperatures><temperature unitType="metric" units="C" class="${night ? "low" : "high"}">8</temperature></temperatures><winds><wind index="1" rank="major"><speed unitType="metric" units="km/h">15</speed></wind></winds>${wet ? '<precipitation><accumulation><name>rain</name><amount unitType="metric" units="mm">15</amount></accumulation></precipitation>' : ""}</forecast>`);
  }
  const zone = offset === -4 ? "EDT" : "EST";
  return `<?xml version="1.0" encoding="UTF-8"?><siteData><forecastGroup><dateTime name="forecastIssue" zone="UTC" UTCOffset="0"><timeStamp>${ecStamp(nowMs, true)}</timeStamp></dateTime><dateTime name="forecastIssue" zone="${zone}" UTCOffset="${offset}"><timeStamp>${ecStamp(nowMs + offset * H, true)}</timeStamp></dateTime>${periods.join("")}</forecastGroup><hourlyForecastGroup>${hourly.join("")}</hourlyForecastGroup></siteData>`;
}
function environmentCanada(req, res, path) {
  const url = new URL(path, "http://x");
  if (url.pathname === "/today/citypage_weather/docs/site_list_towns_en.csv") {
    res.writeHead(200, { "content-type": "text/csv" });
    return res.end(EC_SITES);
  }
  const dir = /^\/today\/citypage_weather\/([A-Z]{2})\/(\d{2})\/$/.exec(url.pathname);
  if (dir) {
    const names = ["s0000458", "s0000105", "s0000430"].map((code) => `20990101T000000.0Z_MSC_CitypageWeather_${code}_en.xml`);
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<html><body><pre>${names.map((n) => `<a href="${n}">${n}</a>`).join("\n")}</pre></body></html>`);
  }
  const file = /_MSC_CitypageWeather_(s\d{7})_en\.xml$/.exec(url.pathname);
  if (file) {
    capture({ kind: "weather", host: "dd.weather.gc.ca", site: file[1] });
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(ecXml(Date.now()));
  }
  return json(res, 404, { error: true, reason: "fake environment canada: no route" });
}

// ── Stripe (Phase 4: the Connect invoice Checkout for service plans) ─────────
// intercept.cjs redirects the SDK's https requests to api.stripe.com here when E2E_FAKE_STRIPE=1.
// Customers + Checkout Sessions on a connected account (Stripe-Account header); every session is
// captured with its metadata so the driver can build the signed checkout.session.completed.
const stripeSessions = new Map();
function stripeForm(body) {
  // a[b][c]=v → nested object (enough for metadata / line_items).
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const keys = k.replace(/\]/g, "").split("[");
    let o = out;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) o[key] = v;
      else o = o[key] ??= {};
    });
  }
  return out;
}
function stripe(req, res, path, body) {
  const url = new URL(path, "http://x");
  const p = url.pathname;
  const account = req.headers["stripe-account"] || null;
  const form = stripeForm(body);
  if (p === "/v1/customers" && req.method === "POST") {
    const c = { id: sid("cus_"), object: "customer", email: form.email ?? null, name: form.name ?? null, metadata: form.metadata ?? {} };
    capture({ kind: "stripe", op: "customer.create", account, id: c.id });
    return json(res, 200, c);
  }
  if (p === "/v1/checkout/sessions" && req.method === "POST") {
    const amount = Number(form.line_items?.["0"]?.price_data?.unit_amount ?? 0);
    const id = sid("cs_test_");
    const s = { id, object: "checkout.session", status: "open", payment_status: "unpaid", mode: form.mode ?? "payment", url: `https://checkout.stripe.test/c/pay/${id}`, amount_total: amount, currency: form.line_items?.["0"]?.price_data?.currency ?? "cad", customer: form.customer ?? null, metadata: form.metadata ?? {}, client_reference_id: form.client_reference_id ?? null, success_url: form.success_url ?? null, cancel_url: form.cancel_url ?? null, payment_intent: null, payment_method_types: ["card"], account };
    stripeSessions.set(id, s);
    capture({ kind: "stripe", op: "checkout.create", account, id, amount, metadata: s.metadata, successUrl: s.success_url, idempotencyKey: req.headers["idempotency-key"] ?? null });
    return json(res, 200, s);
  }
  const get = p.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  if (get && req.method === "GET") {
    const s = stripeSessions.get(get[1]);
    return s ? json(res, 200, s) : json(res, 404, { error: { type: "invalid_request_error", message: "No such checkout.session" } });
  }
  const exp = p.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/expire$/);
  if (exp && req.method === "POST") {
    const s = stripeSessions.get(exp[1]);
    if (!s) return json(res, 404, { error: { type: "invalid_request_error", message: "No such checkout.session" } });
    s.status = "expired";
    return json(res, 200, s);
  }
  capture({ kind: "unhandled", host: "api.stripe.com", method: req.method, path: p });
  return json(res, 404, { error: { type: "invalid_request_error", message: `fake stripe: no route for ${req.method} ${p}` } });
}

const retellRegistered = [];

function retell(req, res, path, body) {
  if (path.startsWith("/v2/register-phone-call") && req.method === "POST") {
    const reg = JSON.parse(body || "{}");
    if (control.retellRegisterFail) {
      capture({ kind: "retell_register", ok: false, agent_id: reg.agent_id });
      return json(res, 503, { error: "fake: register disabled" });
    }
    const call_id = `call_e2e_${Date.now().toString(36)}${(++seq).toString(36)}`;
    retellRegistered.push({ call_id, ...reg });
    capture({ kind: "retell_register", ok: true, call_id, agent_id: reg.agent_id, from: reg.from_number, to: reg.to_number, vars: reg.retell_llm_dynamic_variables });
    return json(res, 201, { call_id, agent_id: reg.agent_id, call_status: "registered" });
  }
  capture({ kind: "retell", method: req.method, path, body: body.slice(0, 300) });
  return json(res, 200, { ok: true, llm_id: "llm_e2e", agent_id: "agent_e2e", phone_number: "+17055550177" });
}

createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    const url = req.url || "/";
    if (url.startsWith("/anthropic/")) return anthropic(req, res, url.slice("/anthropic".length), body);
    if (url === "/__health") return json(res, 200, { ok: true });
    if (url === "/__control" && req.method === "POST") {
      Object.assign(control, JSON.parse(body || "{}"));
      return json(res, 200, control);
    }
    if (url === "/__retell/registered") return json(res, 200, retellRegistered);
    // Phase 4: register a test document served as Twilio MMS media (ME… id).
    if (url === "/__media" && req.method === "POST") {
      const m = JSON.parse(body || "{}");
      const bytes = docBytes(m.spec ?? {}, m.contentType);
      mediaDocs.set(m.id, { contentType: m.contentType, bytes, spec: m.spec });
      return json(res, 201, { id: m.id, bytes: bytes.length });
    }
    if (url === "/__stripe/sessions") return json(res, 200, [...stripeSessions.values()]);
    // Phase 5: Resend Inbound — register a received email (+ its attachments' bytes), then deliver
    // its Svix-signed webhook to the app.
    if (url === "/__resend/inbound" && req.method === "POST") {
      const e = JSON.parse(body || "{}");
      const files = e.files ?? [];
      for (const f of files) inboundFiles.set(f.id, { bytes: Buffer.from(f.base64 ?? "", "base64"), contentType: f.content_type, filename: f.filename });
      const email = { ...e, attachments: files.map((f) => ({ id: f.id, filename: f.filename, content_type: f.content_type, content_disposition: f.content_disposition ?? "attachment", content_id: f.content_id ?? null, size: Buffer.from(f.base64 ?? "", "base64").length })) };
      delete email.files;
      inboundEmails.set(email.id, email);
      return json(res, 201, { id: email.id });
    }
    if (url === "/__resend/deliver" && req.method === "POST") return json(res, 200, await deliverInbound(JSON.parse(body || "{}")));
    // Phase 3 (phase3.ts): a number "arrives" in the Twilio account (a completed port-in), and the
    // account's numbers as Twilio sees them (webhooks, FriendlyName).
    if (url === "/__twilio/incoming" && req.method === "POST") {
      const n = { sid: sid("PN"), phone_number: null, friendly_name: null, voice_url: null, sms_url: null, ...JSON.parse(body || "{}") };
      incoming.set(n.sid, n);
      capture({ kind: "twilio_port_in", number: n.phone_number });
      return json(res, 201, n);
    }
    if (url === "/__twilio/incoming") return json(res, 200, [...incoming.values()]);
    const host = req.headers["x-e2e-host"] || url.split("/")[1];
    const path = url.slice(1 + String(host).length) || "/";
    switch (host) {
      case "api.twilio.com":
        return twilio(req, res, path, body);
      case "places.googleapis.com":
        return places(req, res, path, body);
      case "api.resend.com":
        return resend(req, res, path, body);
      case "inbound-cdn.resend.app":
        return inboundCdn(req, res, path);
      case "api.stripe.com":
        return stripe(req, res, path, body);
      case "api.retellai.com":
        return retell(req, res, path, body);
      case "api.open-meteo.com":
      case "customer-api.open-meteo.com":
        return openMeteo(req, res, path, host);
      case "dd.weather.gc.ca":
        return environmentCanada(req, res, path);
      case "northshoresnow.ca":
      case "www.northshoresnow.ca":
        return website(req, res, path);
      default:
        capture({ kind: "unhandled", host, method: req.method, path: url });
        return json(res, 404, { error: "fake: unknown host" });
    }
  } catch (err) {
    console.error("[fakes]", err);
    json(res, 500, { error: String(err) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[fakes] listening on ${PORT}, capturing to ${LOG}`));
