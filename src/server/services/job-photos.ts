import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { createActivityEvent } from "@/server/services/activity-events";

/**
 * Job photos. Files live in the private `job-photos` bucket at
 * {organization_id}/{company_id}/{booking_id}/{uuid}.jpg; the `job_photos` table is the
 * source of truth for the list. The app resizes (max 2048px, JPEG 0.8) and strips EXIF
 * before upload, uploads to a signed URL, then records the metadata row.
 */
export const JOB_PHOTOS_BUCKET = "job-photos";
const READ_URL_TTL_SECONDS = 3600;

type UserClient = SupabaseClient<Database, "public">;
type Admin = SupabaseClient<Database>;

export interface JobPhotoContext {
  actorProfileId: string;
  organizationId: string;
  supabase: UserClient;
}

export interface JobPhotoView {
  id: string;
  bookingId: string;
  url: string | null;
  caption: string | null;
  takenAt: string;
  takenBy: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
}

export const recordJobPhotoSchema = z.object({
  path: z.string().max(512),
  caption: z.string().trim().max(500).nullish(),
  width: z.number().int().positive().max(20000).nullish(),
  height: z.number().int().positive().max(20000).nullish(),
  bytes: z.number().int().positive().max(10 * 1024 * 1024).nullish(),
  takenAt: z.string().datetime({ offset: true }).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});

/** RLS-scoped read: a booking outside the caller's organization simply isn't found. */
async function loadBooking(context: JobPhotoContext, bookingId: string): Promise<{ id: string; companyId: string }> {
  const { data, error } = await context.supabase
    .from("bookings")
    .select("id, company_id")
    .eq("id", bookingId)
    .eq("organization_id", context.organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError("Booking not found.");
  if (!data.company_id) throw new ValidationError("This booking has no company, so photos can't be filed.");
  return { id: data.id, companyId: data.company_id };
}

export function jobPhotoPathPrefix(organizationId: string, companyId: string, bookingId: string): string {
  return `${organizationId}/${companyId}/${bookingId}/`;
}

export async function createJobPhotoUpload(
  context: JobPhotoContext,
  admin: Admin,
  bookingId: string,
): Promise<{ path: string; token: string; signedUrl: string }> {
  const booking = await loadBooking(context, bookingId);
  const path = `${jobPhotoPathPrefix(context.organizationId, booking.companyId, booking.id)}${randomUUID()}.jpg`;
  const { data, error } = await admin.storage.from(JOB_PHOTOS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("Could not create an upload URL.");
  return { path, token: data.token, signedUrl: data.signedUrl };
}

export async function recordJobPhoto(
  context: JobPhotoContext,
  bookingId: string,
  input: z.output<typeof recordJobPhotoSchema>,
): Promise<Tables<"job_photos">> {
  const booking = await loadBooking(context, bookingId);
  const prefix = jobPhotoPathPrefix(context.organizationId, booking.companyId, booking.id);
  const fileName = input.path.startsWith(prefix) ? input.path.slice(prefix.length) : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i.test(fileName)) {
    throw new ValidationError("Photo path does not belong to this booking.");
  }

  const { data, error } = await context.supabase
    .from("job_photos")
    .insert({
      organization_id: context.organizationId,
      company_id: booking.companyId,
      booking_id: booking.id,
      storage_path: input.path,
      caption: input.caption ?? null,
      taken_by: context.actorProfileId,
      taken_at: input.takenAt ?? new Date().toISOString(),
      width: input.width ?? null,
      height: input.height ?? null,
      bytes: input.bytes ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;

  // Shows in the activity feed and the contact timeline.
  await createActivityEvent(context, {
    companyId: booking.companyId,
    entityId: booking.id,
    entityType: "booking",
    eventType: "booking.photo_added",
    metadata: { photoId: data.id, caption: data.caption },
  });

  return data;
}

export async function listJobPhotos(context: JobPhotoContext, admin: Admin, bookingId: string): Promise<JobPhotoView[]> {
  const booking = await loadBooking(context, bookingId);
  const { data: rows, error } = await context.supabase
    .from("job_photos")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("booking_id", booking.id)
    .order("taken_at", { ascending: false });
  if (error) throw error;
  if (!rows?.length) return [];

  const { data: signed } = await admin.storage
    .from(JOB_PHOTOS_BUCKET)
    .createSignedUrls(rows.map((row) => row.storage_path), READ_URL_TTL_SECONDS);
  const urlByPath = new Map((signed ?? []).map((entry) => [entry.path, entry.signedUrl]));

  return rows.map((row) => ({
    id: row.id,
    bookingId: row.booking_id,
    url: urlByPath.get(row.storage_path) ?? null,
    caption: row.caption,
    takenAt: row.taken_at,
    takenBy: row.taken_by,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
  }));
}
