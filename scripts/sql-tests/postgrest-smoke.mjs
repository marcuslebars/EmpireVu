#!/usr/bin/env node
// HTTP smoke test for 20261006170000_lock_privileged_columns.sql through a REAL PostgREST,
// i.e. exactly the requests supabase-js sends from a browser console. Run AFTER
// scripts/sql-tests/run.sh (it reuses that database's fixture users and orgs) against a
// LOCAL PostgREST pointed at that throwaway database — never a real project.
//
//   POSTGREST_URL=http://127.0.0.1:3999 JWT_SECRET=<the jwt-secret in its config> \
//     node scripts/sql-tests/postgrest-smoke.mjs
//
// See scripts/sql-tests/README.md for the PostgREST config.
import { createHmac } from "node:crypto";

const BASE = process.env.POSTGREST_URL ?? "http://127.0.0.1:3999";
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error("Set JWT_SECRET to the local PostgREST jwt-secret.");
  process.exit(2);
}

const ORG_A = "00000000-0000-0000-0000-00000000aaaa";
const ADMIN_A = "00000000-0000-0000-0000-0000000000a2";
const MEMBER_A = "00000000-0000-0000-0000-0000000000a3";
const QUOTE_A = "00000000-0000-0000-0000-00000000f001";

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(sub, role = "authenticated") {
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({ sub, role, exp: Math.floor(Date.now() / 1000) + 600 });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

let failures = 0;
async function expectStatus(label, want, req) {
  const { status, text } = await req;
  const ok = Array.isArray(want) ? want.includes(status) : status === want;
  console.log(`${ok ? "ok  " : "FAIL"} ${status} ${label}${ok ? "" : `  →  ${text.slice(0, 200)}`}`);
  if (!ok) failures += 1;
  return text;
}

const admin = jwt(ADMIN_A);
const member = jwt(MEMBER_A);

// The reported exploit, verbatim: supabase.from('organizations').update({ plan: 'internal' }).eq('id', myOrg)
await expectStatus("admin PATCH organizations {plan:'internal'} → refused", [401, 403],
  call("PATCH", `/organizations?id=eq.${ORG_A}`, admin, { plan: "internal" }));
await expectStatus("admin PATCH organizations {subscription_status:'active', trial_ends_at} → refused", [401, 403],
  call("PATCH", `/organizations?id=eq.${ORG_A}`, admin, { subscription_status: "active", trial_ends_at: "2099-01-01T00:00:00Z" }));
await expectStatus("admin POST organizations {plan:'internal'} → refused", [401, 403],
  call("POST", "/organizations", admin, { name: "Free", slug: "free-http", plan: "internal", created_by: ADMIN_A }));
await expectStatus("admin PATCH organizations {name} → allowed", 200,
  call("PATCH", `/organizations?id=eq.${ORG_A}`, admin, { name: "Org A via HTTP" }));
await expectStatus("admin PATCH own membership {role:'owner'} → refused", [401, 403],
  call("PATCH", `/organization_memberships?organization_id=eq.${ORG_A}&profile_id=eq.${ADMIN_A}`, admin, { role: "owner" }));
await expectStatus("admin RPC record_billing_event (forged Stripe event) → refused", [401, 403, 404],
  call("POST", "/rpc/record_billing_event", admin, { p_stripe_event_id: "evt_http", p_type: "checkout.session.completed", p_payload: {} }));
await expectStatus("member PATCH quotes {status:'approved'} → refused", [401, 403],
  call("PATCH", `/quotes?id=eq.${QUOTE_A}`, member, { status: "approved", approved_at: "2026-10-07T00:00:00Z" }));
await expectStatus("anon PATCH organizations {plan} → refused", [401, 403],
  call("PATCH", `/organizations?id=eq.${ORG_A}`, null, { plan: "internal" }));

const after = await call("GET", `/organizations?id=eq.${ORG_A}&select=plan,subscription_status`, admin);
console.log(`     org A billing state after the attempts: ${after.text}`);
if (after.text.includes('"internal"')) failures += 1;

if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("postgrest-smoke: ALL CHECKS PASSED");
