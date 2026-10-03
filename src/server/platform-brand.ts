/**
 * Server adapter for the platform brand (see src/lib/platform-brand-core.ts and
 * docs/branding.md). Reads `PLATFORM_*` from process.env on every call — cheap, and it
 * lets tests use vi.stubEnv. Consumed by the web service (invitations, lead
 * notifications, receptionist health) and the workflow-events worker (owner alerts,
 * owner digest).
 *
 * Only OWNER-facing server text should use this. Anything a business's CUSTOMER sees
 * (quote emails, booking confirmations, statement descriptors) is branded from the
 * company row instead and must not name the platform.
 */
import { resolvePlatformBrand, type PlatformBrand } from "@/lib/platform-brand-core";

export type { PlatformBrand } from "@/lib/platform-brand-core";

export function getPlatformBrand(env: Record<string, string | undefined> = process.env): PlatformBrand {
  return resolvePlatformBrand((key) => env[key]);
}
