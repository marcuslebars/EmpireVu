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

/**
 * Property maintenance & snow — the first CrankLeads trade (Georgian Bay / Simcoe County).
 * Winter is seasonal snow contracts (residential + commercial) and salting; the rest of
 * the year is lawn care and spring/fall cleanups. No prices: the owner enters their own.
 */
export const propertyMaintenanceSnowPack: IndustryPack = {
  id: "property-maintenance-snow",
  version: 1,
  name: "Property maintenance & snow",
  tagline: "Seasonal snow contracts, salting, lawn care and spring/fall cleanups.",
  description:
    "For crews that plow and salt in the winter and cut grass the rest of the year. Sets up seasonal and per-push snow services, salting, cleanups and lawn care, texts that sound like a local crew, and a receptionist that knows a missed plow is urgent.",
  services: [
    {
      key: "snow_seasonal_residential",
      label: "Seasonal snow contract — residential driveway",
      unit: "season",
      pricingType: "flat",
      category: "Snow & ice",
      description:
        "Plowing every time snowfall reaches the trigger depth in the contract, all winter long, including the end-of-driveway windrow.",
    },
    {
      key: "snow_seasonal_commercial",
      label: "Seasonal snow contract — commercial lot",
      unit: "season",
      pricingType: "flat",
      category: "Snow & ice",
      description:
        "Plowing a commercial lot or plaza all winter, with an agreed trigger depth and a clear-by time before the business opens.",
    },
    {
      key: "snow_per_push_residential",
      label: "Per-push plowing — residential",
      unit: "push",
      pricingType: "per_unit",
      category: "Snow & ice",
      description: "Pay each time the crew plows the driveway. Good for cottages and customers who are away part of the winter.",
    },
    {
      key: "snow_per_push_commercial",
      label: "Per-push plowing — commercial",
      unit: "push",
      pricingType: "per_unit",
      category: "Snow & ice",
      description: "Plowing a commercial lot billed per visit, for properties that don't want a seasonal contract.",
    },
    {
      key: "salting_residential",
      label: "Salting — driveway and walkway",
      unit: "application",
      pricingType: "per_unit",
      category: "Snow & ice",
      description: "Salt or ice melter on the driveway, walkway and steps after a storm or a freeze.",
    },
    {
      key: "salting_commercial",
      label: "Salting and sanding — commercial lot",
      unit: "application",
      pricingType: "per_unit",
      category: "Snow & ice",
      description: "Salting or sanding parking areas and entrances to keep customers and staff on their feet.",
    },
    {
      key: "walkway_shovelling",
      label: "Walkway and step shovelling",
      unit: "visit",
      pricingType: "per_unit",
      category: "Snow & ice",
      description: "Hand shovelling of front walks, steps and landings — add-on to plowing or on its own.",
    },
    {
      key: "roof_snow_removal",
      label: "Roof snow removal",
      unit: "hour",
      pricingType: "per_unit",
      category: "Snow & ice",
      description: "Clearing heavy snow load off roofs and decks to prevent ice dams and structural strain.",
    },
    {
      key: "fall_cleanup",
      label: "Fall cleanup",
      unit: "visit",
      pricingType: "flat",
      category: "Cleanups",
      description: "Leaves raked and removed from lawn and beds, a final cut, and yard waste hauled away before the snow flies.",
    },
    {
      key: "spring_cleanup",
      label: "Spring cleanup",
      unit: "visit",
      pricingType: "flat",
      category: "Cleanups",
      description: "Debris, sand and plow damage cleaned up, beds tidied and the lawn raked so it's ready for the season.",
    },
    {
      key: "lawn_care_seasonal",
      label: "Weekly lawn care — seasonal",
      unit: "season",
      pricingType: "flat",
      category: "Lawn care",
      description: "Weekly cutting, trimming and edging from spring to fall on one seasonal price.",
    },
    {
      key: "lawn_cut_single",
      label: "Lawn cutting — single cut",
      unit: "cut",
      pricingType: "per_unit",
      category: "Lawn care",
      description: "One-time or on-call lawn cut, trim and blow-off.",
    },
  ],
  recipes: [
    singleText(
      "missed-call-text-back",
      "Hi {{contact.first_name}}, it's {{company.name}}. Sorry we missed your call! If it's about a missed plow or an icy walkway, reply with your address and we'll get on it. For a snow contract or cleanup quote: {{company.booking_url}}",
    ),
    quoteFollowUp(
      "Hi {{contact.first_name}}, {{company.name}} here. Just checking you got your quote ({{quote.subtotal}} + HST). Snow routes fill up once the first storm hits, so approve it here to lock in your spot: {{quote.public_url}} Questions? Just reply.",
      "Hi {{contact.first_name}},\n\nFollowing up on the quote we sent: {{quote.public_url}}\n\nWe build our snow routes in the fall, so approving early guarantees your property is on one before the first storm. Happy to answer any questions — just reply to this email.\n\nThanks,\n{{company.name}}",
    ),
    bookingReminder(
      "Hi {{contact.first_name}}, a reminder from {{company.name}}: we're booked at your property on {{booking.scheduled_for | date}}. Please leave gates unlocked and move vehicles if you can. Reply if you need to change it.",
      "{{company.name}} here. Our crew will be at your property in about 2 hours ({{booking.scheduled_for | time}}). See you soon, {{contact.first_name}}!",
    ),
    reviewRequest(
      "Thanks for choosing {{company.name}}, {{contact.first_name}}! If we kept your property looking good, a quick review really helps a local crew: {{company.review_url}}",
    ),
    singleText(
      "no-show-recovery",
      "Hi {{contact.first_name}}, {{company.name}} here. Our crew couldn't get the work done at your property today. No problem, pick a new day here: {{company.booking_url}} or reply and we'll sort it out.",
    ),
    staleLeadNudge(2),
    ...tradeQuoteRecipes(),
    ...OWNER_ALERT_RECIPES,
  ],
  reviewRequest: { delay: "2d" },
  receptionist: {
    businessSummary:
      "This is a property maintenance company: snow plowing, salting and shovelling in the winter, and lawn care plus spring and fall cleanups the rest of the year, for homes, cottages and commercial properties.",
    seasonalNotes: [
      "October to December is snow-contract season. Most callers want a seasonal price for the winter, and routes fill up, so take the address and details so the owner can quote quickly.",
      "During and after a storm, existing customers call about a missed or late plow. Treat those calls as urgent: get the address, apologise, and tell them the crew is being told right away.",
      "April and May are spring cleanup and lawn-care sign-ups; October and November are fall leaf cleanups.",
    ],
    qualifyingQuestions: [
      "What's the property address, and is it a home, a cottage or a commercial property?",
      "For snow: roughly how big is the driveway or lot — how many cars does it fit?",
      "Are you looking for a seasonal contract or pay-per-push?",
      "Do you need walkways, steps or salting as well as plowing?",
      "Anything we should know about access — a gate, parked cars, a steep or shared driveway?",
      "What's the best number and email to send the quote to?",
    ],
    urgentKeywords: [
      "plow didn't come",
      "missed my driveway",
      "snowed in",
      "can't get out",
      "blocked in",
      "icy",
      "someone slipped",
      "fell on the ice",
      "windrow",
      "emergency access",
    ],
    faqs: [
      {
        question: "How much is a seasonal snow contract?",
        answer:
          "It depends on the size of the driveway or lot and what's included. Take the address and details and say the owner will send a written quote. Never guess a price.",
      },
      {
        question: "What's the difference between seasonal and per-push?",
        answer:
          "Seasonal is one price for the whole winter no matter how much it snows. Per-push means paying each time the crew plows. Seasonal is the most popular because the bill is predictable.",
      },
      {
        question: "When will you come after it snows?",
        answer:
          "The crew heads out once snowfall reaches the trigger depth in the contract and works through the route. Exact timing depends on the storm, so don't promise a specific time.",
      },
      {
        question: "Do you salt?",
        answer: "Yes. Salting can be added to a contract or done per visit. Note whether they want the driveway, walkways or both.",
      },
      {
        question: "Do you do lawn care in the summer?",
        answer: "Yes: weekly lawn cutting plus spring and fall cleanups. Offer to take their details for a quote.",
      },
    ],
  },
  booking: {
    mode: "windows",
    windows: [
      { key: "morning", start: "08:00", durationMinutes: 240, spoken: "in the morning" },
      { key: "afternoon", start: "12:00", durationMinutes: 240, spoken: "in the afternoon" },
    ],
    capacityPerWindow: 3,
    leadTimeHours: 24,
    horizonDays: 21,
    workingDays: [1, 2, 3, 4, 5, 6],
  },
};
