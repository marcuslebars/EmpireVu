import {
  bookingReminder,
  OWNER_ALERT_RECIPES,
  quoteFollowUp,
  reviewRequest,
  singleText,
  staleLeadNudge,
  tradeQuoteRecipes,
} from "@/server/services/packs/common";
import type { IndustryPack } from "@/server/services/packs/types";

/** General contractor — renovations, additions, decks and repairs. No prices: the owner enters their own. */
export const generalContractorPack: IndustryPack = {
  id: "general-contractor",
  version: 1,
  name: "General contractor",
  tagline: "Renovations, basements, decks, flooring and repairs.",
  description:
    "For renovation and general contracting companies. Sets up consultation booking, project-type services, patient follow-ups for bigger decisions, and a receptionist that captures scope, budget range and timeline before the owner calls back.",
  services: [
    {
      key: "consultation",
      label: "In-home consultation and estimate",
      unit: "visit",
      pricingType: "flat",
      category: "Consultation",
      description: "We walk through the space with you, talk about what you want and measure up, then send a written estimate.",
    },
    {
      key: "kitchen_renovation",
      label: "Kitchen renovation",
      unit: "project",
      pricingType: "flat",
      category: "Renovations",
      description: "From cabinets and counters to full gut-and-rebuild, coordinated start to finish with our trades.",
    },
    {
      key: "bathroom_renovation",
      label: "Bathroom renovation",
      unit: "project",
      pricingType: "flat",
      category: "Renovations",
      description: "Tubs, showers, tile, vanities and fixtures, with waterproofing done right.",
    },
    {
      key: "basement_finishing",
      label: "Basement finishing",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Renovations",
      description: "Framing, insulation, drywall, flooring and lighting to turn an unfinished basement into living space.",
    },
    {
      key: "addition",
      label: "Addition or major remodel",
      unit: "project",
      pricingType: "flat",
      category: "Renovations",
      description: "Additions, layout changes and structural work, including drawings and permits.",
    },
    {
      key: "deck_build",
      label: "Deck building",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Outdoor",
      description: "Pressure-treated, cedar or composite decks built on proper footings, with railings and stairs.",
    },
    {
      key: "fence_build",
      label: "Fence building",
      unit: "ft",
      pricingType: "per_measure",
      category: "Outdoor",
      description: "Wood or composite privacy fences and gates, with post holes dug below frost line.",
    },
    {
      key: "flooring_install",
      label: "Flooring installation",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Interior",
      description: "Hardwood, vinyl plank, laminate and tile installed over properly prepared subfloors.",
    },
    {
      key: "drywall_painting",
      label: "Drywall repair and painting",
      unit: "hour",
      pricingType: "per_unit",
      category: "Interior",
      description: "Patching, taping and painting, from a single wall to a whole floor.",
    },
    {
      key: "windows_doors",
      label: "Window and door replacement",
      unit: "opening",
      pricingType: "per_unit",
      category: "Exterior",
      description: "Energy-efficient windows and exterior doors installed, insulated and trimmed.",
    },
    {
      key: "handyman_repairs",
      label: "Small repairs and handyman work",
      unit: "hour",
      pricingType: "per_unit",
      category: "Repairs",
      description: "The to-do list: doors that stick, trim, fixtures, small carpentry and odd jobs.",
    },
    {
      key: "permits_drawings",
      label: "Permits and drawings",
      unit: "project",
      pricingType: "flat",
      category: "Consultation",
      description: "Arranging drawings and building permits with the municipality when the project needs them.",
    },
  ],
  recipes: [
    singleText(
      "missed-call-text-back",
      "Hi {{contact.first_name}}, it's {{company.name}}. Sorry we missed your call! Reply with a few words about your project and we'll call you back, or book a consultation here: {{company.booking_url}}",
    ),
    quoteFollowUp(
      "Hi {{contact.first_name}}, {{company.name}} here. Just checking you got your estimate ({{quote.subtotal}} + HST). Happy to walk through it or adjust the scope. When you're ready, approve it here: {{quote.public_url}}",
      "Hi {{contact.first_name}},\n\nFollowing up on the estimate we sent: {{quote.public_url}}\n\nA renovation is a big decision, so if you'd like to change the scope, finishes or timing, just reply and we'll put together a revised version. Approving it locks in your spot on our schedule.\n\nThanks,\n{{company.name}}",
    ),
    bookingReminder(
      "Hi {{contact.first_name}}, a reminder from {{company.name}}: we're booked to see you on {{booking.scheduled_for | date}}. If you have photos, plans or inspiration, have them handy. Reply if you need to change it.",
      "{{company.name}} here. We'll see you in about 2 hours ({{booking.scheduled_for | time}}), {{contact.first_name}}. Reply if anything has come up.",
    ),
    reviewRequest(
      "Thanks for choosing {{company.name}}, {{contact.first_name}}! We hope you love the finished space. A quick review helps a local contractor a lot: {{company.review_url}}",
    ),
    singleText(
      "no-show-recovery",
      "Hi {{contact.first_name}}, {{company.name}} here. We missed you for today's appointment. No problem, pick a new time here: {{company.booking_url}} or reply and we'll find one.",
    ),
    staleLeadNudge(5),
    ...tradeQuoteRecipes(),
    ...OWNER_ALERT_RECIPES,
  ],
  reviewRequest: { delay: "5d" },
  receptionist: {
    businessSummary:
      "This is a general contracting and renovation company: kitchens, bathrooms, basements, additions, decks, fences, flooring, windows and doors, and smaller repairs.",
    seasonalNotes: [
      "Winter is busy with indoor work (basements, kitchens, bathrooms) and planning for spring.",
      "Spring and summer are deck, fence and exterior season; these book up early.",
      "Bigger projects may need drawings and a building permit, which adds time before work starts. Don't promise start dates.",
    ],
    qualifyingQuestions: [
      "What's the address of the property?",
      "What's the project — which rooms or areas, and roughly how big?",
      "When would you like the work done?",
      "Do you have a budget range in mind?",
      "Do you have plans, photos or inspiration you can send us?",
      "What's the best number and email to reach you?",
    ],
    urgentKeywords: ["water leak", "flooding", "ceiling came down", "structural damage", "storm damage", "broken window", "break-in", "unsafe"],
    faqs: [
      {
        question: "How much will my renovation cost?",
        answer:
          "Every project is different. Offer an in-home consultation so the owner can see the space and send a written estimate. Never guess a price.",
      },
      {
        question: "When can you start?",
        answer: "Say the owner will confirm the schedule with the estimate. Bigger jobs may need a permit first.",
      },
      {
        question: "Do you handle permits?",
        answer: "Yes. The company arranges drawings and permits when the project needs them.",
      },
      {
        question: "Are you insured?",
        answer: "Say the owner can provide proof of liability insurance and WSIB coverage with the estimate.",
      },
      {
        question: "Do you do small jobs?",
        answer: "Yes. Small repairs and handyman work can be booked by the hour. Take down the list of jobs.",
      },
    ],
  },
  booking: {
    mode: "windows",
    windows: [
      { key: "morning", start: "09:00", durationMinutes: 180, spoken: "in the morning" },
      { key: "afternoon", start: "13:00", durationMinutes: 180, spoken: "in the afternoon" },
    ],
    capacityPerWindow: 1,
    leadTimeHours: 48,
    horizonDays: 30,
    workingDays: [1, 2, 3, 4, 5],
  },
};
