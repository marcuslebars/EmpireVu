/**
 * Google Places (New) response mapping (fixtures), the website crawl's link selection + logo
 * pick + fact extraction, and the shared SSRF guard (src/server/net/safe-fetch.ts) that the
 * crawl and the catalog parser both use.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { combinePageTexts, fetchWebsiteText } from "@/server/ai/catalog-parser";
import { assertFetchableUrl, isBlockedHost, isPrivateAddress, normalizeWebsiteUrl, safeFetchText } from "@/server/net/safe-fetch";
import {
  crawlWebsite,
  extractHoursText,
  extractLinks,
  extractMetaDescription,
  extractPhones,
  pickLogo,
  selectCrawlLinks,
} from "@/server/services/dfy/crawl";
import {
  getPlaceDetails,
  hoursFromPlaces,
  mapPlaceDetails,
  mapPlaceSearch,
  PLACE_DETAILS_FIELD_MASK,
  reviewUrlFor,
  searchPlaces,
  serviceAreaFromPlace,
} from "@/server/services/dfy/places";

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Places fixtures (shape of places.googleapis.com/v1 responses) ────────────

const PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4";

const SEARCH_FIXTURE = {
  places: [
    { id: PLACE_ID, displayName: { text: "Jane's Roofing", languageCode: "en" }, formattedAddress: "12 Dunlop St W, Barrie, ON L4N 1A1, Canada" },
    { id: "bad id with spaces", displayName: { text: "Dropped" } },
    { id: "ChIJ_no_name_aaaaaaaa" },
  ],
};

const DETAILS_FIXTURE = {
  id: PLACE_ID,
  displayName: { text: "Jane's Roofing", languageCode: "en" },
  formattedAddress: "12 Dunlop St W, Barrie, ON L4N 1A1, Canada",
  addressComponents: [
    { longText: "12", shortText: "12", types: ["street_number"] },
    { longText: "Dunlop Street West", shortText: "Dunlop St W", types: ["route"] },
    { longText: "Barrie", shortText: "Barrie", types: ["locality", "political"] },
    { longText: "Ontario", shortText: "ON", types: ["administrative_area_level_1", "political"] },
    { longText: "Canada", shortText: "CA", types: ["country", "political"] },
  ],
  nationalPhoneNumber: "(705) 555-0101",
  websiteUri: "https://janesroofing.ca/",
  regularOpeningHours: {
    openNow: true,
    periods: [
      { open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } },
      { open: { day: 2, hour: 8, minute: 0 }, close: { day: 2, hour: 17, minute: 30 } },
    ],
    weekdayDescriptions: ["Monday: 8:00 AM – 5:00 PM", "Tuesday: 8:00 AM – 5:30 PM", "Sunday: Closed"],
  },
  rating: 4.76,
  userRatingCount: 38,
  googleMapsUri: "https://maps.google.com/?cid=123",
  primaryTypeDisplayName: { text: "Roofing contractor", languageCode: "en" },
  // Never requested, never kept — but if Google sent them we must not pass them through.
  reviews: [{ text: { text: "Great job!" } }],
  photos: [{ name: "places/x/photos/y" }],
};

describe("Google Places mapping", () => {
  it("search results: name + address only, bad ids dropped", () => {
    expect(mapPlaceSearch(SEARCH_FIXTURE)).toEqual([
      { placeId: PLACE_ID, name: "Jane's Roofing", address: "12 Dunlop St W, Barrie, ON L4N 1A1, Canada" },
    ]);
    expect(mapPlaceSearch({})).toEqual([]);
    expect(mapPlaceSearch(null)).toEqual([]);
  });

  it("details: facts, rating + count, review link — no review text or photos", () => {
    const details = mapPlaceDetails(DETAILS_FIXTURE);
    expect(details).toEqual({
      placeId: PLACE_ID,
      name: "Jane's Roofing",
      address: "12 Dunlop St W, Barrie, ON L4N 1A1, Canada",
      locality: "Barrie",
      province: "ON",
      phoneNational: "(705) 555-0101",
      website: "https://janesroofing.ca/",
      hours: {
        summary: "Monday: 8:00 AM – 5:00 PM; Tuesday: 8:00 AM – 5:30 PM; Sunday: Closed",
        periods: [
          { day: 1, open: "08:00", close: "17:00" },
          { day: 2, open: "08:00", close: "17:30" },
        ],
      },
      rating: 4.8,
      reviewCount: 38,
      mapsUrl: "https://maps.google.com/?cid=123",
      primaryType: "Roofing contractor",
      reviewUrl: `https://search.google.com/local/writereview?placeid=${PLACE_ID}`,
    });
    expect(JSON.stringify(details)).not.toMatch(/Great job|photos/);
    expect(serviceAreaFromPlace(details)).toBe("Barrie and surrounding area");
    expect(serviceAreaFromPlace({ locality: null })).toBeNull();
    expect(reviewUrlFor("a b")).toBe("https://search.google.com/local/writereview?placeid=a%20b");
  });

  it("tolerates partial details", () => {
    expect(mapPlaceDetails({ id: PLACE_ID })).toMatchObject({ name: null, hours: null, rating: null, reviewCount: null, locality: null });
    expect(mapPlaceDetails({ id: "../x" })).toBeNull();
    expect(hoursFromPlaces({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })).toEqual({
      summary: "Sun 00:00",
      periods: [{ day: 0, open: "00:00", close: null }],
    });
  });

  it("calls Places (New) with the key + field mask; skipped when unconfigured", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(SEARCH_FIXTURE), { status: 200 }));
    const results = await searchPlaces("janes roofing barrie", { apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(results).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect((init?.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("k");
    expect((init?.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("places.id,places.displayName,places.formattedAddress");
    expect(JSON.parse(init?.body as string)).toMatchObject({ textQuery: "janes roofing barrie", regionCode: "CA" });

    const detailFetch = vi.fn(async () => new Response(JSON.stringify(DETAILS_FIXTURE), { status: 200 }));
    await getPlaceDetails(PLACE_ID, { apiKey: "k", fetchImpl: detailFetch as unknown as typeof fetch });
    const [detailUrl, detailInit] = detailFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(detailUrl).toContain(`/v1/places/${PLACE_ID}`);
    expect((detailInit.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe(PLACE_DETAILS_FIELD_MASK);
    expect(PLACE_DETAILS_FIELD_MASK).not.toMatch(/reviews|photos/);

    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    const never = vi.fn();
    expect(await searchPlaces("x y", { fetchImpl: never as unknown as typeof fetch })).toEqual([]);
    expect(await getPlaceDetails(PLACE_ID, { fetchImpl: never as unknown as typeof fetch })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it("an API error surfaces as PlacesUnavailableError", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 403 }));
    await expect(searchPlaces("abc", { apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/403: API key not valid/);
  });
});

// ── Crawl ────────────────────────────────────────────────────────────────────

const HOME = "https://www.janesroofing.ca/";
const HOME_HTML = `<!doctype html><html><head>
  <title>Jane's Roofing</title>
  <meta name="description" content="Family-run roofing in Barrie since we started. Shingles, flat roofs &amp; repairs.">
  <link rel="icon" href="/favicon.ico">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <meta property="og:image" content="https://cdn.example.com/hero-roof.jpg">
</head><body>
  <header><a href="/"><img class="custom-logo" src="/wp-content/uploads/janes-logo.png" width="240" alt="Jane's Roofing"></a></header>
  <nav>
    <a href="/services/">Our Services</a>
    <a href="https://janesroofing.ca/pricing">Pricing</a>
    <a href="/about-us">About</a>
    <a href="/contact#form">Contact</a>
    <a href="/blog/roof-tips">Blog</a>
    <a href="/services">Services again</a>
    <a href="https://facebook.com/janes">Facebook</a>
    <a href="mailto:jane@x.ca">Email</a>
    <a href="/brochure.pdf">Brochure (pricing PDF)</a>
    <a href="/gallery">Gallery</a>
    <a href="/residential-roofing">Residential</a>
    <a href="/commercial-roofing">Commercial</a>
  </nav>
  <footer><img src="/img/bbb-logo.png" alt="BBB accredited" width="400"> Call (705) 555-0101 · Mon - Fri 8am - 5pm, Sat 9am-1pm</footer>
  <img src="/pixel.gif" width="1" height="1" class="logo-pixel">
</body></html>`;

describe("crawl link selection", () => {
  it("picks up to 5 same-site pages that look like pricing/services/about/contact, pricing first", () => {
    const links = extractLinks(HOME_HTML, HOME);
    const picked = selectCrawlLinks(links, HOME);
    expect(picked).toEqual([
      "https://janesroofing.ca/pricing",
      "https://www.janesroofing.ca/services/",
      "https://www.janesroofing.ca/residential-roofing",
      "https://www.janesroofing.ca/commercial-roofing",
      "https://www.janesroofing.ca/about-us",
    ]);
    expect(picked.join(" ")).not.toMatch(/blog|facebook|mailto|\.pdf|gallery/);
    expect(selectCrawlLinks(links, HOME, 2)).toHaveLength(2);
  });
});

describe("logo pick", () => {
  it("prefers the <img> that is the logo over the apple-touch-icon, og:image, badges and pixels", () => {
    expect(pickLogo(HOME_HTML, HOME, "Jane's Roofing")).toBe("https://www.janesroofing.ca/wp-content/uploads/janes-logo.png");
  });

  it("falls back: apple-touch-icon > og:image > favicon; absolute URLs; never data:", () => {
    const noImg = HOME_HTML.replace(/<img class="custom-logo"[^>]*>/, "");
    expect(pickLogo(noImg, HOME)).toBe("https://www.janesroofing.ca/apple-touch-icon.png");
    const noTouch = noImg.replace(/<link rel="apple-touch-icon"[^>]*>/, "");
    expect(pickLogo(noTouch, HOME)).toBe("https://cdn.example.com/hero-roof.jpg");
    expect(pickLogo('<link rel="shortcut icon" href="/f.ico">', HOME)).toBe("https://www.janesroofing.ca/f.ico");
    expect(pickLogo('<img src="data:image/png;base64,xx" alt="logo">', HOME)).toBeNull();
    expect(pickLogo("<p>nothing</p>", HOME)).toBeNull();
    // An img whose alt is the business name counts as the logo.
    expect(pickLogo('<img src="/a.svg" alt="Jane’s Roofing Ltd">', HOME, "Jane's Roofing")).toBe("https://www.janesroofing.ca/a.svg");
    expect(pickLogo('<img src="/team.jpg" alt="Our crew">', HOME, "Jane's Roofing")).toBeNull();
    expect(pickLogo('<img src="/a.svg" alt="Janes Roofing">', HOME, "Jane's Roofing")).toBe("https://www.janesroofing.ca/a.svg");
  });
});

describe("facts from the page", () => {
  it("meta description, phones, hours", () => {
    expect(extractMetaDescription(HOME_HTML)).toBe("Family-run roofing in Barrie since we started. Shingles, flat roofs & repairs.");
    expect(extractMetaDescription('<meta name="description" content="short">')).toBeNull();
    expect(extractPhones("Call 705-555-0101 or (705) 555-0101, fax 1 416 555 0199")).toEqual(["+17055550101", "+14165550199"]);
    expect(extractHoursText("Mon - Fri 8am - 5pm, Sat 9am-1pm. Sunday closed")).toBe("Mon - Fri 8am - 5pm; Sat 9am-1pm; Sunday closed");
    expect(extractHoursText("We have 25 years of experience")).toBeNull();
  });
});

describe("crawlWebsite (SSRF guard reused)", () => {
  const publicDns = async () => ["93.184.216.34"];

  it("fetches the homepage + selected pages through the guard and gathers facts", async () => {
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      fetched.push(url);
      if (url === HOME) return new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html" } });
      if (url.endsWith("/pricing")) return new Response("<p>Roof inspection $150</p>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response("nope", { status: 404 });
    });
    const result = await crawlWebsite(HOME, "Jane's Roofing", { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: publicDns });
    expect(fetched[0]).toBe(HOME);
    expect(fetched).toHaveLength(6);
    expect(result.pages.map((p) => p.url)).toEqual([HOME, "https://janesroofing.ca/pricing"]);
    expect(result.pages[1].text).toBe("Roof inspection $150");
    expect(result.logoUrl).toBe("https://www.janesroofing.ca/wp-content/uploads/janes-logo.png");
    expect(result.phones).toEqual(["+17055550101"]);
    expect(result.hoursText).toContain("Mon - Fri 8am - 5pm");
    expect(result.failures).toHaveLength(4);
    // Each fetch is manual-redirect (so the guard sees every hop).
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("manual");
  });

  it("refuses private hosts, private DNS answers, and redirects into the network", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));
    await expect(crawlWebsite("http://127.0.0.1/", null, { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: publicDns })).rejects.toThrow(
      "That host isn't reachable.",
    );
    await expect(
      crawlWebsite("https://sneaky.example/", null, { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: async () => ["10.0.0.7"] }),
    ).rejects.toThrow("That host isn't reachable.");
    expect(fetchImpl).not.toHaveBeenCalled();

    const redirecting = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    await expect(
      safeFetchText("https://janesroofing.ca/", { fetchImpl: redirecting as unknown as typeof fetch, resolveHost: publicDns }),
    ).rejects.toThrow("That host isn't reachable.");
    expect(redirecting).toHaveBeenCalledTimes(1);
  });

  it("the catalog parser's fetch uses the same guard", async () => {
    await expect(fetchWebsiteText("http://localhost:8080/")).rejects.toThrow("That host isn't reachable.");
    await expect(fetchWebsiteText("ftp://x.ca/")).rejects.toThrow("Only http(s) URLs are supported.");
    const ok = vi.fn(async () => new Response("<h1>Hi</h1><script>x()</script><p>there</p>", { status: 200 }));
    expect(await fetchWebsiteText("https://a.ca/", { fetchImpl: ok as unknown as typeof fetch, resolveHost: publicDns })).toBe("Hi there");
  });
});

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local, metadata and bare hosts", () => {
    for (const host of ["localhost", "a.localhost", "printer.local", "db", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "[::1]", "::ffff:127.0.0.1", "metadata.google.internal", "100.64.0.1"]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
    for (const host of ["janesroofing.ca", "8.8.8.8", "www.example.com"]) expect(isBlockedHost(host), host).toBe(false);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(() => assertFetchableUrl("https://user:pw@a.ca/")).toThrow();
    expect(() => assertFetchableUrl("https://a.ca:8443/")).toThrow();
  });

  it("normalizes what a contractor types", () => {
    expect(normalizeWebsiteUrl("janesroofing.ca")).toBe("https://janesroofing.ca/");
    expect(normalizeWebsiteUrl(" www.janes.ca/services#top ")).toBe("https://www.janes.ca/services");
    expect(normalizeWebsiteUrl("not a site")).toBeNull();
    expect(normalizeWebsiteUrl("javascript:alert(1)")).toBeNull();
  });

  it("combinePageTexts heads each page with its URL and caps the total", () => {
    const text = combinePageTexts([
      { url: "https://a.ca/", text: "Home text" },
      { url: "https://a.ca/pricing", text: "Prices" },
      { url: "https://a.ca/empty", text: "  " },
    ]);
    expect(text).toBe("--- Page: https://a.ca/ ---\nHome text\n\n--- Page: https://a.ca/pricing ---\nPrices");
    expect(combinePageTexts([{ url: "u", text: "x".repeat(10_000) }], 1000).length).toBeLessThanOrEqual(1000);
  });
});
