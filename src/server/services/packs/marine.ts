import {
  bookingReminder,
  OWNER_ALERT_RECIPES,
  quoteFollowUp,
  reviewRequest,
  singleText,
  staleLeadNudge,
} from "@/server/services/packs/common";
import type { IndustryPack } from "@/server/services/packs/types";

/**
 * Marine — storage, shrink wrap, winterization, detailing. Mirrors A1 Marine Care's world:
 * the service keys match A1's catalog seeds (supabase/seeds/a1-care-*.sql), so applying the
 * pack to an A1-style company skips what it already has and Marina's phone quote finds
 * `shrink_wrap` by its usual key. No prices: the owner enters their own.
 *
 * The receptionist recipes (post-call quote text, pick-a-date nudge) already speak boats
 * (`{{quote.boat}}`), so this pack installs them unchanged.
 */
export const marinePack: IndustryPack = {
  id: "marine",
  version: 1,
  name: "Marine services",
  tagline: "Shrink wrap, winterization, storage, spring launch and detailing.",
  description:
    "For marinas and mobile boat-care businesses. Sets up the fall rush (shrink wrap, winterization, storage) and the spring jobs (commissioning, detailing, bottom paint), priced by the foot where it makes sense, with texts written for boat owners.",
  services: [
    {
      key: "shrink_wrap",
      label: "Mobile shrink wrap",
      unit: "ft",
      pricingType: "per_measure",
      category: "Fall",
      description: "We come to the boat on land: support frame, commercial heat-shrink film, vents and strapping, priced by boat length.",
    },
    {
      key: "winterization_outboard",
      label: "Winterization — outboard",
      unit: "engine",
      pricingType: "per_unit",
      category: "Fall",
      description: "Fuel stabilizer, fogging, lower-unit oil change and a full drain so the engine is ready for the freeze.",
    },
    {
      key: "winterization_sterndrive",
      label: "Winterization — sterndrive (I/O)",
      unit: "engine",
      pricingType: "per_unit",
      category: "Fall",
      description: "Fuel stabilizer, antifreeze through the cooling system, fogging, and drive service.",
    },
    {
      key: "winterization_inboard",
      label: "Winterization — inboard",
      unit: "engine",
      pricingType: "per_unit",
      category: "Fall",
      description: "Fuel stabilizer, antifreeze through the cooling system, fogging, and shaft and strut check.",
    },
    {
      key: "storage_outdoor",
      label: "Outdoor winter storage",
      unit: "ft",
      pricingType: "per_measure",
      category: "Storage",
      description: "Blocked and stored in a secure outdoor yard for the winter, priced by boat length.",
    },
    {
      key: "storage_indoor",
      label: "Indoor winter storage",
      unit: "ft",
      pricingType: "per_measure",
      category: "Storage",
      description: "Heated or cold indoor storage out of the snow and sun, priced by boat length.",
    },
    {
      key: "haul_out_launch",
      label: "Haul-out or launch",
      unit: "boat",
      pricingType: "flat",
      category: "Storage",
      description: "Pulling the boat in the fall or putting it back in the water in the spring.",
    },
    {
      key: "spring_commissioning",
      label: "Spring commissioning",
      unit: "engine",
      pricingType: "per_unit",
      category: "Spring",
      description: "De-winterizing, battery and fluid checks, and a test run so the boat is ready for the first long weekend.",
    },
    {
      key: "exterior_detailing",
      label: "Exterior detailing",
      unit: "ft",
      pricingType: "per_measure",
      category: "Detailing",
      description: "Wash, oxidation removal, polish and wax for the hull and topsides.",
    },
    {
      key: "interior_detailing",
      label: "Interior detailing",
      unit: "ft",
      pricingType: "per_measure",
      category: "Detailing",
      description: "Upholstery, carpets, compartments and vinyl cleaned and protected.",
    },
    {
      key: "bottom_painting",
      label: "Bottom painting",
      unit: "ft",
      pricingType: "per_measure",
      category: "Detailing",
      description: "Hull bottom prepped and coated with antifouling paint.",
    },
  ],
  recipes: [
    singleText(
      "missed-call-text-back",
      "Hi {{contact.first_name}}, it's {{company.name}}. Sorry we missed your call! Reply with your boat's length and where it's sitting and we'll call you back with a quote, or book here: {{company.booking_url}}",
    ),
    quoteFollowUp(
      "Hi {{contact.first_name}}, {{company.name}} here. Just checking you got your quote ({{quote.subtotal}} + HST). Fall spots fill up before freeze-up, so approve it here to hold yours: {{quote.public_url}} Questions? Just reply.",
      "Hi {{contact.first_name}},\n\nFollowing up on the quote we sent: {{quote.public_url}}\n\nOur fall schedule fills up before freeze-up, so approving early gets your boat on the list. If anything about your boat has changed — length, engine, where it's stored — just reply and we'll update it.\n\nThanks,\n{{company.name}}",
    ),
    bookingReminder(
      "Hi {{contact.first_name}}, a reminder from {{company.name}}: we're booked for your boat on {{booking.scheduled_for | date}}. Please make sure we can get to it and the cover is off. Reply if you need to change it.",
      "{{company.name}} here. We'll be at your boat in about 2 hours ({{booking.scheduled_for | time}}). See you soon, {{contact.first_name}}!",
    ),
    reviewRequest(
      "Thanks for choosing {{company.name}}, {{contact.first_name}}! If your boat's in good hands, a quick review helps a local marine business a lot: {{company.review_url}}",
    ),
    singleText(
      "no-show-recovery",
      "Hi {{contact.first_name}}, {{company.name}} here. We couldn't get to your boat today. No worries, pick a new day here: {{company.booking_url}} or reply and we'll sort it out.",
    ),
    staleLeadNudge(3),
    { slug: "post-call-quote-text" },
    { slug: "deposit-paid-pick-date" },
    ...OWNER_ALERT_RECIPES,
  ],
  reviewRequest: { delay: "2d" },
  receptionist: {
    businessSummary:
      "This is a marine services business: shrink wrapping, winterization, winter storage, spring launch and commissioning, and boat detailing and bottom painting.",
    seasonalNotes: [
      "September to November is the fall rush: shrink wrap, winterization, haul-out and storage. Spots fill up before freeze-up, so get the boat details and book quickly.",
      "April to June is spring launch, commissioning, detailing and bottom paint. Everyone wants to be in the water for the May long weekend.",
      "In summer, callers want detailing, repairs and the odd emergency on the water.",
    ],
    qualifyingQuestions: [
      "What kind of boat is it, and how long is it in feet?",
      "What's the engine — outboard, sterndrive (I/O) or inboard — and how many?",
      "Where is the boat right now — on a trailer, at a marina, or at the cottage?",
      "Which services do you need: shrink wrap, winterization, storage, launch, detailing?",
      "What's the best number and email to send the quote to?",
    ],
    urgentKeywords: ["taking on water", "sinking", "bilge alarm", "boat is flooding", "cover blew off", "shrink wrap torn", "storm damage"],
    faqs: [
      {
        question: "How much is shrink wrap?",
        answer:
          "It's priced by the boat's length and type. Get the length and boat type and use the quote tool if it's available, otherwise say the owner will send a written quote. Never guess a price.",
      },
      {
        question: "Do you come to me?",
        answer: "Shrink wrap and winterization are done on site where the boat is stored on land. Take the address or marina name.",
      },
      {
        question: "When should I book?",
        answer: "As early as possible in the fall. The schedule fills up before freeze-up.",
      },
      {
        question: "Do you store boats?",
        answer: "Ask whether they want indoor or outdoor storage and take the boat's length so the owner can quote.",
      },
    ],
  },
  booking: {
    mode: "windows",
    windows: [
      { key: "morning", start: "09:00", durationMinutes: 180, spoken: "in the morning" },
      { key: "afternoon", start: "13:00", durationMinutes: 180, spoken: "in the afternoon" },
    ],
    capacityPerWindow: 2,
    leadTimeHours: 24,
    horizonDays: 21,
    workingDays: [1, 2, 3, 4, 5, 6],
  },
};
