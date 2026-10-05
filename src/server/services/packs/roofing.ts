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

/** Roofing — replacement, repair, eavestrough and emergency leaks. No prices: the owner enters their own. */
export const roofingPack: IndustryPack = {
  id: "roofing",
  version: 1,
  name: "Roofing",
  tagline: "Shingle and metal roofs, repairs, leaks, eavestrough and soffit.",
  description:
    "For roofers doing replacements, repairs and eavestrough work. Sets up services measured by the square and the foot, inspection booking, and a receptionist that treats a leak as urgent.",
  services: [
    {
      key: "roof_inspection",
      label: "Roof inspection and estimate",
      unit: "visit",
      pricingType: "flat",
      category: "Inspections",
      description: "We get up on the roof, check shingles, flashing, vents and the deck from the attic, and send photos with the quote.",
    },
    {
      key: "shingle_replacement",
      label: "Asphalt shingle roof replacement",
      unit: "square",
      pricingType: "per_measure",
      category: "Replacement",
      description: "Tear-off, deck inspection, ice and water shield, underlayment and new architectural shingles. One square is 100 sq ft.",
    },
    {
      key: "metal_roof_install",
      label: "Metal roof installation",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Replacement",
      description: "Standing seam or steel panel roofing that sheds snow and lasts for decades.",
    },
    {
      key: "flat_roof",
      label: "Flat or low-slope roof",
      unit: "sq ft",
      pricingType: "per_measure",
      category: "Replacement",
      description: "Membrane roofing for flat and low-slope sections, garages and additions.",
    },
    {
      key: "roof_repair",
      label: "Roof repair",
      unit: "hour",
      pricingType: "per_unit",
      category: "Repairs",
      description: "Replacing missing or damaged shingles, resealing vents and fixing small problem areas.",
    },
    {
      key: "emergency_leak_tarp",
      label: "Emergency leak repair or tarping",
      unit: "visit",
      pricingType: "flat",
      category: "Repairs",
      description: "Same-day or next-day response to stop active leaks and protect the home until a permanent repair.",
    },
    {
      key: "flashing_chimney",
      label: "Chimney and flashing repair",
      unit: "visit",
      pricingType: "flat",
      category: "Repairs",
      description: "Re-flashing chimneys, skylights and walls where most leaks start.",
    },
    {
      key: "skylight",
      label: "Skylight replacement",
      unit: "skylight",
      pricingType: "per_unit",
      category: "Repairs",
      description: "Removing old skylights and installing new ones with proper flashing kits.",
    },
    {
      key: "ice_dam_removal",
      label: "Ice dam removal",
      unit: "hour",
      pricingType: "per_unit",
      category: "Winter",
      description: "Steaming away ice dams safely, without damaging shingles, to stop water backing up under the roof.",
    },
    {
      key: "eavestrough_install",
      label: "Eavestrough installation",
      unit: "ft",
      pricingType: "per_measure",
      category: "Eavestrough & soffit",
      description: "Seamless aluminium eavestrough and downspouts, sized and sloped to move water away from the house.",
    },
    {
      key: "eavestrough_cleaning",
      label: "Eavestrough cleaning",
      unit: "visit",
      pricingType: "flat",
      category: "Eavestrough & soffit",
      description: "Eavestroughs and downspouts cleared and flushed, with a quick check of the roof edge.",
    },
    {
      key: "soffit_fascia",
      label: "Soffit and fascia",
      unit: "ft",
      pricingType: "per_measure",
      category: "Eavestrough & soffit",
      description: "Vented aluminium soffit and fascia wrap to protect the roof edge and keep the attic breathing.",
    },
  ],
  recipes: [
    singleText(
      "missed-call-text-back",
      "Hi {{contact.first_name}}, it's {{company.name}}. Sorry we missed your call! If water is coming in, reply LEAK with your address and we'll call you right back. To book a roof inspection: {{company.booking_url}}",
    ),
    quoteFollowUp(
      "Hi {{contact.first_name}}, {{company.name}} here. Just checking you got your roofing quote ({{quote.subtotal}} + HST). Approve it here to get on our install schedule: {{quote.public_url}} Questions about materials or timing? Just reply.",
      "Hi {{contact.first_name}},\n\nFollowing up on the roofing quote we sent: {{quote.public_url}}\n\nRoofing season books up and weather can push dates, so approving early gets you the best choice of install days. If you have questions about shingle colours, warranty or timing, just reply.\n\nThanks,\n{{company.name}}",
    ),
    bookingReminder(
      "Hi {{contact.first_name}}, a reminder from {{company.name}}: we're booked at your home on {{booking.scheduled_for | date}}. Please keep the driveway clear for our truck. Confirm or change it here: {{booking.manage_url}}",
      "{{company.name}} here. We'll be at your home in about 2 hours ({{booking.scheduled_for | time}}). See you soon, {{contact.first_name}}!",
    ),
    reviewRequest(
      "Thanks for choosing {{company.name}}, {{contact.first_name}}! If you're happy with your roof, a quick review helps a local crew a lot: {{company.review_url}}",
    ),
    singleText(
      "no-show-recovery",
      "Hi {{contact.first_name}}, {{company.name}} here. We missed you for your appointment today. No worries, pick a new time here: {{company.booking_url}} or reply and we'll sort it out.",
    ),
    staleLeadNudge(3),
    ...tradeQuoteRecipes(),
    ...OWNER_ALERT_RECIPES,
  ],
  reviewRequest: { delay: "3d" },
  receptionist: {
    businessSummary:
      "This is a roofing company: asphalt shingle and metal roof replacements, repairs, emergency leaks, flat roofs, eavestrough, soffit and fascia.",
    seasonalNotes: [
      "Replacement season runs from about April to November; the schedule books weeks ahead in late summer and fall.",
      "After wind storms and heavy rain, expect calls about missing shingles and leaks. Treat any active leak as urgent.",
      "In winter, ice dams and leaks from snow melt are the main calls. Replacements are rare until spring, but inspections and quotes still happen.",
    ],
    qualifyingQuestions: [
      "What's the address of the home or building?",
      "Is this a full replacement, a repair, or is water coming in right now?",
      "What's on the roof now — asphalt shingles, metal, or a flat roof — and roughly how old is it?",
      "Is it a one-storey or two-storey home?",
      "Is it an insurance claim?",
      "What's the best number and email to send the quote to?",
    ],
    urgentKeywords: [
      "roof leak",
      "water coming in",
      "dripping from the ceiling",
      "ceiling stain spreading",
      "tree on the roof",
      "shingles blew off",
      "storm damage",
      "ice dam",
    ],
    faqs: [
      {
        question: "How much is a new roof?",
        answer:
          "It depends on the size and pitch of the roof, layers to remove and materials. Offer a free inspection so the owner can measure and send a written quote. Never guess a price.",
      },
      {
        question: "How long does a replacement take?",
        answer: "Most homes take one to two days once the crew starts, weather permitting. The owner confirms timing with the quote.",
      },
      {
        question: "Do you offer a warranty?",
        answer: "Say the owner will go over workmanship and manufacturer warranties with the quote.",
      },
      {
        question: "Can you help with an insurance claim?",
        answer: "Yes. The crew can document the damage with photos for the adjuster. Take down the insurer's name if they have it.",
      },
      {
        question: "Do you clean up after?",
        answer: "Yes. Old roofing is hauled away and the yard is swept with a magnet for nails before the crew leaves.",
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
