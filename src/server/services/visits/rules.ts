/**
 * Confirm & reschedule — PURE rules: per-brand settings, what a customer may do with a
 * visit right now, and the customer-facing labels. Pinned by src/test/visit-self-service.test.ts.
 * See docs/confirm-reschedule.md.
 */
import { z } from "zod";

export const visitSettingsSchema = z.object({
  /** Customers can move the visit to another open time themselves. */
  allowReschedule: z.boolean(),
  /** Customers can cancel the visit themselves. */
  allowCancel: z.boolean(),
  /** No self-service changes inside this many hours of the visit (confirming is always fine). */
  cutoffHours: z.number().int().min(0).max(168),
});

export type VisitSettings = z.infer<typeof visitSettingsSchema>;

export const DEFAULT_VISIT_SETTINGS: VisitSettings = { allowReschedule: true, allowCancel: true, cutoffHours: 24 };

export function parseVisitSettings(raw: unknown): VisitSettings {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULT_VISIT_SETTINGS };
  const shape = visitSettingsSchema.shape;
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    if (!(key in obj)) continue;
    const parsed = shape[key].safeParse(obj[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as VisitSettings;
}

export type VisitState = "scheduled" | "confirmed" | "on_the_way" | "in_progress" | "done" | "cancelled" | "missed" | "past";

export interface VisitFacts {
  status: string;
  scheduledFor: string;
  durationMinutes: number;
  enRouteAt: string | null;
  startedAt: string | null;
  customerConfirmedAt: string | null;
}

export function visitState(b: VisitFacts, nowMs: number): VisitState {
  if (b.status === "cancelled") return "cancelled";
  if (b.status === "completed") return "done";
  if (b.status === "no_show") return "missed";
  if (b.startedAt) return "in_progress";
  if (b.enRouteAt) return "on_the_way";
  const end = Date.parse(b.scheduledFor) + Math.max(1, b.durationMinutes) * 60_000;
  if (end < nowMs) return "past";
  return b.customerConfirmedAt ? "confirmed" : "scheduled";
}

export interface VisitActions {
  canConfirm: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  /** Why changes aren't offered (shown with "call or text us"), or null. */
  lockedReason: string | null;
}

export function visitActions(b: VisitFacts, settings: VisitSettings, nowMs: number): VisitActions {
  const state = visitState(b, nowMs);
  const open = state === "scheduled" || state === "confirmed";
  if (!open) return { canConfirm: false, canReschedule: false, canCancel: false, lockedReason: null };
  const startsIn = Date.parse(b.scheduledFor) - nowMs;
  const insideCutoff = startsIn < settings.cutoffHours * 3_600_000;
  const lockedReason =
    insideCutoff && (settings.allowReschedule || settings.allowCancel)
      ? settings.cutoffHours > 0
        ? `Changes within ${settings.cutoffHours} hour${settings.cutoffHours === 1 ? "" : "s"} of the visit need a quick call or text.`
        : null
      : null;
  return {
    canConfirm: state === "scheduled" && startsIn > 0,
    canReschedule: settings.allowReschedule && !insideCutoff && startsIn > 0,
    canCancel: settings.allowCancel && !insideCutoff && startsIn > 0,
    lockedReason,
  };
}

/** "Tuesday, October 6" and "9:00 a.m." in the brand's zone. */
export function visitLabels(iso: string, timeZone: string): { date: string; time: string; day: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("en-CA", { timeZone, weekday: "long", month: "long", day: "numeric" }),
    time: d.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" }),
    day: d.toLocaleDateString("en-CA", { timeZone }),
  };
}

export const MANAGE_TOKEN_RE = /^[a-f0-9]{32}$/;
