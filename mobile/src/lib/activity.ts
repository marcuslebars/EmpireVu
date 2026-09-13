import {
  CalendarCheck,
  CalendarPlus,
  CalendarX,
  Camera,
  ChatCircle,
  CheckSquare,
  CreditCard,
  EnvelopeSimple,
  FileText,
  Lightning,
  Phone,
  PhoneX,
  Sparkle,
  Target,
  User,
  UserPlus,
  type Icon,
} from "@phosphor-icons/react";

import { humanize, type Tone } from "@m/lib/format";
import type { Route, TabId } from "@m/state/nav";

/** Labels match the web app's activity feed (TopBar ACTIVITY_LABELS). */
const KNOWN: Record<string, { label: string; icon: Icon; tone: Tone }> = {
  "contact.created": { label: "New contact", icon: UserPlus, tone: "pri" },
  "contact.stage_changed": { label: "Stage changed", icon: Target, tone: "warn" },
  "contact.updated": { label: "Contact updated", icon: User, tone: "neutral" },
  "contact.call_placed": { label: "Marina call", icon: Phone, tone: "vio" },
  "contact.call_completed": { label: "Call outcome", icon: Phone, tone: "vio" },
  "contact.call_missed": { label: "Missed call", icon: PhoneX, tone: "dest" },
  "contact.sms_sent": { label: "Text sent", icon: ChatCircle, tone: "pri" },
  "contact.sms_received": { label: "Text received", icon: ChatCircle, tone: "pri" },
  "contact.email_sent": { label: "Email sent", icon: EnvelopeSimple, tone: "warn" },
  "contact.ai_draft_created": { label: "AI reply drafted", icon: Sparkle, tone: "vio" },
  "booking.created": { label: "New booking", icon: CalendarPlus, tone: "pri" },
  "booking.completed": { label: "Booking completed", icon: CalendarCheck, tone: "suc" },
  "booking.cancelled": { label: "Booking cancelled", icon: CalendarX, tone: "neutral" },
  "booking.photo_added": { label: "Job photo added", icon: Camera, tone: "warn" },
  "task.created": { label: "Task created", icon: CheckSquare, tone: "pri" },
  "task.completed": { label: "Task completed", icon: CheckSquare, tone: "suc" },
};

export function activityPresentation(eventType: string): { label: string; icon: Icon; tone: Tone } {
  const known = KNOWN[eventType];
  if (known) return known;
  const prefix = eventType.split(".")[0];
  const label = humanize(eventType.replace(/\./g, " "));
  if (prefix === "quote") return { label, icon: FileText, tone: "suc" };
  if (/payment|deposit|paid/.test(eventType)) return { label, icon: CreditCard, tone: "suc" };
  if (prefix === "workflow") return { label, icon: Lightning, tone: "vio" };
  if (prefix === "booking") return { label, icon: CalendarCheck, tone: "pri" };
  if (prefix === "task") return { label, icon: CheckSquare, tone: "pri" };
  if (prefix === "contact") return { label, icon: User, tone: "pri" };
  return { label, icon: Lightning, tone: "neutral" };
}

/** Where tapping an activity item goes, mirroring the web feed's links. */
export function routeForEntity(entity: { id: string; type: string } | null): { tab?: TabId; route?: Route } | null {
  if (!entity) return null;
  switch (entity.type) {
    case "contact":
      return { route: { name: "contact", contactId: entity.id } };
    case "booking":
      return { route: { name: "booking", bookingId: entity.id } };
    case "task":
      return { route: { name: "task", taskId: entity.id } };
    case "workflow":
      return { route: { name: "automations" } };
    case "quote":
      return { route: { name: "quote", quoteId: entity.id } };
    default:
      return null;
  }
}
