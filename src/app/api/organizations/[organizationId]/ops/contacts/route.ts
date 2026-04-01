import { NextResponse } from "next/server";

import { handleRoute, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listContacts } from "@/server/services/contacts";
import { createSupabaseServerClient } from "@/server/supabase/server";
import type { Tables } from "@/server/db/database.types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

interface OpsContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  stage: string;
  companyId: string | null;
  companyName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: string;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const contacts = await listContacts(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    const ownerProfileIds = [...new Set(contacts.map((c) => c.owner_profile_id).filter(Boolean))];
    const companyIds = [...new Set(contacts.map((c) => c.company_id).filter(Boolean))];

    const [{ data: profiles }, { data: companies }] = await Promise.all([
      ownerProfileIds.length > 0
        ? supabase.from("profiles").select("id, full_name, email").in("id", ownerProfileIds)
        : { data: [] as Tables<"profiles">[] | null },
      companyIds.length > 0
        ? supabase.from("companies").select("id, name").in("id", companyIds)
        : { data: [] as Tables<"companies">[] | null },
    ]);

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    const companyMap = new Map((companies ?? []).map((c) => [c.id, c]));

    const rows: OpsContactRow[] = contacts.map((contact) => {
      const company = contact.company_id ? companyMap.get(contact.company_id) : null;
      const owner = contact.owner_profile_id ? profileMap.get(contact.owner_profile_id) : null;

      return {
        id: contact.id,
        name: contact.first_name && contact.last_name
          ? `${contact.first_name} ${contact.last_name}`
          : contact.first_name ?? "Unknown",
        email: contact.email,
        phone: contact.phone,
        stage: contact.stage,
        companyId: contact.company_id,
        companyName: company?.name ?? null,
        ownerId: contact.owner_profile_id,
        ownerName: owner?.full_name ?? null,
        ownerEmail: owner?.email ?? null,
        createdAt: contact.created_at,
      };
    });

    return NextResponse.json({ data: rows });
  });
}
