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

/** HVAC & plumbing — service calls, installs and emergencies. No prices: the owner enters their own. */
export const hvacPlumbingPack: IndustryPack = {
  id: "hvac-plumbing",
  version: 1,
  name: "HVAC & plumbing",
  tagline: "Furnace, AC and heat pumps, water heaters, drains and emergency calls.",
  description:
    "For heating, cooling and plumbing shops. Sets up service calls, tune-ups and installs, arrival-window booking, and a receptionist that knows no heat in January is an emergency and a gas smell means get out first.",
  services: [
    {
      key: "service_call",
      label: "Service call — diagnostic",
      unit: "visit",
      pricingType: "flat",
      category: "Service",
      description: "A licensed technician comes out, finds the problem and gives you the repair price before any work starts.",
    },
    {
      key: "emergency_service_call",
      label: "Emergency or after-hours service call",
      unit: "visit",
      pricingType: "flat",
      category: "Service",
      description: "Evening, weekend and holiday response for no heat, no hot water, leaks and backups.",
    },
    {
      key: "repair_labour",
      label: "Repair labour",
      unit: "hour",
      pricingType: "per_unit",
      category: "Service",
      description: "Hands-on repair time after the diagnosis; parts are listed separately on the quote.",
    },
    {
      key: "furnace_tune_up",
      label: "Furnace tune-up and safety check",
      unit: "visit",
      pricingType: "flat",
      category: "Maintenance",
      description: "Cleaning, burner and heat-exchanger inspection, carbon monoxide check and filter change before the heating season.",
    },
    {
      key: "ac_tune_up",
      label: "Air conditioner tune-up",
      unit: "visit",
      pricingType: "flat",
      category: "Maintenance",
      description: "Coil cleaning, refrigerant and electrical checks so the AC is ready before the first heat wave.",
    },
    {
      key: "furnace_install",
      label: "Furnace replacement",
      unit: "install",
      pricingType: "flat",
      category: "Installs",
      description: "High-efficiency gas furnace sized for the home, installed with permits and old unit removal.",
    },
    {
      key: "ac_install",
      label: "Air conditioner installation",
      unit: "install",
      pricingType: "flat",
      category: "Installs",
      description: "Central AC sized for the home and matched to the existing furnace.",
    },
    {
      key: "heat_pump_install",
      label: "Heat pump installation",
      unit: "install",
      pricingType: "flat",
      category: "Installs",
      description: "Cold-climate air-source heat pumps for heating and cooling, including ductless mini-splits. Ask about current rebate programs.",
    },
    {
      key: "water_heater_install",
      label: "Water heater replacement",
      unit: "install",
      pricingType: "flat",
      category: "Plumbing",
      description: "Tank or tankless water heaters installed and vented to code, with the old tank hauled away.",
    },
    {
      key: "drain_cleaning",
      label: "Drain cleaning",
      unit: "visit",
      pricingType: "flat",
      category: "Plumbing",
      description: "Clearing slow or blocked sinks, tubs, toilets and main lines, with a camera inspection when needed.",
    },
    {
      key: "sump_pump",
      label: "Sump pump install or replacement",
      unit: "install",
      pricingType: "flat",
      category: "Plumbing",
      description: "New sump pumps, battery backups and check valves to keep the basement dry.",
    },
    {
      key: "water_treatment",
      label: "Water softener and filtration",
      unit: "install",
      pricingType: "flat",
      category: "Plumbing",
      description: "Softeners, UV and filtration systems for well water and hard water.",
    },
    {
      key: "duct_cleaning",
      label: "Duct cleaning",
      unit: "visit",
      pricingType: "flat",
      category: "Maintenance",
      description: "Whole-home duct and vent cleaning to improve airflow and air quality.",
    },
  ],
  recipes: [
    singleText(
      "missed-call-text-back",
      "Hi {{contact.first_name}}, it's {{company.name}}. Sorry we missed your call! No heat, no hot water or a leak? Reply with your address and we'll call you right back. To book a service call: {{company.booking_url}}",
    ),
    quoteFollowUp(
      "Hi {{contact.first_name}}, {{company.name}} here. Just checking you got your quote ({{quote.subtotal}} + HST). Approve it here and we'll get your install booked: {{quote.public_url}} Questions about the equipment or rebates? Just reply.",
      "Hi {{contact.first_name}},\n\nFollowing up on the quote we sent: {{quote.public_url}}\n\nIf you have questions about the equipment, efficiency ratings or rebate programs, just reply and a technician will walk you through it. Approving the quote gets your install on the schedule.\n\nThanks,\n{{company.name}}",
    ),
    bookingReminder(
      "Hi {{contact.first_name}}, a reminder from {{company.name}}: your service visit is on {{booking.scheduled_for | date}}. Please make sure we can get to the furnace, water heater or work area. Confirm or change it here: {{booking.manage_url}}",
      "{{company.name}} here. Your technician is scheduled to arrive in about 2 hours ({{booking.scheduled_for | time}}). See you soon, {{contact.first_name}}!",
    ),
    reviewRequest(
      "Thanks for choosing {{company.name}}, {{contact.first_name}}! If our technician took good care of you, a quick review helps a local shop a lot: {{company.review_url}}",
    ),
    singleText(
      "no-show-recovery",
      "Hi {{contact.first_name}}, {{company.name}} here. Our technician couldn't reach you for today's visit. No problem, pick a new time here: {{company.booking_url}} or reply and we'll rebook you.",
    ),
    staleLeadNudge(1),
    ...tradeQuoteRecipes(),
    ...OWNER_ALERT_RECIPES,
  ],
  reviewRequest: { delay: "1d" },
  receptionist: {
    businessSummary:
      "This is a heating, cooling and plumbing company: furnace, air conditioner and heat pump service and installs, water heaters, drains, sump pumps and water treatment, with emergency service.",
    seasonalNotes: [
      "October to March is heating season. No heat is an emergency, especially with children, elderly people or pets in the home, or when it's below freezing.",
      "Fall is furnace tune-up season and spring is AC tune-up season; offer to book one when a caller is a good fit.",
      "Deep cold snaps bring frozen and burst pipes; spring thaw and heavy rain bring sump pump failures and basement flooding.",
      "SAFETY: if a caller smells gas or their carbon monoxide alarm is going off, tell them to leave the building now and call 911 or the gas utility from outside. Then flag the call as urgent.",
    ],
    qualifyingQuestions: [
      "What's the address of the home or building?",
      "What's going on — no heat, no cooling, no hot water, a leak, a clog, or a quote for new equipment?",
      "Is anyone in the home at risk right now — no heat with young kids or seniors, water spreading, or an alarm going off?",
      "Do you know the make and age of the furnace, AC or water heater?",
      "Do you own the home, or should we coordinate with a landlord?",
      "What's the best number to reach you?",
    ],
    urgentKeywords: [
      "no heat",
      "furnace stopped",
      "smell gas",
      "carbon monoxide",
      "CO alarm",
      "burst pipe",
      "frozen pipes",
      "flooding",
      "sewer backup",
      "sump pump failed",
      "no hot water",
    ],
    faqs: [
      {
        question: "How much is a service call?",
        answer:
          "Say there is a service call charge to diagnose the problem and the technician gives the repair price before doing any work. Don't quote amounts; the owner confirms them.",
      },
      {
        question: "How much is a new furnace or heat pump?",
        answer:
          "It depends on the size of the home and the equipment. Offer an in-home estimate so the owner can size it properly and send a written quote. Never guess a price.",
      },
      {
        question: "Are there rebates for heat pumps?",
        answer:
          "There are often government and utility rebate programs. Say the team will check what the caller qualifies for when they quote; don't promise an amount.",
      },
      {
        question: "Do you do emergency calls?",
        answer: "Yes. Take the address and the problem, flag it as urgent, and the on-call technician will call back.",
      },
      {
        question: "Are your technicians licensed?",
        answer: "Yes. Gas work is done by licensed gas technicians, and plumbing by licensed plumbers.",
      },
    ],
  },
  booking: {
    mode: "windows",
    windows: [
      { key: "morning", start: "08:00", durationMinutes: 240, spoken: "between eight and noon" },
      { key: "afternoon", start: "12:00", durationMinutes: 240, spoken: "between noon and four" },
    ],
    capacityPerWindow: 3,
    leadTimeHours: 12,
    horizonDays: 14,
    workingDays: [1, 2, 3, 4, 5, 6],
  },
};
