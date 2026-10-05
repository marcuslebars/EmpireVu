import { describe, expect, it } from "vitest";

import { DEFAULT_BOOKING_POLICY, parseBookingPolicy } from "@/server/services/booking-windows";
import { ALL_PACKS, getPack, packReceptionistNotes } from "@/server/services/packs";
import { buildPackRecipeDefinition, canonicalJson, definitionFingerprint } from "@/server/services/packs/apply";
import {
  industryPackSchema,
  PACK_TEMPLATE_FILTERS,
  PACK_TEMPLATE_VARIABLES,
} from "@/server/services/packs/types";
import { buildReceptionistPrompt } from "@/server/services/retell/provision";
import { getRecipe, type Recipe } from "@/server/services/workflow-engine/recipes";
import { recipeTextsCustomers } from "@/server/services/workflow-engine/recipes/install";
import { renderTemplate, type MessageTemplateData } from "@/server/services/workflow-engine/interpolate";
import { STOP_FOOTER } from "@/server/services/workflow-engine/messaging";
import { parseWorkflowDefinition } from "@/server/services/workflow-engine/definitions";
import { parseDuration } from "@/server/services/workflow-engine/timing";
import type { Json } from "@/server/db/database.types";

const TOKEN = /\{\{\s*([^}|]+?)\s*(?:\|\s*([a-zA-Z]+)\s*)?\}\}/g;

function tokens(text: string): Array<{ path: string; filter: string | null }> {
  return [...text.matchAll(TOKEN)].map((m) => ({ path: m[1].trim(), filter: m[2]?.trim() ?? null }));
}

/** Every string in a value, with its key path — for the deep "no prices" scan. */
function walk(value: unknown, path: string[] = [], out: Array<{ path: string[]; value: unknown }> = []) {
  out.push({ path, value });
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, String(i)], out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, [...path, k], out);
  return out;
}

/** The roots (contact/company/booking/quote/call) the stock recipe's own messages use. */
function rootsUsedBy(recipe: Recipe): Set<string> {
  const roots = new Set<string>(["contact", "company"]);
  for (const action of recipe.definition.actions) {
    const texts = [
      "body" in action ? action.body : "",
      "subject" in action && typeof action.subject === "string" ? action.subject : "",
    ];
    for (const t of texts) for (const { path } of tokens(t ?? "")) roots.add(path.split(".")[0]);
  }
  return roots;
}

/**
 * A realistic worst-ish case of what buildMessageTemplateData produces (workflow-engine/
 * context.ts): long company name, a real-length booking URL (/book/<uuid>), a quote URL.
 */
const TEMPLATE_DATA: MessageTemplateData = {
  contact: { first_name: "Christopher", last_name: "Vanderhoeven" },
  company: {
    name: "Georgian Bay Property Services",
    booking_url: "https://app.empirevu.com/book/3f2c9a1e-8d4b-4c6a-9e1f-0a2b3c4d5e6f",
    review_url: "https://g.page/r/CdXyZ12345abcdEBM/review",
  },
  booking: { scheduled_for: "2026-11-17T14:00:00.000Z", when: "Tuesday, November 17th in the morning", manage_url: "https://quotes.example.ca/v/0123456789abcdef0123456789abcdef" },
  quote: {
    public_url: "https://app.empirevu.com/q/AbCdEfGhIjKlMnOpQrSt",
    subtotal: "$12,480.50",
    total: "$14,103.97",
    deposit: "$1,250.00",
    number: "Q-2026-00042",
    boat: "24 ft bowrider",
  },
  call: null,
  fields: {},
};

const parsedPacks = ALL_PACKS.map((pack) => ({ raw: pack, parsed: pack }));

describe("industry packs — shape", () => {
  it("ships the six CrankLeads packs, snow first, with unique ids", () => {
    const ids = ALL_PACKS.map((p) => p.id);
    expect(ids[0]).toBe("property-maintenance-snow");
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["property-maintenance-snow", "landscaping", "roofing", "hvac-plumbing", "marine", "general-contractor"]) {
      expect(ids).toContain(id);
    }
  });

  it.each(ALL_PACKS.map((p) => [p.id, p]))("%s validates against the strict pack schema", (_id, pack) => {
    const result = industryPackSchema.safeParse(pack);
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
    expect(getPack(pack.id)?.id).toBe(pack.id);
  });

  it("rejects a price field on a service (schema is strict)", () => {
    const withPrice = {
      ...ALL_PACKS[0],
      services: [{ ...ALL_PACKS[0].services[0], rateCents: 1 }, ...ALL_PACKS[0].services.slice(1)],
    };
    expect(industryPackSchema.safeParse(withPrice).success).toBe(false);
  });

  it("returns null for an unknown pack id", () => {
    expect(getPack("nope")).toBeNull();
  });
});

describe.each(parsedPacks.map(({ raw, parsed }) => [raw.id, raw, parsed] as const))("pack %s", (_id, raw, pack) => {
  it("carries no prices anywhere (no price-like keys, no dollar amounts in text)", () => {
    for (const { path, value } of walk(raw)) {
      const key = path[path.length - 1] ?? "";
      expect(key, path.join(".")).not.toMatch(/price|cents|rate$|amount|cost|fee/i);
      if (typeof value === "string") {
        // Money may only appear as a template variable filled from the company's own quote.
        expect(value.replace(TOKEN, ""), path.join(".")).not.toMatch(/\$\s?\d|\d\s?(dollars|bucks|CAD)\b/i);
      }
    }
  });

  it("has unique service keys and labels", () => {
    expect(new Set(pack.services.map((s) => s.key)).size).toBe(pack.services.length);
    expect(new Set(pack.services.map((s) => s.label.toLowerCase())).size).toBe(pack.services.length);
  });

  it("references only recipes that exist in the catalog, once each", () => {
    const slugs = pack.recipes.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(getRecipe(slug), slug).not.toBeNull();
  });

  it("builds a valid workflow definition for every recipe", () => {
    for (const packRecipe of pack.recipes) {
      const recipe = getRecipe(packRecipe.slug)!;
      const definition = buildPackRecipeDefinition(recipe, packRecipe, pack);
      expect(() => parseWorkflowDefinition(definition as unknown as Json)).not.toThrow();
      expect(definition.actions.map((a) => a.type)).toEqual(recipe.definition.actions.map((a) => a.type));
    }
  });

  it("uses only template variables that exist, and only roots the recipe's trigger provides", () => {
    for (const packRecipe of pack.recipes) {
      const recipe = getRecipe(packRecipe.slug)!;
      const allowedRoots = rootsUsedBy(recipe);
      for (const message of packRecipe.messages ?? []) {
        for (const text of [message.body, message.subject ?? ""]) {
          for (const { path, filter } of tokens(text)) {
            expect(PACK_TEMPLATE_VARIABLES as readonly string[], `${recipe.slug}: ${path}`).toContain(path);
            expect(allowedRoots.has(path.split(".")[0]), `${recipe.slug}: ${path}`).toBe(true);
            if (filter) expect(PACK_TEMPLATE_FILTERS as readonly string[]).toContain(filter);
          }
          expect(text).not.toMatch(/\{\{(?![^}]*\}\})/); // no unclosed tokens
        }
      }
    }
  });

  it("keeps customer texts short (≤ 320 chars rendered, with the STOP footer) and identifies the business", () => {
    for (const packRecipe of pack.recipes) {
      const recipe = getRecipe(packRecipe.slug)!;
      if (!recipeTextsCustomers(recipe)) continue;
      const definition = buildPackRecipeDefinition(recipe, packRecipe, pack);
      for (const action of definition.actions) {
        if (action.type === "send_sms" && action.to !== "owner") {
          expect(action.body, recipe.slug).toContain("{{company.name}}");
          const rendered = `${renderTemplate(action.body, TEMPLATE_DATA)}\n${STOP_FOOTER}`;
          expect(rendered.length, `${recipe.slug}: ${rendered}`).toBeLessThanOrEqual(320);
          expect(rendered).not.toContain("{{");
        }
        if (action.type === "send_email" && action.to !== "owner") {
          expect(`${action.subject} ${action.body}`, recipe.slug).toContain("{{company.name}}");
        }
      }
    }
  });

  it("never hardcodes an AI employee's name", () => {
    for (const { value, path } of walk(raw)) {
      if (typeof value === "string") expect(value, path.join(".")).not.toMatch(/\b(Marina|Sam|Dana)\b/);
    }
  });

  it("has a parseable review delay and (if present) a booking policy that parses as given", () => {
    expect(parseDuration(pack.reviewRequest.delay)).toBeGreaterThan(0);
    const reviewRecipe = pack.recipes.find((r) => r.slug === "review-request");
    if (reviewRecipe) {
      const def = buildPackRecipeDefinition(getRecipe("review-request")!, reviewRecipe, pack);
      expect(def.actions[0]).toMatchObject({ type: "wait", duration: pack.reviewRequest.delay });
    }
    if (pack.booking) {
      const policy = parseBookingPolicy(pack.booking);
      expect(policy).not.toBeNull();
      expect(policy?.windows).toEqual(pack.booking.windows ?? DEFAULT_BOOKING_POLICY.windows);
      expect(policy?.workingDays).toEqual([...(pack.booking.workingDays ?? [])].sort());
    }
  });

  it("gives the receptionist urgency keywords, qualifying questions and FAQs", () => {
    const notes = packReceptionistNotes(pack);
    expect(notes.urgentKeywords.length).toBeGreaterThanOrEqual(3);
    expect(notes.qualifyingQuestions.length).toBeGreaterThanOrEqual(3);
    expect(notes.faqs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("pack template variables resolve against the workflow context shape", () => {
  it.each(PACK_TEMPLATE_VARIABLES.map((v) => [v]))("{{%s}} renders non-empty", (variable) => {
    expect(renderTemplate(`{{${variable}}}`, TEMPLATE_DATA)).not.toBe("");
  });
});

describe("non-marine packs drop the boat wording from the receptionist quote texts", () => {
  it.each(parsedPacks.filter(({ parsed }) => parsed.id !== "marine").map(({ parsed }) => [parsed.id, parsed]))(
    "%s",
    (_id, pack) => {
      for (const slug of ["post-call-quote-text", "deposit-paid-pick-date"]) {
        const packRecipe = pack.recipes.find((r) => r.slug === slug);
        expect(packRecipe, slug).toBeDefined();
        const def = buildPackRecipeDefinition(getRecipe(slug)!, packRecipe!, pack);
        expect(canonicalJson(def)).not.toContain("quote.boat");
      }
    },
  );
});

describe("buildPackRecipeDefinition", () => {
  it("leaves the stock recipe untouched (deep copy) and fingerprints ignore _meta keys", () => {
    const recipe = getRecipe("missed-call-text-back")!;
    const before = canonicalJson(recipe.definition);
    const pack = getPack("roofing")!;
    const def = buildPackRecipeDefinition(recipe, pack.recipes.find((r) => r.slug === recipe.slug)!, pack);
    expect(canonicalJson(recipe.definition)).toBe(before);
    expect(definitionFingerprint(def)).not.toBe(definitionFingerprint(recipe.definition));
    expect(definitionFingerprint({ ...recipe.definition, _disabled_reason: "x", _pack: { id: "y" } })).toBe(
      definitionFingerprint(recipe.definition),
    );
  });

  it("refuses an override aimed at the wrong action type", () => {
    const recipe = getRecipe("review-request")!;
    expect(() =>
      buildPackRecipeDefinition(recipe, { slug: "review-request", messages: [{ actionIndex: 0, body: "Hello from {{company.name}}" }] }, {
        id: "t",
        reviewRequest: { delay: "1d" },
      }),
    ).toThrow(/not a send_sms/);
  });
});

// ── Receptionist prompt: pack notes are additive (golden) ─────────────────────

const PROMPT_CTX = {
  companyName: "Bayside Snow & Lawn",
  services: ["Seasonal snow contract — residential driveway", "Fall cleanup"],
  hoursText: "Mon–Sat 8–6",
  bookingUrl: "https://app.empirevu.com/book/co-1",
  serviceArea: "Midland, Penetanguishene and Tiny Township",
  transferNumber: "+17055550100",
};

const GOLDEN_WITHOUT_PACK = [
  "You are Marina, the friendly virtual receptionist for Bayside Snow & Lawn. You answer inbound phone calls.",
  "Be warm, concise, and helpful. Your goals: understand what the caller needs, answer questions about the services below, capture their name and phone number, and book them in or take a message.",
  "",
  "Services offered:\n- Seasonal snow contract — residential driveway\n- Fall cleanup",
  "",
  "Service area: Midland, Penetanguishene and Tiny Township.",
  "",
  "Business hours: Mon–Sat 8–6.",
  "",
  "To book, offer to text them the booking link: https://app.empirevu.com/book/co-1.",
  "",
  "If the caller needs a human or has an urgent issue, offer to transfer them to +17055550100.",
  "",
  "Never invent prices or availability you weren't given. If you don't know something, say you'll have the team follow up, and make sure you have their callback number.",
].join("\n");

describe("buildReceptionistPrompt with industry-pack notes", () => {
  it("is unchanged when no pack notes are given (golden)", () => {
    expect(buildReceptionistPrompt(PROMPT_CTX)).toBe(GOLDEN_WITHOUT_PACK);
    expect(buildReceptionistPrompt(PROMPT_CTX, null)).toBe(GOLDEN_WITHOUT_PACK);
  });

  it("appends the pack's knowledge before the closing rule", () => {
    const pack = getPack("property-maintenance-snow")!;
    const prompt = buildReceptionistPrompt(PROMPT_CTX, packReceptionistNotes(pack));

    // Everything from before is still there, in order, and the closing rule is still last.
    const withoutClosing = GOLDEN_WITHOUT_PACK.slice(0, GOLDEN_WITHOUT_PACK.lastIndexOf("\n\nNever invent"));
    expect(prompt.startsWith(withoutClosing)).toBe(true);
    expect(prompt.endsWith("make sure you have their callback number.")).toBe(true);

    expect(prompt).toContain(`About this business (Property maintenance & snow): ${pack.receptionist.businessSummary}`);
    expect(prompt).toContain('"plow didn\'t come"');
    expect(prompt).toContain("- Are you looking for a seasonal contract or pay-per-push?");
    expect(prompt).toContain("- Q: What's the difference between seasonal and per-push?");
    for (const note of pack.receptionist.seasonalNotes) expect(prompt).toContain(`- ${note}`);
  });

  it("tells HVAC callers who smell gas to get out first", () => {
    const prompt = buildReceptionistPrompt(PROMPT_CTX, packReceptionistNotes(getPack("hvac-plumbing")!));
    expect(prompt).toMatch(/smells gas.*leave the building/i);
    expect(prompt).toContain('"no heat"');
  });
});
