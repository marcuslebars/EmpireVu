import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/**
 * Booking coming up → a reminder ~24h before (the scheduler fires booking.upcoming at
 * hours_before), then a second nudge ~2h before via a wait-until, skipped if the booking
 * was cancelled or already completed.
 */
export const bookingReminder: Recipe = {
  slug: "booking-reminder",
  name: "Booking reminders",
  description: "Text a reminder 24 hours and again 2 hours before each booking to cut no-shows.",
  trigger_event: "booking.upcoming",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 300,
    schedule: { hours_before: 24 },
    actions: [
      {
        type: "send_sms",
        to: "contact",
        body: "Hi {{contact.first_name}}, a reminder of your booking with {{company.name}} on {{booking.scheduled_for | date}}. Reply if you need to change it.",
      },
      {
        type: "wait",
        until: "booking.scheduled_for - 2h",
        resume_conditions: [{ field: "status", operator: "in", value: ["pending", "confirmed"] }],
      },
      {
        type: "send_sms",
        to: "contact",
        body: "See you soon, {{contact.first_name}} — your {{company.name}} booking is in about 2 hours ({{booking.scheduled_for | time}}).",
      },
    ],
  },
};
