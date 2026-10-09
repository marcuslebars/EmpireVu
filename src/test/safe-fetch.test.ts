import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SSRF_BLOCKED_CODE,
  assertFetchableUrl,
  createGuardedDispatcher,
  guardedLookup,
  isBlockedHost,
  isPrivateAddress,
  parseIPv6,
  safeFetchText,
} from "@/server/net/safe-fetch";

describe("isPrivateAddress — IPv4", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.7",
    "203.0.113.42",
    "224.0.0.1",
    "255.255.255.255",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "198.20.0.1", "93.184.215.14", "100.128.0.1"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("isPrivateAddress — IPv6", () => {
  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // what new URL() turns [::ffff:127.0.0.1] into
    "[::ffff:7f00:1]",
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "0:0:0:0:0:ffff:10.0.0.1",
    "::127.0.0.1", // IPv4-compatible
    "::0a00:0001",
    "64:ff9b::7f00:1", // NAT64
    "64:ff9b::808:808", // NAT64 to a public v4 is still refused (reaches anything)
    "2002:7f00:1::", // 6to4
    "2001:0:4136:e378::1", // Teredo
    "2001:db8::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it("parses compressed and dotted spellings to the same bytes", () => {
    expect(Array.from(parseIPv6("::ffff:127.0.0.1")!)).toEqual(Array.from(parseIPv6("0:0:0:0:0:ffff:7f00:0001")!));
    expect(parseIPv6("not-an-ip")).toBeNull();
  });
});

describe("URL guard", () => {
  it("refuses IPv4-mapped IPv6 literals in URLs", () => {
    for (const raw of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/latest", "http://[64:ff9b::a00:1]/", "http://[2002:a00:1::]/"]) {
      expect(() => assertFetchableUrl(raw), raw).toThrow("That host isn't reachable.");
    }
    expect(isBlockedHost(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe(true);
  });

  it("refuses decimal / hex IPv4 spellings (normalised by URL)", () => {
    expect(() => assertFetchableUrl("http://2130706433/")).toThrow();
    expect(() => assertFetchableUrl("http://0x7f.1/")).toThrow();
  });
});

describe("pinned dispatcher (DNS rebinding)", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>internal secret</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("guardedLookup refuses when any resolved address is private", async () => {
    const lookup = guardedLookup(async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup("rebind.example", { all: true }, (e) => resolve(e)));
    expect(err?.code).toBe(SSRF_BLOCKED_CODE);
  });

  it("guardedLookup passes public answers through (single and all)", async () => {
    const lookup = guardedLookup(async () => [{ address: "93.184.215.14", family: 4 }]);
    const single = await new Promise<[unknown, unknown]>((resolve) => lookup("ok.example", {}, (e, a) => resolve([e, a])));
    expect(single).toEqual([null, "93.184.215.14"]);
    const all = await new Promise<[unknown, unknown]>((resolve) => lookup("ok.example", { all: true }, (e, a) => resolve([e, a])));
    expect(all).toEqual([null, [{ address: "93.184.215.14", family: 4 }]]);
  });

  it("refuses at connect time when the name rebinds to loopback after the check", async () => {
    // The connection-time resolver answers loopback (the rebinding attacker's second answer).
    const dispatcher = createGuardedDispatcher(async () => ["127.0.0.1"]);
    try {
      const failure = await fetch(`http://rebind.example:${port}/`, { dispatcher } as RequestInit).then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure).toBeTruthy();
      expect(((failure as { cause?: NodeJS.ErrnoException }).cause ?? {}).code).toBe(SSRF_BLOCKED_CODE);
    } finally {
      await dispatcher.destroy();
    }
  });

  it("refuses literal private IPs at connect time too", async () => {
    const dispatcher = createGuardedDispatcher(async () => ["93.184.215.14"]);
    try {
      const failure = await fetch(`http://127.0.0.1:${port}/`, { dispatcher } as RequestInit).then(
        () => null,
        (err: unknown) => err,
      );
      expect(((failure as { cause?: NodeJS.ErrnoException }).cause ?? {}).code).toBe(SSRF_BLOCKED_CODE);
    } finally {
      await dispatcher.destroy();
    }
  });

  it("safeFetchText: check says public, connect resolves loopback → refused, never reads the page", async () => {
    let calls = 0;
    // First call (pre-flight) answers public; every later call (the connect) answers loopback.
    const resolveHost = async () => (calls++ === 0 ? ["93.184.215.14"] : ["127.0.0.1"]);
    await expect(safeFetchText("http://rebind.example/", { resolveHost, timeoutMs: 3_000 })).rejects.toThrow("That host isn't reachable.");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("safeFetchText passes the dispatcher on every hop, including redirects", async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (url: string, init: RequestInit & { dispatcher?: unknown }) => {
      seen.push(init.dispatcher);
      if (url === "https://a.ca/") return new Response(null, { status: 301, headers: { location: "https://b.ca/x" } });
      return new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const page = await safeFetchText("https://a.ca/", { fetchImpl, resolveHost: async () => ["8.8.8.8"] });
    expect(page.url).toBe("https://b.ca/x");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeTruthy();
    expect(seen[1]).toBe(seen[0]);
  });
});

describe("homepage content type", () => {
  it("the crawl refuses a homepage that isn't a web page", async () => {
    const { crawlWebsite } = await import("@/server/services/dfy/crawl");
    const fetchImpl = (async () => new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    await expect(crawlWebsite("https://a.ca/", null, { fetchImpl, resolveHost: async () => ["8.8.8.8"] })).rejects.toThrow("isn't a web page");
  });
});
