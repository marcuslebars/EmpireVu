#!/usr/bin/env node
/**
 * Sign a lead envelope with an intake key for spoke testing (Task 7).
 *
 * The intake route requires an HMAC body signature keyed by the intake key. This prints
 * the x-empirevu-signature header and a ready-to-run curl, and can POST it with --send.
 *
 * Usage:
 *   node scripts/dev/sign-intake.mjs --key evk_xxx [--file envelope.json] [--url URL] [--send]
 *
 *   --key   the intake key (or set EMPIREVU_INTAKE_KEY)
 *   --file  path to a JSON envelope (defaults to a built-in sample)
 *   --url   intake endpoint (default https://app.empirevu.com/api/intake)
 *   --send  actually POST it and print the response
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const key = arg("key", process.env.EMPIREVU_INTAKE_KEY);
if (!key) {
  console.error(
    "Usage: node scripts/dev/sign-intake.mjs --key <intake key> [--file envelope.json] [--url URL] [--send]",
  );
  process.exit(1);
}

const url = arg("url", "https://app.empirevu.com/api/intake");
const file = arg("file", null);

const sample = {
  schemaVersion: 1,
  source: "website",
  sourceSite: "yourbrand",
  formType: "contact",
  receivedAt: new Date().toISOString(),
  contact: { name: "Test Lead", email: "test@example.com", phone: "+17055550123" },
  message: "Signed sample lead from sign-intake.mjs",
};

// Sign the EXACT bytes that will be sent.
const body = file ? readFileSync(file, "utf8") : JSON.stringify(sample);
const signature = `sha256=${createHmac("sha256", key).update(body, "utf8").digest("hex")}`;

console.log("URL:      ", url);
console.log("Signature:", signature);
console.log("");
console.log(`curl -sS -X POST ${JSON.stringify(url)} \\`);
console.log('  -H "content-type: application/json" \\');
console.log(`  -H "x-empirevu-key: ${key}" \\`);
console.log(`  -H "x-empirevu-signature: ${signature}" \\`);
console.log(`  -d ${JSON.stringify(body)}`);

if (has("send")) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-empirevu-key": key,
      "x-empirevu-signature": signature,
    },
    body,
  });
  console.log("");
  console.log("→", res.status, res.statusText);
  console.log(await res.text());
}
