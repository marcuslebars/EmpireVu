// Preloaded (NODE_OPTIONS=--require) into Next dev and the e2e driver. Redirects fetch() calls
// for the third-party hosts the app talks to — and the fake buyer's website — to the local
// fakes server (fakes.mjs), keeping the original host in `x-e2e-host`. DNS for the fake
// website resolves to a public (non-reserved) address so the SSRF guard (safe-fetch.ts) treats
// it like any real site; the request itself still lands on the fakes server. The guard's pinned
// dispatcher is dropped on redirected calls (the fakes server is on loopback by design).
"use strict";
const dns = require("node:dns");
const { syncBuiltinESMExports } = require("node:module");

const FAKES = `http://127.0.0.1:${process.env.E2E_FAKES_PORT || "55436"}`;
const HOSTS = new Set([
  "api.twilio.com",
  "api.retellai.com",
  "api.resend.com",
  "inbound-cdn.resend.app", // Phase 5: Resend Inbound attachment download_url host
  "places.googleapis.com",
  "api.anthropic.com",
  "api.open-meteo.com",
  "customer-api.open-meteo.com",
  "dd.weather.gc.ca",
  "northshoresnow.ca",
  "www.northshoresnow.ca",
]);
const WEBSITE_HOSTS = new Set(["northshoresnow.ca", "www.northshoresnow.ca"]);
const FAKE_PUBLIC_IP = "93.184.215.14";

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
    const { dispatcher: _pinned, ...rest } = init ?? {};
    return realFetch(target, { ...rest, method, headers, body, redirect: init?.redirect ?? "follow" });
  };
  patched.__e2ePatched = true;
  globalThis.fetch = patched;
}

// Phase 4 (phase4.sh sets E2E_FAKE_STRIPE=1): the Stripe SDK talks to api.stripe.com through
// node:https (not fetch), so redirect those requests to the fakes server over plain http. The SDK
// writes its body once the socket says "secureConnect"; a plain socket only says "connect", so
// that event is re-emitted for it.
if (process.env.E2E_FAKE_STRIPE === "1") {
  const http = require("node:http");
  const https = require("node:https");
  const realHttpsRequest = https.request;
  if (!realHttpsRequest.__e2ePatched) {
    const patchedRequest = function e2eHttpsRequest(options, ...rest) {
      const host = typeof options === "object" && options && !(options instanceof URL) ? options.host || options.hostname : null;
      if (host !== "api.stripe.com") return realHttpsRequest.call(this, options, ...rest);
      const { agent: _agent, ciphers: _ciphers, port: _port, host: _host, hostname: _hostname, protocol: _protocol, ...restOpts } = options;
      const req = http.request({ ...restOpts, host: "127.0.0.1", port: Number(process.env.E2E_FAKES_PORT || "55436"), path: `/api.stripe.com${options.path || "/"}`, headers: { ...(options.headers || {}), "x-e2e-host": "api.stripe.com" } }, ...rest);
      req.on("socket", (socket) => {
        if (socket.connecting) socket.once("connect", () => socket.emit("secureConnect"));
      });
      return req;
    };
    patchedRequest.__e2ePatched = true;
    https.request = patchedRequest;
  }
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
