// Preloaded (NODE_OPTIONS=--require) into Next dev and the e2e driver. Redirects fetch() calls
// for the third-party hosts the app talks to — and the fake buyer's website — to the local
// fakes server (fakes.mjs), keeping the original host in `x-e2e-host`. DNS for the fake
// website resolves to a public TEST-NET address so the SSRF guard (safe-fetch.ts) treats it
// like any real site; the request itself still lands on the fakes server.
"use strict";
const dns = require("node:dns");
const { syncBuiltinESMExports } = require("node:module");

const FAKES = `http://127.0.0.1:${process.env.E2E_FAKES_PORT || "55436"}`;
const HOSTS = new Set([
  "api.twilio.com",
  "api.retellai.com",
  "api.resend.com",
  "places.googleapis.com",
  "api.anthropic.com",
  "northshoresnow.ca",
  "www.northshoresnow.ca",
]);
const WEBSITE_HOSTS = new Set(["northshoresnow.ca", "www.northshoresnow.ca"]);
const FAKE_PUBLIC_IP = "203.0.113.42";

const realFetch = globalThis.fetch;
if (realFetch && !realFetch.__e2ePatched) {
  const patched = async function e2eFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return realFetch(input, init);
    }
    if (!HOSTS.has(url.hostname)) return realFetch(input, init);
    const target = `${FAKES}/${url.hostname}${url.pathname}${url.search}`;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-e2e-host", url.hostname);
    headers.set("x-e2e-proto", url.protocol.replace(":", ""));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body = init?.body;
    if (body === undefined && input instanceof Request && method !== "GET" && method !== "HEAD") body = await input.arrayBuffer();
    return realFetch(target, { ...init, method, headers, body, redirect: init?.redirect ?? "follow" });
  };
  patched.__e2ePatched = true;
  globalThis.fetch = patched;
}

function fakeLookup(original) {
  return function lookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (WEBSITE_HOSTS.has(String(hostname).toLowerCase())) {
      const all = typeof options === "object" && options && options.all;
      return process.nextTick(() => (all ? callback(null, [{ address: FAKE_PUBLIC_IP, family: 4 }]) : callback(null, FAKE_PUBLIC_IP, 4)));
    }
    return original.call(this, hostname, options, callback);
  };
}

const originalLookup = dns.lookup;
dns.lookup = fakeLookup(originalLookup);
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function lookup(hostname, options = {}) {
  if (WEBSITE_HOSTS.has(String(hostname).toLowerCase())) {
    const all = typeof options === "object" && options && options.all;
    return all ? [{ address: FAKE_PUBLIC_IP, family: 4 }] : { address: FAKE_PUBLIC_IP, family: 4 };
  }
  return originalPromiseLookup.call(this, hostname, options);
};
try {
  require("node:dns/promises").lookup = dns.promises.lookup;
} catch {
  /* older node */
}
syncBuiltinESMExports();
