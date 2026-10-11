/**
 * PostgREST caps a single response at 1,000 rows (a bigger .limit() is silently truncated), so
 * every Marketer read that can be larger pages with .range() — same rule as live-data.ts
 * listAllRows — and counts use { count: "exact", head: true }.
 */
import type { Db } from "@/server/services/staff/marketer/db-types";

export const PAGE_SIZE = 1000;

/**
 * Run `build()` (a fresh, fully filtered query each call — add a stable .order()) page by page
 * until a short page. `max` is a safety stop.
 */
export async function pageAll<T>(build: () => Db, max = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** Exact row count of a filtered query (`build` returns db.from(t).select("id", { count: "exact", head: true }).eq(…)). */
export async function countRows(build: () => Db): Promise<number> {
  const { count, data, error } = await build();
  if (error) throw error;
  if (typeof count === "number") return count;
  return Array.isArray(data) ? data.length : 0;
}
