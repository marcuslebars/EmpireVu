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

/** Landscaping — hardscape, softscape and maintenance. No prices: the owner enters their own. */
export const landscapingPack: IndustryPack = {
  id: "landscaping",
  version: 1,
  name: "Landscaping",
  tagline: "Interlock, retaining walls, sod, gardens and seasonal maintenance.",
  description:
    "For landscapers doing design-build and maintenance. Sets up hardscape and softscape services measured the way you quote them, site-visit booking, and a receptionist that asks about the yard before the owner drives out.",
  services: [
    {
      key: "site_visit_consult",
      label: "Site visit and design consultation",
      unit: "visit",
      pricingType: "flat",
      category: "Design",
      description: "We walk the property with you, take measurements and talk through ideas before putting a quote together.",
    },
    {
      key: "interlock_patio",
      label: "Interlock patio or walkway",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Hardscape",
      description: "Excavation, compacted base, and interlocking pavers laid and sealed with polymeric sand.",
    },
    {
      key: "interlock_driveway",
      label: "Interlock driveway",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Hardscape",
      description: "Driveway-grade base and pavers built to handle vehicles and our freeze-thaw winters.",
    },
    {
      key: "retaining_wall",
      label: "Retaining wall",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Hardscape",
      description: "Armour stone or segmental block walls with proper base and drainage, measured by face area.",
    },
    {
      key: "sod_installation",
      label: "Sod installation",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Softscape",
      description: "Old turf removed, grade prepared with topsoil, and fresh sod laid and rolled.",
    },
    {
      key: "garden_bed_install",
      label: "Garden bed design and planting",
      unit: "hour",
      pricingType: "per_unit",
      category: "Softscape",
      description: "New or refreshed garden beds: edging, soil, plants and finishing mulch.",
    },
    {
      key: "tree_shrub_planting",
      label: "Tree and shrub planting",
      unit: "plant",
      pricingType: "per_unit",
      category: "Softscape",
      description: "Planting trees and shrubs at the right depth, with soil amendment and a first watering.",
    },
    {
      key: "mulch_install",
      label: "Mulch delivery and spreading",
      unit: "cubic yard",
      pricingType: "per_unit",
      category: "Softscape",
      description: "Bed edges cleaned up and fresh mulch spread to keep weeds down and moisture in.",
    },
    {
      key: "lawn_maintenance_seasonal",
      label: "Lawn and garden maintenance — seasonal",
      unit: "season",
      pricingType: "flat",
      category: "Maintenance",
      description: "Weekly cutting, trimming and edging plus regular bed weeding from spring to fall.",
    },
    {
      key: "spring_fall_cleanup",
      label: "Spring or fall cleanup",
      unit: "visit",
      pricingType: "flat",
      category: "Maintenance",
      description: "Leaves and debris cleared from lawn and beds, perennials cut back, and yard waste hauled away.",
    },
    {
      key: "aeration_overseeding",
      label: "Aeration and overseeding",
      unit: "visit",
      pricingType: "flat",
      category: "Maintenance",
      description: "Core aeration followed by overseeding to thicken a tired or patchy lawn.",
    },
    {
      key: "hedge_trimming",
      label: "Hedge and shrub trimming",
      unit: "hour",
      pricingType: "per_unit",
      category: "Maintenance",
      description: "Hedges and shrubs shaped and cleaned up, with clippings removed.",
    },
  ],
  recipes: [
    singleText(
      "missed-call-text-back",
      "Hi {{contact.first_name}}, it's {{company.name}}. Sorry we missed your call! Reply with what you have in mind for your yard and we'll call you back, or book a site visit here: {{company.booking_url}}",
    ),
    quoteFollowUp(
      "Hi {{contact.first_name}}, {{company.name}} here. Just checking you got your quote ({{quote.subtotal}} + HST). Our build calendar fills up fast in the spring, so approve it here to hold your spot: {{quote.public_url}} Questions? Just reply.",
      "Hi {{contact.first_name}},\n\nFollowing up on the landscaping quote we sent: {{quote.public_url}}\n\nOur install schedule books up quickly, so approving early gets your project on the calendar. If you'd like to change anything — materials, layout, timing — just reply and we'll adjust it.\n\nThanks,\n{{company.name}}",
    ),
    bookingReminder(
      "Hi {{contact.first_name}}, a reminder from {{company.name}}: we're booked at your property on {{booking.scheduled_for | date}}. Please leave side gates unlocked and keep pets inside. Reply if you need to change it.",
      "{{company.name}} here. Our crew will be at your place in about 2 hours ({{booking.scheduled_for | time}}). See you soon, {{contact.first_name}}!",
    ),
    reviewRequest(
      "Thanks for choosing {{company.name}}, {{contact.first_name}}! We hope you're enjoying the yard. A quick review helps a local business a lot: {{company.review_url}}",
    ),
    singleText(
      "no-show-recovery",
      "Hi {{contact.first_name}}, {{company.name}} here. We missed you for your visit today. No worries, pick a new time here: {{company.booking_url}} or reply and we'll find one together.",
    ),
    staleLeadNudge(3),
    ...tradeQuoteRecipes(),
    ...OWNER_ALERT_RECIPES,
  ],
  reviewRequest: { delay: "3d" },
  receptionist: {
    businessSummary:
      "This is a landscaping company: interlock patios, walkways and driveways, retaining walls, sod, gardens and planting, plus seasonal lawn and garden maintenance.",
    seasonalNotes: [
      "Late winter and spring is when people plan projects; the build calendar fills up by May, so get callers booked for a site visit quickly.",
      "Maintenance contracts start in April and run until the fall cleanup in October and November.",
      "Hardscape work stops when the ground freezes, usually by early December. Winter callers can still book a spring site visit.",
    ],
    qualifyingQuestions: [
      "What's the property address?",
      "What kind of project is it — a patio, walkway, driveway, wall, lawn, gardens, or regular maintenance?",
      "Roughly how big is the area, if you know?",
      "When are you hoping to have it done?",
      "Do you have photos or a plan you can text or email us?",
      "What's the best number and email to reach you?",
    ],
    urgentKeywords: ["tree fell", "fallen tree", "flooding", "water in the basement", "washout", "sinkhole", "wall collapsed", "storm damage"],
    faqs: [
      {
        question: "How much does a patio cost?",
        answer:
          "It depends on size, materials and site access. Offer a site visit so the owner can measure and send a written quote. Never guess a price.",
      },
      {
        question: "How soon can you start?",
        answer: "Say the owner will confirm the schedule with the quote. Spring books up first, so earlier is better.",
      },
      {
        question: "Do you do design?",
        answer: "Yes. The site visit includes talking through ideas, and the quote lays out the plan.",
      },
      {
        question: "Do you offer weekly maintenance?",
        answer: "Yes: weekly lawn and garden care for the season, plus spring and fall cleanups.",
      },
      {
        question: "Do you call for utility locates?",
        answer: "Yes. Before any digging the crew arranges locates through Ontario One Call.",
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
    horizonDays: 30,
    workingDays: [1, 2, 3, 4, 5, 6],
  },
};
