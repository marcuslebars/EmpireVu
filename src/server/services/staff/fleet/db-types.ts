/**
 * Local row types for the Fleet tables (migration 20261014130000_staff_fleet.sql) until they are
 * merged into database.types.ts. Queries use the `Db = any` cast, like the other roles.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type EquipmentStatus = "available" | "out" | "in_shop" | "retired";
export type FleetLogKind = "odometer" | "hours" | "service" | "check_out" | "check_in" | "rental_out" | "rental_returned";
export type FleetLogSource = "owner_sms" | "owner_photo" | "settings" | "system";
export type ReminderSubject = "company" | "vehicle" | "service_item" | "equipment" | "rental";

export interface VehicleRow {
  id: string;
  organization_id: string;
  company_id: string;
  name: string;
  year: number | null;
  make: string | null;
  model: string | null;
  plate: string | null;
  vin: string | null;
  profile_id: string | null;
  odometer_km: number | null;
  odometer_at: string | null;
  avg_km_per_day: number | string | null;
  plate_sticker_due: string | null;
  safety_inspection_required: boolean;
  safety_inspection_due: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ServiceItemRow {
  id: string;
  organization_id: string;
  company_id: string;
  vehicle_id: string;
  label: string;
  every_km: number | null;
  every_months: number | null;
  last_done_km: number | null;
  last_done_on: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EquipmentRow {
  id: string;
  organization_id: string;
  company_id: string;
  name: string;
  serial: string | null;
  value_cents: number | null;
  status: EquipmentStatus;
  location: string | null;
  booking_id: string | null;
  out_at: string | null;
  out_profile_id: string | null;
  hours: number | string | null;
  service_every_hours: number | string | null;
  service_every_months: number | null;
  last_serviced_on: string | null;
  last_serviced_hours: number | string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RentalRow {
  id: string;
  organization_id: string;
  company_id: string;
  item: string;
  vendor: string | null;
  vendor_phone: string | null;
  booking_id: string | null;
  out_at: string | null;
  due_back_at: string | null;
  rate_cents_per_day: number | null;
  returned_at: string | null;
  notes: string | null;
  created_via: "owner_sms" | "settings";
  created_at: string;
  updated_at: string;
}

export interface FleetLogRow {
  id: string;
  organization_id: string;
  company_id: string;
  vehicle_id: string | null;
  equipment_id: string | null;
  rental_id: string | null;
  service_item_id: string | null;
  kind: FleetLogKind;
  reading: number | string | null;
  label: string | null;
  booking_id: string | null;
  profile_id: string | null;
  source: FleetLogSource;
  source_key: string | null;
  happened_at: string;
  notes: string | null;
  created_at: string;
}

export interface FleetReminderRow {
  id: string;
  organization_id: string;
  company_id: string;
  subject_type: ReminderSubject;
  subject_id: string;
  reminder_key: string;
  local_date: string;
  created_at: string;
}

/** numeric columns come back from PostgREST as strings. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
