/**
 * A tiny in-memory stand-in for the Supabase query builder, for service tests that would
 * otherwise hand-chain `.eq().eq().maybeSingle()` per call shape. Supports the subset the
 * missed-call catcher uses: select / insert / upsert (onConflict + ignoreDuplicates) /
 * update, filters eq / neq / gte / lte / is, order, limit, maybeSingle / single, and
 * `metadata_json->>key` JSON-path equality. Every operation is logged in `ops` so tests
 * can assert ordering (e.g. durable write before processing).
 */
import type { TenantServiceContext } from "@/server/services/shared";

type Row = Record<string, unknown>;

export interface FakeDbOp {
  table: string;
  op: "select" | "insert" | "upsert" | "update";
  row?: Row;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  ops: FakeDbOp[];
  /** Make the next op on `table` (optionally a specific op) fail with this error. */
  failNext(table: string, error: { message: string; code?: string }, op?: FakeDbOp["op"]): void;
  client: { from(table: string): unknown };
}

let idCounter = 0;

function readPath(row: Row, column: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(column);
  if (json) {
    const obj = row[json[1]];
    const value = obj && typeof obj === "object" ? (obj as Row)[json[2]] : undefined;
    return value === undefined || value === null ? null : String(value);
  }
  return row[column];
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ops: FakeDbOp[] = [];
  const failures: Array<{ table: string; op?: FakeDbOp["op"]; error: { message: string; code?: string } }> = [];

  const takeFailure = (table: string, op: FakeDbOp["op"]) => {
    const index = failures.findIndex((f) => f.table === table && (!f.op || f.op === op));
    if (index < 0) return null;
    return failures.splice(index, 1)[0].error;
  };

  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(row: Row) => boolean> = [];
    let mode: FakeDbOp["op"] = "select";
    let patch: Row | null = null;
    let order: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;

    const matching = () => {
      let rows = tables[table].filter((row) => filters.every((f) => f(row)));
      if (order) {
        const { column, ascending } = order;
        rows = [...rows].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      return limitN === null ? rows : rows.slice(0, limitN);
    };

    const run = (): { data: unknown; error: unknown } => {
      const failure = takeFailure(table, mode);
      if (failure) return { data: null, error: failure };
      if (mode === "update") {
        const rows = tables[table].filter((row) => filters.every((f) => f(row)));
        for (const row of rows) Object.assign(row, patch);
        ops.push({ table, op: "update", row: patch ?? undefined });
        return { data: rows, error: null };
      }
      ops.push({ table, op: "select" });
      return { data: matching(), error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => readPath(row, column) === value);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => readPath(row, column) !== value);
        return builder;
      },
      gte: (column: string, value: unknown) => {
        filters.push((row) => String(readPath(row, column) ?? "") >= String(value));
        return builder;
      },
      lte: (column: string, value: unknown) => {
        filters.push((row) => String(readPath(row, column) ?? "") <= String(value));
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (readPath(row, column) ?? null) === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(readPath(row, column)));
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        order = { column, ascending: opts?.ascending ?? true };
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      maybeSingle: () => {
        const result = run();
        if (result.error) return Promise.resolve(result);
        const rows = result.data as Row[];
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single: () => {
        const result = run();
        if (result.error) return Promise.resolve(result);
        const rows = result.data as Row[];
        return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "no rows" } });
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
      update: (values: Row) => {
        mode = "update";
        patch = values;
        return builder;
      },
      insert: (values: Row | Row[]) => {
        const failure = takeFailure(table, "insert");
        const list = Array.isArray(values) ? values : [values];
        if (!failure) {
          for (const value of list) {
            const row = { id: `${table}-${++idCounter}`, created_at: new Date().toISOString(), ...value };
            tables[table].push(row);
            ops.push({ table, op: "insert", row });
          }
        }
        const result = { data: failure ? null : list, error: failure };
        const inserted: Record<string, unknown> = {
          select: () => inserted,
          single: () => Promise.resolve({ data: failure ? null : tables[table][tables[table].length - 1], error: failure }),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject),
        };
        return inserted;
      },
      upsert: (value: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        const failure = takeFailure(table, "upsert");
        if (failure) return Promise.resolve({ data: null, error: failure });
        const keys = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
        const existing = tables[table].find((row) => keys.every((k) => row[k] === value[k]));
        ops.push({ table, op: "upsert", row: value });
        if (existing) {
          if (!opts?.ignoreDuplicates) Object.assign(existing, value);
        } else {
          tables[table].push({ id: `${table}-${++idCounter}`, created_at: new Date().toISOString(), ...value });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  };

  return {
    tables,
    ops,
    failNext(table, error, op) {
      failures.push({ table, error, op });
    },
    client: { from },
  };
}

/** A service context whose (RLS or admin) client is the fake DB. */
export function fakeTenantContext(db: FakeDb, organizationId: string, actorProfileId: string | null = null): TenantServiceContext {
  return { organizationId, actorProfileId, supabase: db.client as never };
}
