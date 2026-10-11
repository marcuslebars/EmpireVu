/**
 * Jobs (bookings) as the Dispatcher sees them: one company, a time range, with the customer's
 * name and the booked service's key. Always scoped by organization_id + company_id.
 */
import type { Tables } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { DispatchCompany } from "./company";
import type { Db } from "./db-types";
import { firstName, jobPhrase } from "./messages";

export interface Job {
  id: string;
  contactId: string | null;
  title: string;
  scheduledFor: string;
  durationMinutes: number;
  windowKey: string | null;
  location: string | null;
  status: string;
  enRouteAt: string | null;
  startedAt: string | null;
  manageToken: string | null;
  serviceKey: string | null;
  customerName: string;
  customerFirstName: string;
  customerPhone: string | null;
  customerOptedOut: boolean;
}

/** Open = still to happen and nobody has headed out. */
export function isOpenJob(job: Pick<Job, "status" | "enRouteAt" | "startedAt">): boolean {
  return (job.status === "pending" || job.status === "confirmed") && !job.enRouteAt && !job.startedAt;
}

type BookingRow = Pick<
  Tables<"bookings">,
  "id" | "contact_id" | "title" | "scheduled_for" | "duration_minutes" | "window_key" | "location" | "status" | "en_route_at" | "started_at" | "manage_token" | "service_item_id"
>;

export async function loadJobs(
  admin: AdminClient,
  company: Pick<DispatchCompany, "organizationId" | "companyId">,
  fromIso: string,
  toIso: string,
): Promise<Job[]> {
  const db = admin as Db;
  const { data, error } = await db
    .from("bookings")
    .select("id, contact_id, title, scheduled_for, duration_minutes, window_key, location, status, en_route_at, started_at, manage_token, service_item_id")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", fromIso)
    .lt("scheduled_for", toIso)
    .order("scheduled_for", { ascending: true })
    .limit(500);
  if (error) throw error;
  const rows = (data ?? []) as BookingRow[];
  if (rows.length === 0) return [];

  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => Boolean(x)))];
  const itemIds = [...new Set(rows.map((r) => r.service_item_id).filter((x): x is string => Boolean(x)))];
  const [contacts, items] = await Promise.all([
    contactIds.length
      ? db.from("contacts").select("id, first_name, last_name, phone, sms_opt_out_at").eq("organization_id", company.organizationId).eq("company_id", company.companyId).in("id", contactIds)
      : Promise.resolve({ data: [] }),
    itemIds.length
      ? db.from("service_catalog_items").select("id, service_key").eq("organization_id", company.organizationId).eq("company_id", company.companyId).in("id", itemIds)
      : Promise.resolve({ data: [] }),
  ]);
  const contactMap = new Map(
    ((contacts.data ?? []) as Array<Pick<Tables<"contacts">, "id" | "first_name" | "last_name" | "phone" | "sms_opt_out_at">>).map((c) => [c.id, c]),
  );
  const keyOf = new Map(((items.data ?? []) as Array<{ id: string; service_key: string }>).map((i) => [i.id, i.service_key]));

  return rows.map((r) => {
    const c = r.contact_id ? contactMap.get(r.contact_id) : undefined;
    const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() : "";
    return {
      id: r.id,
      contactId: r.contact_id,
      title: r.title,
      scheduledFor: r.scheduled_for,
      durationMinutes: r.duration_minutes,
      windowKey: r.window_key,
      location: r.location,
      status: r.status,
      enRouteAt: r.en_route_at,
      startedAt: r.started_at,
      manageToken: r.manage_token,
      serviceKey: r.service_item_id ? keyOf.get(r.service_item_id) ?? null : null,
      customerName: name || c?.phone || "Customer",
      customerFirstName: firstName(c),
      customerPhone: c?.phone ?? null,
      customerOptedOut: Boolean(c?.sms_opt_out_at),
    };
  });
}

/** service_key → label for the company's active price list (weather sensitivity by listed service). */
export async function serviceLabels(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">): Promise<Map<string, string>> {
  const { data } = await (admin as Db)
    .from("service_catalog_items")
    .select("service_key, label, active")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .limit(200);
  return new Map(((data ?? []) as Array<{ service_key: string; label: string; active: boolean }>).filter((i) => i.active !== false).map((i) => [i.service_key, i.label]));
}

export { jobPhrase };
