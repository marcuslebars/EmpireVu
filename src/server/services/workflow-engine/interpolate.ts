/**
 * Message template interpolation (Task 8).
 *
 * Templates reference entity fields by dotted path and an optional filter:
 *   {{ contact.first_name }}
 *   {{ company.name }}
 *   {{ booking.scheduled_for | date }}
 *   {{ quote.public_url }}
 *   {{ company.booking_url }}
 * A bare token ({{ status }}) resolves against the flat event `fields`. Unknown paths
 * render empty (a message never leaks a literal "{{ … }}"). Filters format in the
 * business timezone so a date/time reads correctly for the tenant.
 */

export interface MessageTemplateData {
  contact: Record<string, unknown> | null;
  company: Record<string, unknown> | null;
  booking: Record<string, unknown> | null;
  quote: Record<string, unknown> | null;
  /** The invoice behind an invoice.* event: number, total, balance, due, public_url. */
  invoice?: Record<string, unknown> | null;
  /** The Retell call behind a call.* event: summary, numbers, duration, owner_summary. */
  call?: Record<string, unknown> | null;
  /** Flat event fields — the fallback for bare tokens. */
  fields: Record<string, unknown>;
}

const ROOTS = new Set(["contact", "company", "booking", "quote", "invoice", "call"]);
// {{ path }} or {{ path | filter }} — path has no '|' or '}'.
const TOKEN = /\{\{\s*([^}|]+?)\s*(?:\|\s*([a-zA-Z]+)\s*)?\}\}/g;

export function businessTimezone(): string {
  return process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

function resolvePath(path: string, data: MessageTemplateData): unknown {
  const parts = path.split(".");
  const root = parts[0];
  if (ROOTS.has(root)) {
    let current: unknown = data[root as "contact" | "company" | "booking" | "quote" | "invoice" | "call"];
    for (const segment of parts.slice(1)) {
      if (current == null || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return current ?? null;
  }
  // Bare token → a flat event field.
  return data.fields[path] ?? null;
}

function applyFilter(name: string, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return value;
  const tz = businessTimezone();

  switch (name) {
    case "date": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return "";
      return new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(d);
    }
    case "time": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return "";
      return new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    }
    case "money": {
      const cents = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(cents)) return "";
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
    }
    case "dollars": {
      // "$672" / "$481.25" — how a text says money (no ".00", no currency code).
      const cents = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(cents)) return "";
      const d = cents / 100;
      return Number.isInteger(d)
        ? `$${d.toLocaleString("en-CA")}`
        : `$${d.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    default:
      // Unknown filter → pass the value through unchanged.
      return value;
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Render `{{ path | filter }}` tokens against the template data. */
export function renderTemplate(template: string, data: MessageTemplateData): string {
  return template.replace(TOKEN, (_match, rawPath: string, filter: string | undefined) => {
    const value = resolvePath(rawPath.trim(), data);
    const filtered = filter ? applyFilter(filter.trim(), value) : value;
    return stringify(filtered);
  });
}
