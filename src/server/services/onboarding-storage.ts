// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION: company logo upload writes to the `branding` Storage bucket via
// the service-role client. The bucket has no client insert policy (public read only), so
// writes must go through here — always behind the authed org-member check in the calling
// route, to a path prefixed by the org id. No other route may import createSupabaseAdminClient.
// ─────────────────────────────────────────────────────────────────────────────
import { ValidationError } from "@/server/organizations/context";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

const ALLOWED = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
]);
const MAX_BYTES = 2 * 1024 * 1024;

export interface UploadBrandingLogoInput {
  organizationId: string;
  companyId: string;
  contentType: string;
  bytes: ArrayBuffer;
}

export async function uploadBrandingLogo(input: UploadBrandingLogoInput): Promise<{ url: string }> {
  const ext = ALLOWED.get(input.contentType);
  if (!ext) throw new ValidationError("Logo must be a PNG, JPEG, WebP, or SVG image.");
  if (input.bytes.byteLength === 0) throw new ValidationError("The uploaded file was empty.");
  if (input.bytes.byteLength > MAX_BYTES) throw new ValidationError("Logo must be 2 MB or smaller.");

  const admin = createSupabaseAdminClient();
  const path = `${input.organizationId}/${input.companyId}/logo-${Date.now()}.${ext}`;
  const { error } = await admin.storage
    .from("branding")
    .upload(path, input.bytes, { contentType: input.contentType, upsert: true });
  if (error) throw error;

  const { data } = admin.storage.from("branding").getPublicUrl(path);
  return { url: data.publicUrl };
}
