import type { Json } from "@/server/db/database.types";

/**
 * The one sanctioned jsonb (de)serialization boundary.
 *
 * Supabase types every `jsonb` column as `Json` (a recursive
 * `string | number | boolean | null | {…} | Json[]` union). Domain interfaces are
 * never structurally assignable to `Json` (an interface has no implicit index
 * signature), and a `Json` value read back is not assignable to a specific domain
 * interface either — so a cast is unavoidable at the exact point a typed value
 * crosses into or out of a `jsonb` column. These two helpers are that point, and the
 * ONLY place in src/server that casts through `unknown`. They are type-only: no
 * runtime transform happens, so behavior is identical to a bare column read/write.
 *
 * Use `toJson(value)` when writing a domain value into a `jsonb` column, and
 * `fromJson<Shape>(row.col)` when reading one back as a known shape.
 */
export function toJson<T>(value: T): Json {
  return value as unknown as Json;
}

export function fromJson<T>(value: Json | null | undefined): T {
  return value as unknown as T;
}
