/**
 * The outside world for Compliance, behind one seam so tests (and the owner-channel hook, which
 * calls the role with no deps) can swap it: Twilio media, the AI reader, the private bucket.
 */
import type { AdminClient, InboundMedia } from "@/server/services/front-desk/contracts";
import { fetchComplianceMedia, type FetchedDoc } from "./media";
import { defaultComplianceReader, type ComplianceReader } from "./reader";
import { supabaseComplianceStorage, type ComplianceStorage } from "./storage";

export interface ComplianceDeps {
  fetchMedia(media: InboundMedia[]): Promise<FetchedDoc | null>;
  read: ComplianceReader;
  storage(admin: AdminClient): ComplianceStorage;
}

const defaults: ComplianceDeps = {
  fetchMedia: (media) => fetchComplianceMedia(media),
  read: defaultComplianceReader,
  storage: (admin) => supabaseComplianceStorage(admin),
};

let current: ComplianceDeps = { ...defaults };

export function complianceDeps(): ComplianceDeps {
  return current;
}

/** Test hook: replace some of the outside world. */
export function setComplianceDeps(over: Partial<ComplianceDeps>): void {
  current = { ...current, ...over };
}

/** Test hook. */
export function resetComplianceDeps(): void {
  current = { ...defaults };
}
