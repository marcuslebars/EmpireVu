/**
 * The platform number: the owner channel's own line (owners text it; approvals, confirmations,
 * setup and weekly-report texts come from it). PLATFORM_SMS_NUMBER when set, so the platform
 * has a line of its own while TWILIO_FROM_NUMBER stays a house business's number and the
 * default sender; else TWILIO_FROM_NUMBER (single-number deployments).
 */
export function platformNumber(): string | null {
  return process.env.PLATFORM_SMS_NUMBER?.trim() || process.env.TWILIO_FROM_NUMBER?.trim() || null;
}
