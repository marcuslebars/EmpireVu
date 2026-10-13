/**
 * Everdoer rebrand PR 1 (compatibility layer) end to end on the e2e stack (rebrand.sh). Real Next
 * (middleware in its real runtime) + real local Postgres/PostgREST, requests sent straight to Next
 * with explicit Host headers so we can play every old and new host:
 *
 *   1. Legacy-host 301 (switched on for this run): pages on app.empirevu.com / app.crankleads.com
 *      301 to app.everdoer with path + query kept; /api, /embed, /f, /oauth/callback,
 *      /update-password, ?code= pages, assets, POST, api.empirevu.com and a tenant host do NOT.
 *   2. Headers (D6): intake (x-everdoer-signature / x-empirevu-signature), Retell tools
 *      (x-everdoer-retell-secret / x-empirevu-retell-secret), Telnyx (…-telnyx-secret): new and
 *      old both pass, wrong secrets fail under either name.
 *   3. Twilio voice: a signature over https://app.everdoer.com/… and over the old
 *      https://app.empirevu.com/… both pass; one over a stranger host is 403.
 *   4. Route alias: /api/public/everdoer/setup-reminders answers exactly like the old path.
 *   5. legacy_usage (after the in-memory batch flushes): old header / host / route / signature
 *      rows are there; nothing for the new names; no secret or query string in any row.
 */
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};
const NEXT_PORT = Number(env("E2E_NEXT_PORT"));
const TARGET = env("EVERDOER_APP_BASE_URL");
const RETELL_SECRET = env("RETELL_FUNCTION_SECRET");
const TELNYX_SECRET = env("TELNYX_WEBHOOK_SECRET");
const INTAKE_SECRET = env("LEAD_INTAKE_SECRET");
const TWILIO_TOKEN = env("TWILIO_AUTH_TOKEN");

interface Res {
  status: number;
  location: string | null;
  cacheControl: string | null;
  body: string;
}

function send(method: string, host: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: NEXT_PORT, method, path, headers: { host, ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: (res.headers.location as string) ?? null,
            cacheControl: (res.headers["cache-control"] as string) ?? null,
            body: data,
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout ${method} ${host}${path}`)));
    if (body) req.write(body);
    req.end();
  });
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function psql(sql: string): string {
  return execFileSync(
    "psql",
    ["-X", "-qtA", "-h", env("E2E_PGSOCK"), "-p", env("E2E_PGPORT"), "-U", "postgres", "-d", env("E2E_DB", "empirevu_e2e"), "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

function twilioSignature(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", TWILIO_TOKEN).update(data, "utf8").digest("base64");
}

async function main(): Promise<number> {
  const targetHost = new URL(TARGET).host;

  // Warm the routes (Next dev compiles on first hit).
  await send("GET", "localhost", "/api/health").catch(() => undefined);

  // ── 1. legacy-host 301 ──────────────────────────────────────────────────────────────
  for (const old of ["app.empirevu.com", "app.crankleads.com"]) {
    const r = await send("GET", old, "/settings/billing?tab=plan&x=1");
    check(`${old} page → 301 same path + query`, r.status === 301 && r.location === `${TARGET}/settings/billing?tab=plan&x=1`, `${r.status} ${r.location}`);
    check(`${old} 301 is not cacheable (instant rollback)`, r.cacheControl === "no-store", `${r.cacheControl}`);
    const head = await send("HEAD", old, "/q/abc123");
    check(`${old} HEAD /q/<token> → 301`, head.status === 301 && head.location === `${TARGET}/q/abc123`, `${head.status} ${head.location}`);
  }
  const passthrough: Array<[string, string, string]> = [
    ["GET", "app.empirevu.com", "/api/health"],
    ["GET", "app.empirevu.com", "/embed/v1.js"],
    ["GET", "app.empirevu.com", "/f/evpk_nope"],
    ["GET", "app.empirevu.com", "/oauth/callback?code=abc"],
    ["GET", "app.crankleads.com", "/update-password"],
    ["GET", "app.empirevu.com", "/?code=abc"],
    ["GET", "app.empirevu.com", "/?token_hash=abc&type=signup"],
    ["GET", "app.empirevu.com", "/favicon.svg"],
    ["GET", "app.empirevu.com", "/.well-known/apple-app-site-association"],
    ["GET", "app.empirevu.com", "/embed"],
    ["POST", "app.empirevu.com", "/settings"],
    ["GET", "api.empirevu.com", "/settings"],
    ["GET", "quotes.a1marinecare.ca", "/settings"],
    ["GET", targetHost, "/settings"],
  ];
  for (const [m, h, p] of passthrough) {
    const r = await send(m, h, p);
    check(`${m} ${h}${p} is not redirected`, r.status !== 301 && r.status !== 308, `${r.status}`);
  }

  // ── 2. headers ──────────────────────────────────────────────────────────────────────
  const lead = JSON.stringify({
    schemaVersion: 1,
    source: "website",
    sourceSite: "rebrand-e2e",
    formType: "contact",
    receivedAt: new Date().toISOString(),
    contact: { name: "Rebrand Check", email: "rebrand@example.com", phone: "+17055550199" },
    message: "PR 1 header check",
  });
  const sig = `sha256=${createHmac("sha256", INTAKE_SECRET).update(lead, "utf8").digest("hex")}`;
  const json = { "content-type": "application/json" };
  const intakeNew = await send("POST", "api.everdoer.com", "/api/intake", { ...json, "x-everdoer-signature": sig }, lead);
  check("intake: x-everdoer-signature accepted", intakeNew.status !== 401 && intakeNew.status !== 503, `${intakeNew.status} ${intakeNew.body.slice(0, 80)}`);
  const intakeOld = await send("POST", "api.empirevu.com", "/api/intake", { ...json, "x-empirevu-signature": sig }, lead);
  check("intake: x-empirevu-signature still accepted", intakeOld.status !== 401 && intakeOld.status !== 503, `${intakeOld.status}`);
  check("intake: same answer under either name", intakeOld.status === intakeNew.status, `${intakeOld.status} vs ${intakeNew.status}`);
  for (const name of ["x-everdoer-signature", "x-empirevu-signature"]) {
    const bad = await send("POST", "api.empirevu.com", "/api/intake", { ...json, [name]: "sha256=00" }, lead);
    check(`intake: a bad ${name} is 401`, bad.status === 401, `${bad.status}`);
  }

  const retellBody = JSON.stringify({ args: {}, call: {} });
  const retellNew = await send("POST", "app.everdoer.com", "/api/retell/functions/availability", { ...json, "x-everdoer-retell-secret": RETELL_SECRET }, retellBody);
  const retellOld = await send("POST", "app.empirevu.com", "/api/retell/functions/availability", { ...json, "x-empirevu-retell-secret": RETELL_SECRET }, retellBody);
  const retellBad = await send("POST", "app.empirevu.com", "/api/retell/functions/availability", { ...json, "x-empirevu-retell-secret": "wrong" }, retellBody);
  const retellNone = await send("POST", "app.empirevu.com", "/api/retell/functions/availability", json, retellBody);
  check("retell tools: new header passes auth", retellNew.status !== 401 && retellNew.status !== 403, `${retellNew.status}`);
  check("retell tools: old header passes auth", retellOld.status !== 401 && retellOld.status !== 403, `${retellOld.status}`);
  check("retell tools: wrong / missing secret rejected", [401, 403].includes(retellBad.status) && [401, 403].includes(retellNone.status), `${retellBad.status} ${retellNone.status}`);

  const telnyxBody = JSON.stringify({ data: { payload: {} } });
  const telNew = await send("POST", "app.everdoer.com", "/api/telnyx/dynamic-variables", { ...json, "x-everdoer-telnyx-secret": TELNYX_SECRET }, telnyxBody);
  const telOld = await send("POST", "app.empirevu.com", "/api/telnyx/dynamic-variables", { ...json, "x-empirevu-telnyx-secret": TELNYX_SECRET }, telnyxBody);
  const telBad = await send("POST", "app.empirevu.com", "/api/telnyx/dynamic-variables", { ...json, "x-everdoer-telnyx-secret": "wrong" }, telnyxBody);
  check("telnyx: new header passes auth", telNew.status !== 401 && telNew.status !== 403, `${telNew.status}`);
  check("telnyx: old header passes auth", telOld.status !== 401 && telOld.status !== 403, `${telOld.status}`);
  check("telnyx: wrong secret rejected", [401, 403].includes(telBad.status), `${telBad.status}`);

  // ── 3. Twilio voice signature candidates ────────────────────────────────────────────
  const params = { CallSid: "CA" + "e".repeat(32), From: "+17055550100", To: "+17055550999", AccountSid: env("TWILIO_ACCOUNT_SID") };
  const form = new URLSearchParams(params).toString();
  const formHdr = { "content-type": "application/x-www-form-urlencoded" };
  for (const [label, base, host, expectOk] of [
    ["new host", "https://app.everdoer.com", "app.everdoer.com", true],
    ["old host", "https://app.empirevu.com", "app.empirevu.com", true],
    ["old API host", "https://api.empirevu.com", "api.empirevu.com", true],
    ["stranger host", "https://evil.example", "app.empirevu.com", false],
  ] as const) {
    const signature = twilioSignature(`${base}/api/twilio/voice/inbound`, params);
    const r = await send("POST", host, "/api/twilio/voice/inbound", { ...formHdr, "x-twilio-signature": signature }, form);
    check(`twilio voice: signature over the ${label}`, expectOk ? r.status !== 403 : r.status === 403, `${r.status}`);
  }

  // ── 4. route alias ──────────────────────────────────────────────────────────────────
  const stopOld = await send("GET", "app.empirevu.com", "/api/public/crankleads/setup-reminders?token=not-a-real-token");
  const stopNew = await send("GET", "app.everdoer.com", "/api/public/everdoer/setup-reminders?token=not-a-real-token");
  // A bad token is the handler's own answer on both paths (a JSON/HTML body from the route,
  // not Next's "route not found" page).
  const nextNotFound = (r: Res) => r.body.includes("This page could not be found");
  check(
    "setup-reminders alias answers exactly like the old path",
    stopOld.status === stopNew.status && stopOld.body === stopNew.body && !nextNotFound(stopNew),
    `${stopOld.status} vs ${stopNew.status}`,
  );

  // ── 5. legacy_usage ─────────────────────────────────────────────────────────────────
  // The counts are batched in memory (15 s) in each runtime (Edge middleware + Node routes).
  console.log("waiting 20 s for the usage batch to flush…");
  await new Promise((r) => setTimeout(r, 20_000));
  // Next dev reloads module contexts as routes compile, which clears the Edge sandbox's timers;
  // the helper then flushes on the next use. One more old-host hit plays that (and production's
  // steady traffic) and must flush everything pending.
  await send("GET", "app.empirevu.com", "/api/health");
  await new Promise((r) => setTimeout(r, 3_000));
  const rows = psql("select kind || '|' || key || '|' || count || '|' || coalesce(sample, '') from public.legacy_usage order by 1")
    .split("\n")
    .filter(Boolean);
  console.log(rows.map((r) => `   ${r}`).join("\n"));
  const has = (kind: string, key: string) => rows.some((r) => r.startsWith(`${kind}|${key}|`));
  check("counted: header x-empirevu-signature", has("header", "x-empirevu-signature"));
  check("counted: header x-empirevu-retell-secret", has("header", "x-empirevu-retell-secret"));
  check("counted: header x-empirevu-telnyx-secret", has("header", "x-empirevu-telnyx-secret"));
  check("counted: host app.empirevu.com (pages)", has("host", "app.empirevu.com"));
  check("counted: host app.crankleads.com (pages)", has("host", "app.crankleads.com"));
  check("counted: host app.empirevu.com/api", has("host", "app.empirevu.com/api"));
  check("counted: host api.empirevu.com", has("host", "api.empirevu.com"));
  check("counted: twilio_signature on an old host", has("twilio_signature", "app.empirevu.com") && has("twilio_signature", "api.empirevu.com"));
  check("counted: route /api/public/crankleads/setup-reminders", has("route", "/api/public/crankleads/setup-reminders"));
  check("not counted: any new name", !rows.some((r) => /everdoer/i.test(r.split("|")[1] ?? "")));
  const leaked = rows.filter((r) => r.includes(RETELL_SECRET) || r.includes(TELNYX_SECRET) || r.includes("sha256=") || r.includes("?") || r.includes("not-a-real-token"));
  check("no secret, signature, token or query string stored", leaked.length === 0, leaked.join("; "));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("rebrand e2e FAILED:", err);
    process.exit(1);
  });
