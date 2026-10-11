/** Small shared helpers for the import (no runtime imports). */

/** PostgREST returns at most 1000 rows per request. */
export const PAGE_SIZE = 1000;
/** Values per `.in()` filter (keeps the request URL well under limits). */
export const IN_CHUNK = 200;

export function chunks<T>(items: T[], size: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Read every page of a query (`make(from, to)` builds it with `.range(from, to)`). Throws on an error. */
export async function readAllPages<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, maxRows = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await make(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** Throw a PostgREST error; return the data. */
export function must<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

/** "$8,420" (owner texts drop .00), "$8,420.50" otherwise. PURE. */
export function ownerMoney(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-CA")} ${n === 1 ? one : many}`;
}

/** YYYY-MM-DD in a time zone. PURE. */
export function localDate(nowMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}
