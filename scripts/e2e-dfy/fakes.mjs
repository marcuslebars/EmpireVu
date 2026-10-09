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

function anthropic(req, res, path, body) {
  const request = JSON.parse(body || "{}");
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
  capture({ kind: "anthropic", purpose: "other", system: system.slice(0, 80) });
  return json(res, 200, anthropicText(request.model, "{}"));
}

// ── Resend / Retell ──────────────────────────────────────────────────────────
function resend(req, res, path, body) {
  const m = JSON.parse(body || "{}");
  const id = sid("em_");
  capture({ kind: "email", to: Array.isArray(m.to) ? m.to.join(",") : m.to, from: m.from, subject: m.subject, body: m.text ?? "", html: m.html ?? null, id });
  return json(res, 200, { id });
}

function retell(req, res, path, body) {
  capture({ kind: "retell", method: req.method, path, body: body.slice(0, 300) });
  return json(res, 200, { ok: true, llm_id: "llm_e2e", agent_id: "agent_e2e", phone_number: "+17055550177" });
}

createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    const url = req.url || "/";
    if (url.startsWith("/anthropic/")) return anthropic(req, res, url.slice("/anthropic".length), body);
    if (url === "/__health") return json(res, 200, { ok: true });
    const host = req.headers["x-e2e-host"] || url.split("/")[1];
    const path = url.slice(1 + String(host).length) || "/";
    switch (host) {
      case "api.twilio.com":
        return twilio(req, res, path, body);
      case "places.googleapis.com":
        return places(req, res, path, body);
      case "api.resend.com":
        return resend(req, res, path, body);
      case "api.retellai.com":
        return retell(req, res, path, body);
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
