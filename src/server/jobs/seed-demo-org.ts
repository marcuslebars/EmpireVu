/**
 * Seed the store-review demo organization.
 *
 * Google Play and Apple both require a working login to review the app, and both
 * re-use it on every update. Handing them a real account hands reviewers real
 * customers: names, phone numbers, message threads, quotes — plus the ability to
 * send a text to someone who never agreed to be part of a store review. This
 * builds a self-contained organization instead, with invented customers, so the
 * credentials in Play Console and App Store Connect point at nothing real.
 *
 * It is also what the listing screenshots should be taken on, for the same reason.
 *
 * Every screen the reviewer can open has data: an inbox with conversations waiting
 * on a reply, a lead with a drafted response, today's bookings, tasks, quotes at
 * three stages, and enough workflow history for the automation tile to show a number.
 *
 * Idempotent. Ids are derived from their names (uuid v5), so re-running updates the
 * same rows rather than piling up duplicates, and the demo password is reset to
 * whatever you supply. `--reset` clears the org's seeded data first.
 *
 * Service-role (bypasses RLS): a seed runs outside any request, so there is no RLS
 * identity to scope by — the organization is resolved explicitly by slug.
 *
 * Usage:
 *   npm run job:seed-demo -- --email demo@empirevu.com
 *   npm run job:seed-demo -- --email demo@empirevu.com --reset
 *
 * The password is never a CLI argument (it would sit in shell history): the script
 * reads DEMO_PASSWORD from the environment, or prompts for it without echoing.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Inserts, Json } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { createCompany } from "@/server/services/companies";
import { createQuote } from "@/server/services/quotes/service";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

const DEFAULT_ORG_SLUG = "empirevu-demo";
const COMPANY_SLUG = "harbour-point-marine";
const COMPANY_NAME = "Harbour Point Marine";
const TIMEZONE = "America/Toronto";

/** Marks every quote this seed creates, so a re-run replaces exactly its own. */
const QUOTE_SOURCE = "demo-seed";

const log = (message: string): void => console.log(`[seed-demo-org] ${message}`);

// ── ids ───────────────────────────────────────────────────────────────────────

/**
 * A uuid v5 derived from the row's name. Same name, same id, forever — which is
 * what makes the upserts below idempotent without the script having to remember
 * anything between runs.
 */
function demoId(name: string): string {
  const bytes = createHash("sha1").update(`empirevu-demo-seed:${name}`).digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ── time ──────────────────────────────────────────────────────────────────────

const NOW = Date.now();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const minutesAgo = (n: number): string => new Date(NOW - n * MINUTE).toISOString();
const hoursAgo = (n: number): string => new Date(NOW - n * HOUR).toISOString();
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

/** Today at a local hour, so "today's schedule" is populated whenever this runs. */
function todayAt(hour: number, minute = 0, dayOffset = 0): string {
  const d = new Date(NOW + dayOffset * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// ── environment ───────────────────────────────────────────────────────────────

/**
 * Load .env for a local run. Railway injects these; a laptop does not, and tsx —
 * unlike next dev — reads no env file of its own. Never overrides a variable that
 * is already set.
 */
function loadDotEnvIfPresent(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  return value && !value.startsWith("--") ? value : null;
}

/**
 * The demo password, from DEMO_PASSWORD or typed at the prompt. Deliberately not a
 * CLI flag: arguments end up in shell history and in `ps` output, and this password
 * gets pasted into Play Console where it lives indefinitely.
 */
function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error("No TTY to prompt on — set DEMO_PASSWORD in the environment instead."),
    );
  }

  return new Promise<string>((resolvePassword, reject) => {
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolvePassword(value);
          return;
        }
        if (ch === "") {
          finish();
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Ask twice and compare. A password typed once and never echoed is a password you
 * find out was mistyped at the sign-in screen, several minutes later, with no way
 * to tell a typo from a broken seed — which is exactly what happened the first
 * time this ran.
 */
async function promptForPassword(): Promise<string> {
  const fromEnv = process.env.DEMO_PASSWORD;
  if (fromEnv) return fromEnv;

  const first = await readPassword("Password for the demo account (not echoed): ");
  const second = await readPassword("Type it again to confirm: ");

  if (first !== second) {
    throw new Error("The two passwords do not match — nothing was changed. Run it again.");
  }

  log(`password accepted (${first.length} characters)`);
  return first;
}

// ── the invented customers ────────────────────────────────────────────────────

/**
 * Fictional throughout: 555-01xx is the reserved range that can never ring a real
 * phone, and example.com can never receive mail. If a reviewer taps "call" on a
 * demo contact, nothing happens to anybody.
 */
interface DemoContact {
  key: string;
  firstName: string;
  lastName: string;
  phone: string;
  stage: "lead" | "qualified" | "active" | "closed";
  boat: string;
  lengthFt: number;
  notes: string;
  createdDaysAgo: number;
}

const CONTACTS: DemoContact[] = [
  {
    key: "dana-whitfield",
    firstName: "Dana",
    lastName: "Whitfield",
    phone: "+15550100",
    stage: "lead",
    boat: "Sea Ray Sundancer 320",
    lengthFt: 32,
    notes: "Web enquiry: winter storage plus shrink wrap. Wants a price before the long weekend.",
    createdDaysAgo: 0,
  },
  {
    key: "marco-ferreira",
    firstName: "Marco",
    lastName: "Ferreira",
    phone: "+15550101",
    stage: "qualified",
    boat: "Grady-White Freedom 275",
    lengthFt: 27,
    notes: "Called about hull polish before the season. Keeps the boat at Harbour Point, slip 14.",
    createdDaysAgo: 2,
  },
  {
    key: "priya-raman",
    firstName: "Priya",
    lastName: "Raman",
    phone: "+15550102",
    stage: "active",
    boat: "Bayliner VR5",
    lengthFt: 21,
    notes: "Annual detail booked. Prefers texts, not calls.",
    createdDaysAgo: 9,
  },
  {
    key: "tom-beckett",
    firstName: "Tom",
    lastName: "Beckett",
    phone: "+15550103",
    stage: "active",
    boat: "Regal LS4",
    lengthFt: 24,
    notes: "Storage customer three seasons running. Pays the deposit the day the quote lands.",
    createdDaysAgo: 21,
  },
  {
    key: "helen-ost",
    firstName: "Helen",
    lastName: "Ost",
    phone: "+15550104",
    stage: "qualified",
    boat: "Pontoon — Sylvan Mirage 8520",
    lengthFt: 20,
    notes: "Pontoon, so the lift fee differs. Asked about a spring commissioning package.",
    createdDaysAgo: 4,
  },
  {
    key: "guy-lacombe",
    firstName: "Guy",
    lastName: "Lacombe",
    phone: "+15550105",
    stage: "lead",
    boat: "Boston Whaler Montauk 170",
    lengthFt: 17,
    notes: "Left a voicemail about bottom paint. Has not been called back yet.",
    createdDaysAgo: 1,
  },
  {
    key: "ruth-nakamura",
    firstName: "Ruth",
    lastName: "Nakamura",
    phone: "+15550106",
    stage: "active",
    boat: "Chaparral 250 Suncoast",
    lengthFt: 25,
    notes: "Detail finished last week. Asked for the before-and-after photos.",
    createdDaysAgo: 30,
  },
  {
    key: "owen-bradley",
    firstName: "Owen",
    lastName: "Bradley",
    phone: "+15550107",
    stage: "closed",
    boat: "Tracker Pro Team 175",
    lengthFt: 17,
    notes: "Went with a yard closer to home. Worth a call next spring.",
    createdDaysAgo: 45,
  },
];

const contactEmail = (c: DemoContact): string =>
  `${c.firstName.toLowerCase()}.${c.lastName.toLowerCase()}@example.com`;

// ── the price list ────────────────────────────────────────────────────────────

/** Enough of a catalog that the quote builder prices real-looking work. */
const CATALOG: Array<Omit<Inserts<"service_catalog_items">, "company_id" | "organization_id">> = [
  {
    service_key: "outdoor_storage",
    label: "Outdoor winter storage (season)",
    pricing_type: "per_measure",
    rate_cents: 5000,
    minimum_cents: 75000,
    surcharge_eligible: true,
    sort_order: 0,
    description: "October to May, on the hard, blocked and tied down.",
  },
  {
    service_key: "indoor_storage",
    label: "Indoor heated storage (season)",
    pricing_type: "per_measure",
    rate_cents: 9500,
    minimum_cents: 150000,
    surcharge_eligible: true,
    sort_order: 1,
    description: "Heated building, October to May.",
  },
  {
    service_key: "shrink_wrap",
    label: "Shrink wrapping",
    pricing_type: "per_measure",
    rate_cents: 2500,
    minimum_cents: 37500,
    surcharge_eligible: true,
    sort_order: 2,
    description: "Vented cover, door zipped in.",
  },
  {
    service_key: "haul_and_launch",
    label: "Haul out and spring launch",
    pricing_type: "per_measure",
    rate_cents: 1800,
    minimum_cents: 35000,
    surcharge_eligible: true,
    sort_order: 3,
  },
  {
    service_key: "engine_winterize",
    label: "Engine winterization",
    pricing_type: "per_unit_declining",
    rate_cents: 29500,
    minimum_cents: 0,
    unit_label: "engine",
    additional_unit_multiplier: 0.7,
    max_quantity: 4,
    sort_order: 4,
    description: "Antifreeze, fogging, fuel stabiliser. Second engine at 70%.",
  },
  {
    service_key: "hull_polish",
    label: "Hull polish and wax",
    pricing_type: "per_measure",
    rate_cents: 3200,
    minimum_cents: 45000,
    sort_order: 5,
  },
  {
    service_key: "interior_detail",
    label: "Interior detail",
    pricing_type: "flat",
    rate_cents: 42500,
    minimum_cents: 0,
    sort_order: 6,
    description: "Vinyl, carpets, canvas, compartments.",
  },
  {
    service_key: "bottom_paint",
    label: "Bottom paint (one coat)",
    pricing_type: "per_measure",
    rate_cents: 4200,
    minimum_cents: 60000,
    sort_order: 7,
  },
  {
    service_key: "battery_service",
    label: "Battery removal and storage charge",
    pricing_type: "per_unit",
    rate_cents: 4500,
    minimum_cents: 0,
    unit_label: "battery",
    max_quantity: 6,
    sort_order: 8,
  },
  {
    service_key: "transport",
    label: "Trailer transport",
    pricing_type: "per_measure",
    rate_cents: 350,
    minimum_cents: 25000,
    unit_label: "km",
    sort_order: 9,
  },
];

// ── the drafted reply ─────────────────────────────────────────────────────────

/**
 * The shape `analyzeLead` returns, written by hand. The seed must not call the
 * Anthropic API: it would cost money on every run and would fail on a machine with
 * no key, which is exactly the machine someone seeds a demo org from.
 */
function leadAnalysisFor(contact: DemoContact, companyName: string): Json {
  const firstSlot = todayAt(9, 0, 2);
  const secondSlot = todayAt(13, 30, 3);

  return toJson({
    summary: `${contact.firstName} ${contact.lastName} asked about winter storage and shrink wrap for a ${contact.lengthFt} ft ${contact.boat}, and wants a price before the long weekend.`,
    intent: "Winter storage enquiry with a deadline",
    urgency: "high",
    fitScore: 0.82,
    suggestedStage: "qualified",
    suggestedActions: [
      "Send the storage + shrink wrap quote today",
      "Confirm the boat is on its own trailer",
      "Offer the two haul-out slots below",
    ],
    draftedEmail: {
      subject: `Winter storage for your ${contact.lengthFt}' ${contact.boat.split(" ")[0]}`,
      body:
        `Hi ${contact.firstName},\n\n` +
        `Thanks for getting in touch. For a ${contact.lengthFt}-footer, outdoor storage from ` +
        `October through May works out to $1,600 plus HST, and shrink wrapping is $800 on top ` +
        `of that. Both include the tie-down and a vented cover with a zip door.\n\n` +
        `I can get you hauled out on either of these:\n` +
        `  • Thursday morning, 9:00\n` +
        `  • Friday afternoon, 1:30\n\n` +
        `Say the word and I'll send the quote over so you can lock the spot in with a deposit.\n\n` +
        `— ${companyName}`,
    },
    draftedSms:
      `Hi ${contact.firstName} — ${companyName} here. Winter storage for your ${contact.lengthFt}' ` +
      `is $1,600 + HST, shrink wrap $800. I have Thursday 9am or Friday 1:30pm for the haul-out. ` +
      `Want me to send the quote?`,
    proposedSlots: [
      { startsAt: firstSlot, durationMinutes: 90, reason: "First open haul-out slot this week." },
      { startsAt: secondSlot, durationMinutes: 90, reason: "Alternative if mornings do not suit." },
    ],
  });
}

// ── the seed ──────────────────────────────────────────────────────────────────

type Admin = ReturnType<typeof createSupabaseAdminClient>;

/**
 * Create the reviewer's account, or reset its password if it already exists, and
 * return the profile id. The profile row itself is created by the on_auth_user_created
 * trigger; this only fills in the fields the trigger cannot know.
 */
async function ensureDemoUser(admin: Admin, email: string, password: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Demo Account" },
  });

  if (created.data.user) {
    log(`created auth user ${email}`);
    return created.data.user.id;
  }

  // Already registered: find it and reset the password to the one supplied now, so
  // the credentials in Play Console can be re-synced by re-running this.
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;

    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) {
      const { error: updateError } = await admin.auth.admin.updateUserById(match.id, {
        password,
        email_confirm: true,
      });
      if (updateError) throw updateError;
      log(`reset the password on the existing auth user ${email}`);
      return match.id;
    }

    if (data.users.length < 200) break;
  }

  throw created.error ?? new Error(`Could not create or find an auth user for ${email}.`);
}

/** Wipe what this seed previously created in the demo org. Never touches other orgs. */
async function resetDemoData(admin: Admin, organizationId: string): Promise<void> {
  const tables = [
    "ai_drafts",
    "message_log",
    "quote_events",
    "quotes",
    "tasks",
    "bookings",
    "workflow_runs",
    "activity_events",
    "contact_read_state",
    "contacts",
    "service_catalog_items",
  ] as const;

  for (const table of tables) {
    const { error } = await admin.from(table).delete().eq("organization_id", organizationId);
    if (error) throw error;
  }
  log("cleared the demo organization's previous seed data");
}

async function main(): Promise<number> {
  loadDotEnvIfPresent();

  const email = flag("email");
  if (!email) {
    console.error(
      "Usage: npm run job:seed-demo -- --email demo@empirevu.com [--org-slug empirevu-demo] [--reset]",
    );
    return 1;
  }

  const orgSlug = flag("org-slug") ?? DEFAULT_ORG_SLUG;
  if (!orgSlug.includes("demo")) {
    // A typo'd slug here would write invented customers into a live tenant.
    console.error(
      `Refusing to seed "${orgSlug}": the demo org's slug must contain "demo" so this can never ` +
        "be pointed at a real organization by mistake.",
    );
    return 1;
  }

  const password = await promptForPassword();
  if (password.length < 12) {
    console.error("That password is under 12 characters. Play stores it indefinitely — use a long one.");
    return 1;
  }

  const admin = createSupabaseAdminClient();
  const profileId = await ensureDemoUser(admin, email, password);

  // ── organization ───────────────────────────────────────────────────────────
  const organizationId = demoId("organization");
  {
    const { error } = await admin.from("organizations").upsert(
      {
        id: organizationId,
        name: "EmpireVu Demo",
        slug: orgSlug,
        billing_email: email,
        created_by: profileId,
        // 'operate' is a real plan on organizations_plan_check, and it unlocks the
        // workflows and sequences a reviewer needs to see. 'pro' is not a plan here.
        plan: "operate",
        subscription_status: "active",
      } satisfies Inserts<"organizations">,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  {
    const { error } = await admin
      .from("profiles")
      .update({ full_name: "Demo Account", default_organization_id: organizationId })
      .eq("id", profileId);
    if (error) throw error;
  }

  {
    const { error } = await admin.from("organization_memberships").upsert(
      {
        id: demoId("membership"),
        organization_id: organizationId,
        profile_id: profileId,
        role: "owner",
      } satisfies Inserts<"organization_memberships">,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  if (process.argv.includes("--reset")) {
    await resetDemoData(admin, organizationId);
  }

  const ctx: TenantServiceContext = { organizationId, actorProfileId: profileId, supabase: admin };

  // ── company ────────────────────────────────────────────────────────────────
  // Through createCompany, so the demo org gets the same starter automations a real
  // one does — which is also what gives the automation tile something to count.
  const { data: existingCompany, error: companyLookupError } = await admin
    .from("companies")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", COMPANY_SLUG)
    .maybeSingle();
  if (companyLookupError) throw companyLookupError;

  const companyId =
    existingCompany?.id ??
    (await createCompany(ctx, { name: COMPANY_NAME, slug: COMPANY_SLUG, stage: "active" })).id;

  {
    const { error } = await admin
      .from("companies")
      .update({
        name: COMPANY_NAME,
        stage: "active",
        timezone: TIMEZONE,
        service_area: "Georgian Bay and the Severn waterway",
        owner_email: email,
        brand_from_name: COMPANY_NAME,
        brand_reply_email: email,
        brand_primary_color: "#0C4A6E",
        quote_terms_text:
          "A 25% deposit holds the spot. Balance is due on completion. Cancellations inside 7 days forfeit the deposit.",
        cancellation_policy_text: "Free to reschedule up to 48 hours before the booked time.",
        hours: toJson({
          mon: "08:00-17:00",
          tue: "08:00-17:00",
          wed: "08:00-17:00",
          thu: "08:00-17:00",
          fri: "08:00-16:00",
          sat: "09:00-13:00",
          sun: "closed",
        }),
      })
      .eq("id", companyId);
    if (error) throw error;
  }

  {
    const { error } = await admin.from("company_memberships").upsert(
      {
        id: demoId("company-membership"),
        organization_id: organizationId,
        company_id: companyId,
        profile_id: profileId,
        role: "lead",
      } satisfies Inserts<"company_memberships">,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  // ── price list ─────────────────────────────────────────────────────────────
  {
    // Every row carries every column, defaults included. A multi-row upsert aligns
    // its columns across the whole batch, so a key present on one row and absent on
    // another is sent as NULL for the others — which is how an omitted
    // `surcharge_eligible` became a not-null violation rather than a default.
    const rows = CATALOG.map((item) => ({
      ...item,
      id: demoId(`catalog:${item.service_key}`),
      company_id: companyId,
      organization_id: organizationId,
      active: true,
      description: item.description ?? null,
      unit_label: item.unit_label ?? null,
      additional_unit_multiplier: item.additional_unit_multiplier ?? null,
      max_quantity: item.max_quantity ?? null,
      max_measure: item.max_measure ?? null,
      tiers: item.tiers ?? null,
      rate_bands: item.rate_bands ?? null,
      modifier_groups: item.modifier_groups ?? null,
      review_rules: item.review_rules ?? null,
      surcharge_eligible: item.surcharge_eligible ?? false,
      sort_order: item.sort_order ?? 0,
      minimum_cents: item.minimum_cents ?? 0,
    }));
    const { error } = await admin
      .from("service_catalog_items")
      .upsert(rows, { onConflict: "company_id,service_key" });
    if (error) throw error;
    log(`price list: ${rows.length} services`);
  }

  // ── customers ──────────────────────────────────────────────────────────────
  const contactIds = new Map<string, string>();
  {
    const rows = CONTACTS.map((c) => {
      const id = demoId(`contact:${c.key}`);
      contactIds.set(c.key, id);
      return {
        id,
        organization_id: organizationId,
        company_id: companyId,
        first_name: c.firstName,
        last_name: c.lastName,
        email: contactEmail(c),
        phone: c.phone,
        stage: c.stage,
        notes: c.notes,
        owner_profile_id: profileId,
        created_at: daysAgo(c.createdDaysAgo),
        sms_consent_at: daysAgo(c.createdDaysAgo),
        consent_source: "demo_seed",
        metadata: toJson({ boat: c.boat, lengthFt: c.lengthFt, demo: true }),
      } satisfies Inserts<"contacts">;
    });

    const { error } = await admin.from("contacts").upsert(rows, { onConflict: "id" });
    if (error) throw error;
    log(`customers: ${rows.length} (all invented — 555-01xx numbers, example.com addresses)`);
  }

  const contactId = (key: string): string => {
    const id = contactIds.get(key);
    if (!id) throw new Error(`Unknown demo contact "${key}".`);
    return id;
  };

  // ── the day's schedule ─────────────────────────────────────────────────────
  {
    const rows: Inserts<"bookings">[] = [
      {
        id: demoId("booking:priya-detail"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("priya-raman"),
        title: "Full detail — Bayliner VR5",
        description: "Wash, compound, wax, interior. Customer prefers a text when it's done.",
        scheduled_for: todayAt(8, 30),
        duration_minutes: 240,
        status: "confirmed",
        created_by: profileId,
      },
      {
        id: demoId("booking:tom-haulout"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("tom-beckett"),
        title: "Haul out and block — Regal LS4",
        description: "Trailer is in the yard. Shrink wrap booked for Thursday.",
        scheduled_for: todayAt(13, 0),
        duration_minutes: 120,
        status: "confirmed",
        created_by: profileId,
      },
      {
        id: demoId("booking:ruth-photos"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("ruth-nakamura"),
        title: "Pickup — Chaparral 250",
        description: "Customer collecting. Send the before-and-after photos.",
        scheduled_for: todayAt(16, 0),
        duration_minutes: 30,
        status: "pending",
        created_by: profileId,
      },
      {
        id: demoId("booking:helen-commissioning"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("helen-ost"),
        title: "Spring commissioning — Sylvan pontoon",
        description: "Pontoon lift fee applies.",
        scheduled_for: todayAt(9, 0, 1),
        duration_minutes: 180,
        status: "confirmed",
        created_by: profileId,
      },
      {
        id: demoId("booking:marco-polish"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("marco-ferreira"),
        title: "Hull polish — Grady-White 275",
        scheduled_for: todayAt(10, 30, 2),
        duration_minutes: 300,
        status: "confirmed",
        created_by: profileId,
      },
      {
        id: demoId("booking:ruth-detail-done"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("ruth-nakamura"),
        title: "Full detail — Chaparral 250",
        scheduled_for: todayAt(8, 0, -6),
        duration_minutes: 300,
        status: "completed",
        created_by: profileId,
      },
    ];

    const { error } = await admin.from("bookings").upsert(rows, { onConflict: "id" });
    if (error) throw error;
    log(`schedule: ${rows.length} bookings, three of them today`);
  }

  // ── tasks ──────────────────────────────────────────────────────────────────
  {
    const rows: Inserts<"tasks">[] = [
      {
        id: demoId("task:call-guy"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("guy-lacombe"),
        title: "Call Guy Lacombe back about bottom paint",
        description: "Voicemail yesterday afternoon. Quote the 17-footer at one coat.",
        due_at: todayAt(11, 0),
        priority: "high",
        status: "todo",
        assigned_to_profile_id: profileId,
        created_by: profileId,
      },
      {
        id: demoId("task:photos-ruth"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("ruth-nakamura"),
        booking_id: demoId("booking:ruth-photos"),
        title: "Send Ruth the before-and-after photos",
        due_at: todayAt(15, 30),
        priority: "medium",
        status: "todo",
        assigned_to_profile_id: profileId,
        created_by: profileId,
      },
      {
        id: demoId("task:quote-dana"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("dana-whitfield"),
        title: "Send Dana the storage + shrink wrap quote",
        description: "Wants it before the long weekend.",
        due_at: todayAt(17, 0),
        priority: "urgent",
        status: "in_progress",
        assigned_to_profile_id: profileId,
        created_by: profileId,
      },
      {
        id: demoId("task:order-wrap"),
        organization_id: organizationId,
        company_id: companyId,
        title: "Order another roll of shrink wrap",
        description: "Two rolls left; the storage bookings need six.",
        due_at: todayAt(9, 0, 3),
        priority: "medium",
        status: "todo",
        assigned_to_profile_id: profileId,
        created_by: profileId,
      },
      {
        id: demoId("task:helen-lift"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("helen-ost"),
        title: "Confirm the pontoon lift straps are free Thursday",
        due_at: todayAt(14, 0, 1),
        priority: "low",
        status: "blocked",
        assigned_to_profile_id: profileId,
        created_by: profileId,
      },
      {
        id: demoId("task:tom-invoice"),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId("tom-beckett"),
        title: "Invoice Tom for the balance after haul-out",
        due_at: daysAgo(1),
        priority: "medium",
        status: "completed",
        assigned_to_profile_id: profileId,
        created_by: profileId,
      },
    ];

    const { error } = await admin.from("tasks").upsert(rows, { onConflict: "id" });
    if (error) throw error;
    log(`tasks: ${rows.length}`);
  }

  // ── the inbox ──────────────────────────────────────────────────────────────
  // needs_reply is "the newest message is inbound", so the three conversations that
  // end on an inbound line are the ones the inbox will sort to the top.
  {
    const message = (
      key: string,
      contactKey: string,
      channel: "sms" | "email",
      direction: "inbound" | "outbound",
      body: string,
      createdAt: string,
      subject?: string,
    ): Inserts<"message_log"> => ({
      id: demoId(`message:${key}`),
      organization_id: organizationId,
      company_id: companyId,
      contact_id: contactId(contactKey),
      channel,
      direction,
      status: direction === "inbound" ? "received" : "sent",
      body,
      subject: subject ?? null,
      from_addr: direction === "inbound" ? "customer" : COMPANY_NAME,
      to_addr: direction === "inbound" ? COMPANY_NAME : "customer",
      provider: "demo",
      created_at: createdAt,
    });

    const rows: Inserts<"message_log">[] = [
      // Waiting on a reply.
      message(
        "dana-1",
        "dana-whitfield",
        "email",
        "inbound",
        "Hi — what would winter storage and shrink wrap cost for a 32' Sundancer? Hoping to sort it before the long weekend.",
        hoursAgo(3),
        "Winter storage enquiry",
      ),
      message(
        "guy-1",
        "guy-lacombe",
        "sms",
        "inbound",
        "Left a voicemail earlier — after a price on bottom paint for a 17' Montauk. Thanks, Guy",
        hoursAgo(20),
      ),
      message(
        "helen-1",
        "helen-ost",
        "sms",
        "outbound",
        "Hi Helen — Thursday 9am works for the commissioning. I'll have the lift ready.",
        daysAgo(2),
      ),
      message(
        "helen-2",
        "helen-ost",
        "sms",
        "inbound",
        "Perfect. One more thing — can you check the bimini zips while it's in the shop?",
        minutesAgo(40),
      ),
      // Answered.
      message(
        "priya-1",
        "priya-raman",
        "sms",
        "inbound",
        "Are you still able to do the detail this week?",
        daysAgo(3),
      ),
      message(
        "priya-2",
        "priya-raman",
        "sms",
        "outbound",
        "We are — you're booked for Tuesday 8:30. I'll text you when she's done.",
        daysAgo(3),
      ),
      message(
        "tom-1",
        "tom-beckett",
        "email",
        "outbound",
        "Hi Tom — quote for storage and winterization attached. Deposit link is at the bottom.",
        daysAgo(5),
        "Your winter storage quote",
      ),
      message(
        "tom-2",
        "tom-beckett",
        "email",
        "inbound",
        "Approved and deposit paid. See you at the ramp.",
        daysAgo(4),
        "Re: Your winter storage quote",
      ),
      message(
        "tom-3",
        "tom-beckett",
        "sms",
        "outbound",
        "Got it, thanks Tom. Haul-out is booked for 1pm today.",
        daysAgo(4),
      ),
      message(
        "ruth-1",
        "ruth-nakamura",
        "sms",
        "inbound",
        "She looks brand new — thank you! Could you send the photos you took?",
        daysAgo(1),
      ),
      message(
        "ruth-2",
        "ruth-nakamura",
        "sms",
        "outbound",
        "Will do — sending them this afternoon.",
        hoursAgo(22),
      ),
      message(
        "marco-1",
        "marco-ferreira",
        "sms",
        "inbound",
        "Can you polish the hull before the season? Slip 14 at Harbour Point.",
        daysAgo(2),
      ),
      message(
        "marco-2",
        "marco-ferreira",
        "sms",
        "outbound",
        "Yes — I have Wednesday 10:30 open. Shall I book it?",
        daysAgo(2),
      ),
      message(
        "owen-1",
        "owen-bradley",
        "email",
        "inbound",
        "Thanks for the quote — going with a yard closer to home this year.",
        daysAgo(40),
        "Re: Your quote",
      ),
    ];

    const { error } = await admin.from("message_log").upsert(rows, { onConflict: "id" });
    if (error) throw error;
    log(`inbox: ${rows.length} messages, three conversations waiting on a reply`);
  }

  // ── a lead with a drafted reply ────────────────────────────────────────────
  {
    const dana = CONTACTS.find((c) => c.key === "dana-whitfield");
    const guy = CONTACTS.find((c) => c.key === "guy-lacombe");
    if (!dana || !guy) throw new Error("Demo contact list changed — drafts refer to missing keys.");

    const draft = (contact: DemoContact): Inserts<"ai_drafts"> => {
      const analysis = leadAnalysisFor(contact, COMPANY_NAME);
      const parsed = analysis as unknown as {
        draftedEmail: { subject: string; body: string };
        draftedSms: string;
        proposedSlots: unknown;
      };
      return {
        id: demoId(`draft:${contact.key}`),
        organization_id: organizationId,
        company_id: companyId,
        contact_id: contactId(contact.key),
        analysis,
        email_subject: parsed.draftedEmail.subject,
        email_body: parsed.draftedEmail.body,
        sms_body: parsed.draftedSms,
        proposed_slots: toJson(parsed.proposedSlots),
        email_status: "draft",
        sms_status: "draft",
        created_by: null,
        created_at: hoursAgo(2),
      };
    };

    const { error } = await admin
      .from("ai_drafts")
      .upsert([draft(dana), draft(guy)], { onConflict: "id" });
    if (error) throw error;
    log("drafts: two leads have a reply waiting for review");
  }

  // ── quotes ─────────────────────────────────────────────────────────────────
  // Priced through the real pricing path, so the totals are the ones the app would
  // compute. Previous seed quotes are removed first: createQuote allocates its own id.
  {
    const { error: clearError } = await admin
      .from("quotes")
      .delete()
      .eq("organization_id", organizationId)
      .eq("source", QUOTE_SOURCE);
    if (clearError) throw clearError;

    const danaQuote = await createQuote(ctx, {
      companyId,
      contactId: contactId("dana-whitfield"),
      title: "Winter storage — Sea Ray Sundancer 320",
      source: QUOTE_SOURCE,
      services: [
        { serviceId: "outdoor_storage", lengthFt: 32 },
        { serviceId: "shrink_wrap", lengthFt: 32 },
        { serviceId: "engine_winterize", quantity: 2, optional: true, selected: true },
        { serviceId: "battery_service", quantity: 2, optional: true, selected: false },
      ],
    });

    const marcoQuote = await createQuote(ctx, {
      companyId,
      contactId: contactId("marco-ferreira"),
      title: "Hull polish — Grady-White Freedom 275",
      source: QUOTE_SOURCE,
      services: [
        { serviceId: "hull_polish", lengthFt: 27 },
        { serviceId: "interior_detail", optional: true, selected: true },
      ],
    });

    const tomQuote = await createQuote(ctx, {
      companyId,
      contactId: contactId("tom-beckett"),
      title: "Winter storage and winterization — Regal LS4",
      source: QUOTE_SOURCE,
      services: [
        { serviceId: "indoor_storage", lengthFt: 24 },
        { serviceId: "engine_winterize", quantity: 1 },
        { serviceId: "haul_and_launch", lengthFt: 24 },
      ],
    });

    // A quote gets its number when it is sent, so a seeded quote that skipped the
    // send path shows "Draft" where the number belongs — on the paid one too.
    const quoteNumber = async (): Promise<string> => {
      const { data, error } = await admin.rpc("next_quote_number", {
        p_organization_id: organizationId,
      });
      if (error) throw error;
      if (!data) throw new Error("next_quote_number returned no value.");
      return data;
    };

    // Dana's is still a draft. Marco's has been sent and viewed; Tom's is approved
    // with the deposit paid, which is what puts a number on the money screens.
    const { error: sentError } = await admin
      .from("quotes")
      .update({
        status: "viewed",
        quote_number: await quoteNumber(),
        sent_at: daysAgo(2),
        first_viewed_at: daysAgo(1),
      })
      .eq("id", marcoQuote.id);
    if (sentError) throw sentError;

    const { error: approvedError } = await admin
      .from("quotes")
      .update({
        // What checkout.ts sets once Stripe confirms the deposit.
        status: "deposit_paid",
        quote_number: await quoteNumber(),
        sent_at: daysAgo(5),
        first_viewed_at: daysAgo(5),
        approved_at: hoursAgo(26),
        approved_by_name: "Tom Beckett",
        approved_line_items: tomQuote.line_items as Json,
        approved_subtotal_cents: tomQuote.subtotal_cents,
        approved_tax_cents: tomQuote.tax_cents,
        approved_total_cents: tomQuote.total_cents,
        approved_deposit_cents: tomQuote.deposit_cents,
        // Today, so "Revenue today" on the Command Center is a real number.
        deposit_paid_at: hoursAgo(3),
        terms_accepted: true,
      })
      .eq("id", tomQuote.id);
    if (approvedError) throw approvedError;

    log(
      `quotes: draft $${(danaQuote.total_cents / 100).toFixed(2)}, ` +
        `viewed $${(marcoQuote.total_cents / 100).toFixed(2)}, ` +
        `approved $${(tomQuote.total_cents / 100).toFixed(2)} with deposit paid`,
    );
  }

  // ── automation history ─────────────────────────────────────────────────────
  // The automation tile counts completed workflow runs and the time they saved. With
  // no history it reads zero on every screenshot, which says nothing about the product.
  {
    const { data: workflows, error: workflowError } = await admin
      .from("workflows")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("company_id", companyId)
      .limit(4);
    if (workflowError) throw workflowError;

    if (!workflows || workflows.length === 0) {
      log("automation: no workflows on the demo company — skipping run history");
    } else {
      const rows: Inserts<"workflow_runs">[] = [];
      for (let i = 0; i < 28; i += 1) {
        const workflow = workflows[i % workflows.length];
        if (!workflow) continue;
        const at = daysAgo(i * 1.1);
        rows.push({
          id: demoId(`workflow-run:${i}`),
          organization_id: organizationId,
          company_id: companyId,
          workflow_id: workflow.id,
          status: "completed",
          started_at: at,
          completed_at: at,
          created_at: at,
          actions_executed_count: 2,
          created_tasks_count: i % 3 === 0 ? 1 : 0,
          time_saved_seconds: 240,
        });
      }

      const { error } = await admin.from("workflow_runs").upsert(rows, { onConflict: "id" });
      if (error) throw error;
      log(`automation: ${rows.length} completed runs over the last month`);
    }
  }

  log("");
  log(`Demo organization ready: "EmpireVu Demo" (${orgSlug}), company "${COMPANY_NAME}".`);
  log(`Sign in as ${email} with the password you just supplied.`);
  log("Give those credentials to Play Console (App content → App access) and App Store Connect.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[seed-demo-org] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
