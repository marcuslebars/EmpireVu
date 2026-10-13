import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { brandForHost, brandForOrg, EVERDOER_BRAND } from "@/lib/platform-brand";

// Everdoer rebrand PR 2: every host DISPLAYS Everdoer. brandForHost still picks the product line
// exactly as in PR 1 (done-for-you on crankleads/everdoer hosts), so signed-out behaviour doesn't
// change. index.html is static Everdoer with no host script.

const HOSTS: Array<[string, "crankleads" | "empirevu"]> = [
  ["everdoer.com", "crankleads"],
  ["www.everdoer.com", "crankleads"],
  ["app.everdoer.com", "crankleads"],
  ["api.everdoer.com", "crankleads"],
  ["APP.Everdoer.com", "crankleads"],
  ["everdoer.localhost", "crankleads"],
  ["app.everdoer.localhost", "crankleads"],
  ["app.crankleads.com", "crankleads"],
  ["crankleads.com", "crankleads"],
  ["crankleads.localhost", "crankleads"],
  ["app.empirevu.com", "empirevu"],
  ["api.empirevu.com", "empirevu"],
  ["localhost", "empirevu"],
  ["quotes.a1marinecare.ca", "empirevu"],
  ["quotes.a1marinestorage.ca", "empirevu"],
  ["noteverdoer.com", "empirevu"],
  ["everdoer.com.evil.example", "empirevu"],
  ["everdoer.co", "empirevu"],
];

describe("brandForHost", () => {
  it.each(HOSTS)("%s → Everdoer, product-line key %s", (host, key) => {
    const brand = brandForHost(host);
    expect(brand.key).toBe(key);
    expect(brand.productLine).toBe(key === "crankleads" ? "done_for_you" : "standard");
    expect(brand.name).toBe("Everdoer");
    expect(brand.logoSrc).toBe(EVERDOER_BRAND.logoSrc);
    expect(brand.faviconHref).toBe("/favicon.svg");
  });

  it("ignores a port and a trailing dot", () => {
    expect(brandForHost("app.everdoer.localhost:5173").key).toBe("crankleads");
    expect(brandForHost("app.everdoer.com.").key).toBe("crankleads");
  });
});

describe("index.html is Everdoer for every host", () => {
  const root = resolve(__dirname, "../..");
  const html = readFileSync(resolve(root, "index.html"), "utf8");

  it("has no host script and no old brand names", () => {
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
    expect(html).not.toMatch(/data-brand/);
    expect(html).not.toMatch(/empire\s*vu|crank\s*leads/i);
  });

  it("title, description, author, og tags", () => {
    expect(html).toMatch(/<title>Everdoer<\/title>/);
    expect(html).toContain('<meta name="description" content="Everdoer — the employee who never clocks out." />');
    expect(html).toContain('<meta property="og:description" content="Everdoer — the employee who never clocks out." />');
    expect(html).toContain('<meta name="author" content="Everdoer" />');
    expect(html).toContain('<meta property="og:title" content="Everdoer" />');
    expect(html).toContain('<meta property="og:image" content="/brand/everdoer/everdoer-logo-dark.png" />');
    expect(html).toContain('<meta name="theme-color" content="#0C0E12" />');
  });

  it("favicons and manifest point at files that exist", () => {
    for (const [tag, href] of [
      ['<link rel="icon" href="/favicon.ico" sizes="any" />', "favicon.ico"],
      ['<link rel="icon" type="image/svg+xml" href="/favicon.svg" />', "favicon.svg"],
      ['<link rel="apple-touch-icon" href="/apple-touch-icon.png" />', "apple-touch-icon.png"],
      ['<link rel="manifest" href="/manifest.webmanifest" />', "manifest.webmanifest"],
    ]) {
      expect(html).toContain(tag);
      expect(existsSync(resolve(root, "public", href))).toBe(true);
    }
    expect(existsSync(resolve(root, "public/brand/everdoer/everdoer-logo-dark.png"))).toBe(true);
  });

  it("manifest: Everdoer, 192/512 icons, near-black colours", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "public/manifest.webmanifest"), "utf8")) as {
      name: string;
      short_name: string;
      theme_color: string;
      background_color: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    expect(manifest.name).toBe("Everdoer");
    expect(manifest.short_name).toBe("Everdoer");
    expect(manifest.theme_color).toBe("#0C0E12");
    expect(manifest.background_color).toBe("#0C0E12");
    expect(manifest.icons.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    for (const icon of manifest.icons) {
      expect(existsSync(resolve(root, "public", icon.src.replace(/^\//, "")))).toBe(true);
    }
  });
});

describe("brandForOrg goes through the product line", () => {
  it("accepts old and Phase 3 platform_brand values", () => {
    expect(brandForOrg({ platform_brand: "done_for_you" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "standard" }).key).toBe("empirevu");
    expect(brandForOrg({ platform_brand: "crankleads" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "empirevu" }).key).toBe("empirevu");
    expect(brandForOrg({ platform_brand: " Done_For_You " }).productLine).toBe("done_for_you");
  });

  it("still treats a done-for-you tier (old or Phase 3 column) as done for you", () => {
    expect(brandForOrg({ platform_brand: "standard", crankleads_tier: "catch" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: null, plan_tier: "close" }).key).toBe("crankleads");
    expect(brandForOrg({ platform_brand: "bogus" }).key).toBe("empirevu");
    expect(brandForOrg(null).key).toBe("empirevu");
  });
});
