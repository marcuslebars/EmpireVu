/**
 * Help articles + keyword retrieval (docs/help-assistant.md). The Ask endpoint answers ONLY
 * from what retrieveHelpSections returns, so the ranking is the grounding: these golden
 * questions must land on the right article, and off-topic ones must retrieve nothing (which
 * short-circuits to "I'm not sure" without a model call).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HELP_ARTICLES, findHelpArticle } from "@/content/help/articles";
import { parseHelpBody } from "@/content/help/format";
import {
  buildHelpIndex,
  getHelpIndex,
  retrieveHelpSections,
  searchHelpArticles,
  searchHelpSections,
  stem,
  tokenize,
} from "@/content/help/search";
import { buildForwardingInstructions } from "@/lib/carrier-forwarding";

const topArticle = (q: string) => searchHelpArticles(getHelpIndex(), q)[0]?.article.id;

describe("help library hygiene", () => {
  it("has unique ids and non-empty sections", () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const article of HELP_ARTICLES) {
      expect(article.title.length).toBeGreaterThan(5);
      expect(article.sections.length).toBeGreaterThan(0);
      for (const section of article.sections) expect(section.body.trim().length).toBeGreaterThan(20);
    }
  });

  it("covers every topic the help panel promises", () => {
    for (const id of [
      "getting-started",
      "phone-setup",
      "call-forwarding",
      "test-forwarding",
      "website-form",
      "services-prices",
      "booking-link",
      "quotes-deposits",
      "review-requests",
      "ai-receptionist",
      "monthly-scorecard",
      "notifications-digest",
      "billing",
      "texting-rules",
      "data-and-cancel",
      "contact-support",
    ]) {
      expect(findHelpArticle(id), id).toBeDefined();
    }
  });

  it("never states a dollar amount (prices live in Stripe)", () => {
    const source = readFileSync("src/content/help/articles.ts", "utf8");
    expect(source).not.toMatch(/\$\s?\d/);
  });

  it("documents the exact forwarding codes the app generates", () => {
    const codes = buildForwardingInstructions("+17055551234");
    const article = findHelpArticle("call-forwarding");
    const text = JSON.stringify(article).replace(/NUMBER/g, "+17055551234");
    expect(text).toContain(codes.recommended.activate);
    expect(text).toContain(codes.recommended.deactivate);
    for (const code of codes.codes) {
      expect(text).toContain(code.activate);
      expect(text).toContain(code.deactivate);
    }
    for (const carrier of ["Rogers", "Bell", "Telus", "Fido", "Koodo", "Freedom", "Virgin"]) {
      expect(text).toContain(carrier);
    }
  });
});

describe("tokenize / stem", () => {
  it("lowercases, drops stopwords and stems plurals/-ing/-ed", () => {
    expect(tokenize("How do I turn OFF the Texts?")).toEqual(["turn", "off", "text"]);
    expect(stem("texting")).toBe("text");
    expect(stem("inviting")).toBe(stem("invite"));
    expect(stem("services")).toBe(stem("service"));
    expect(stem("forwarded")).toBe("forward");
    expect(stem("business")).toBe("business");
  });
});

describe("retrieval ranking (golden questions)", () => {
  const cases: Array<[string, string]> = [
    ["how do I turn off call forwarding", "call-forwarding"],
    ["what code do I dial on Rogers", "call-forwarding"],
    ["my landline is with bell, how do I forward", "call-forwarding"],
    ["I called but never got the text back", "test-forwarding"],
    ["pick an area code for my missed call number", "phone-setup"],
    ["put the form on my wix site", "website-form"],
    ["where is my form link for google business profile", "website-form"],
    ["how do I cancel my subscription", "billing"],
    ["update my credit card", "billing"],
    ["customer replied STOP", "texting-rules"],
    ["add my google review link", "review-requests"],
    ["connect stripe to take deposits", "quotes-deposits"],
    ["booking reminders before appointments", "booking-link"],
    ["turn off the monthly scorecard email", "monthly-scorecard"],
    ["change the time of my daily digest", "notifications-digest"],
    ["invite my office manager", "team"],
    ["export my contacts", "data-and-cancel"],
    ["fill in prices for my services", "services-prices"],
    ["what does the ai receptionist do", "ai-receptionist"],
    ["continue setup", "getting-started"],
  ];

  it.each(cases)("%s → %s", (question, expected) => {
    expect(topArticle(question)).toBe(expected);
  });

  it("retrieves nothing for off-topic questions", () => {
    expect(retrieveHelpSections(getHelpIndex(), "what is the weather in naples tomorrow")).toEqual([]);
    expect(retrieveHelpSections(getHelpIndex(), "   ")).toEqual([]);
  });

  it("caps and trims retrieval to sections near the best hit", () => {
    const hits = retrieveHelpSections(getHelpIndex(), "call forwarding code turn off", { maxSections: 4 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(4);
    for (const hit of hits) expect(hit.score).toBeGreaterThanOrEqual(hits[0].score * 0.3);
  });

  it("is deterministic (same order every time) and scores best-first", () => {
    const a = searchHelpSections(getHelpIndex(), "text").map((h) => `${h.article.id}#${h.sectionIndex}`);
    const b = searchHelpSections(buildHelpIndex(HELP_ARTICLES), "text").map((h) => `${h.article.id}#${h.sectionIndex}`);
    expect(a).toEqual(b);
    const scores = searchHelpSections(getHelpIndex(), "text").map((h) => h.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });
});

describe("parseHelpBody", () => {
  it("splits paragraphs, bullets and numbered steps", () => {
    expect(parseHelpBody("Intro line\n- one\n- two\n1. first\n2. second\nOutro")).toEqual([
      { kind: "p", lines: ["Intro line"] },
      { kind: "ul", items: ["one", "two"] },
      { kind: "ol", items: ["first", "second"] },
      { kind: "p", lines: ["Outro"] },
    ]);
  });
});
