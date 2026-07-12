import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { toIsoDate } from "@/server/db/helpers";
import { createActivityEvent } from "@/server/services/activity-events";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import {
  assertBookingInOrganization,
  assertCompanyInOrganization,
  assertContactInOrganization,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";

export const createBookingInputSchema = z.object({
  companyId: z.string().uuid(),
  contactId: z.string().uuid().nullable().optional(),
  description: z.string().max(3000).nullable().optional(),
  durationMinutes: z.number().int().positive().max(1440).optional(),
  scheduledFor: z.union([z.string().datetime(), z.date()]),
  status: z.enum(["pending", "confirmed", "completed", "cancelled"]).optional(),
  title: z.string().min(1).max(200),
});

export type CreateBookingInput = z.infer<typeof createBookingInputSchema>;

export const updateBookingStatusInputSchema = z.object({
  bookingId: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "completed", "cancelled", "no_show"]),
});

export type UpdateBookingStatusInput = z.infer<typeof updateBookingStatusInputSchema>;

interface BookingMutationOptions {
  dispatchWorkflow?: boolean;
}

export interface ListBookingsOptions {
  companyId?: string | null;
  contactId?: string | null;
  limit?: number;
  status?: Tables<"bookings">["status"] | null;
}

export async function listBookings(
  context: TenantServiceContext,
  options: ListBookingsOptions = {},
): Promise<Tables<"bookings">[]> {
  let query = context.supabase
    .from("bookings")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("scheduled_for", { ascending: true });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
  }

  if (options.contactId) {
    query = query.eq("contact_id", options.contactId);
  }

  if (options.status) {
    query = query.eq("status", options.status);
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function createBooking(
  context: TenantServiceContext,
  input: CreateBookingInput,
  options: BookingMutationOptions = {},
): Promise<Tables<"bookings">> {
  await assertCompanyInOrganization(context, input.companyId);
  await assertContactInOrganization(context, input.contactId);

  const payload = {
    company_id: input.companyId,
    contact_id: input.contactId ?? null,
    created_by: context.actorProfileId,
    description: input.description ?? null,
    duration_minutes: input.durationMinutes ?? 30,
    organization_id: context.organizationId,
    scheduled_for: toIsoDate(input.scheduledFor),
    title: input.title,
    ...(input.status ? { status: input.status } : {}),
  } satisfies Inserts<"bookings">;

  const data = await insertRow(context, "bookings", payload);

  await emitActivityEventAndDispatch(context, {
    companyId: data.company_id,
    entityId: data.id,
    entityType: "booking",
    eventType: "booking.created",
    metadata: {
      bookingId: data.id,
      scheduledFor: data.scheduled_for,
      status: data.status,
    },
    relatedEntityId: data.contact_id,
    relatedEntityType: data.contact_id ? "contact" : null,
  }, {
    dispatchAsync: options.dispatchWorkflow !== false,
  });

  return data;
}

export async function getBookingById(
  context: TenantServiceContext,
  bookingId: string,
): Promise<Tables<"bookings">> {
  await assertBookingInOrganization(context, bookingId);

  const { data, error } = await context.supabase
    .from("bookings")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", bookingId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateBookingStatus(
  context: TenantServiceContext,
  input: UpdateBookingStatusInput,
  options: BookingMutationOptions = {},
): Promise<Tables<"bookings">> {
  const existing = await getBookingById(context, input.bookingId);

  if (existing.status === input.status) {
    return existing;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("bookings") as any)
    .update({ status: input.status })
    .eq("organization_id", context.organizationId)
    .eq("id", input.bookingId)
    .select("*")
    .single();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const updated = data as Tables<"bookings">;

  await createActivityEvent(context, {
    companyId: updated.company_id,
    entityId: updated.id,
    entityType: "booking",
    eventType: "booking.status_changed",
    metadata: {
      bookingId: updated.id,
      previousStatus: existing.status,
      status: updated.status,
    },
    relatedEntityId: updated.contact_id,
    relatedEntityType: updated.contact_id ? "contact" : null,
  });

  if (existing.status !== "completed" && updated.status === "completed") {
    await emitActivityEventAndDispatch(context, {
      companyId: updated.company_id,
      entityId: updated.id,
      entityType: "booking",
      eventType: "booking.completed",
      metadata: {
        bookingId: updated.id,
        previousStatus: existing.status,
        status: updated.status,
      },
      relatedEntityId: updated.contact_id,
      relatedEntityType: updated.contact_id ? "contact" : null,
    }, {
      dispatchAsync: options.dispatchWorkflow !== false,
    });
  }

  return updated;
}