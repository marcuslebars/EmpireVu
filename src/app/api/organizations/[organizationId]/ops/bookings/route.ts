import { NextResponse } from "next/server";

import { handleRoute, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listBookings } from "@/server/services/bookings";
import { createSupabaseServerClient } from "@/server/supabase/server";
import type { Tables } from "@/server/db/database.types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

interface OpsBookingRow {
  id: string;
  title: string;
  status: string;
  scheduledFor: string;
  durationMinutes: number;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  description: string | null;
  createdAt: string;
  createdBy: string | null;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const bookings = await listBookings(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    const companyIds = [...new Set(bookings.map((b) => b.company_id).filter(Boolean))];
    const contactIds = [...new Set(bookings.map((b) => b.contact_id).filter(Boolean))];

    const [{ data: companies }, { data: contacts }] = await Promise.all([
      companyIds.length > 0
        ? supabase.from("companies").select("id, name").in("id", companyIds)
        : { data: [] as Tables<"companies">[] | null },
      contactIds.length > 0
        ? supabase.from("contacts").select("id, first_name, last_name").in("id", contactIds)
        : { data: [] as Tables<"contacts">[] | null },
    ]);

    const companyMap = new Map((companies ?? []).map((c) => [c.id, c]));
    const contactMap = new Map((contacts ?? []).map((c) => [c.id, c]));

    const rows: OpsBookingRow[] = bookings.map((booking) => {
      const company = booking.company_id ? companyMap.get(booking.company_id) : null;
      const contact = booking.contact_id ? contactMap.get(booking.contact_id) : null;

      return {
        id: booking.id,
        title: booking.title,
        status: booking.status,
        scheduledFor: booking.scheduled_for,
        durationMinutes: booking.duration_minutes,
        companyId: booking.company_id,
        companyName: company?.name ?? null,
        contactId: booking.contact_id,
        contactName: contact
          ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || null
          : null,
        description: booking.description,
        createdAt: booking.created_at,
        createdBy: booking.created_by,
      };
    });

    return NextResponse.json({ data: rows });
  });
}
