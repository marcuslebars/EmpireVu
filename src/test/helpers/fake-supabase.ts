/**
 * A tiny in-memory Supabase/PostgREST stand-in for service tests. Supports the builder
 * surface the monthly scorecard uses (select / eq / in / gte / lt / lte / not-is-null / is /
 * order / range / limit / maybeSingle / single / insert / update / upsert / delete), unique
 * constraints (→ error code 23505), and records every query's filters so tests can assert
 * tenancy (every read filtered by organization_id + company_id). Also: JSON-path filter
 * columns (`payload->data->object->>customer`), upsert `ignoreDuplicates` (upsert returns the
 * written row), and `failNext(table, op)` to inject one error.
 */

type Row = Record<string, unknown>;

export interface RecordedQuery {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  filters: Array<{ kind: string; column: string; value: unknown }>;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  queries: RecordedQuery[];
  client: never;
  /** unique keys per table, e.g. { monthly_scorecard_sends: [["company_id","month"]] } */
  unique: Record<string, string[][]>;
  /** Make the next `op` on `table` return this error (once). */
  failNext(table: string, op: RecordedQuery["op"], error?: { message: string; code?: string }): void;
}

/** Read a column, following PostgREST JSON paths: `a->b->>c` (text) / `a->b` (json). */
function readColumn(row: Row, column: string): unknown {
  if (!column.includes("->")) return row[column];
  const parts = column.split(/->>?/);
  let value: unknown = row[parts[0]];
  for (const key of parts.slice(1)) {
    value = value && typeof value === "object" ? (value as Row)[key] : undefined;
  }
  if (value === undefined || value === null) return null;
  return column.includes("->>") && typeof value !== "string" ? String(value) : value;
}

let idCounter = 0;

export function createFakeDb(seed: Record<string, Row[]> = {}, unique: Record<string, string[][]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const queries: RecordedQuery[] = [];
  const failures: Array<{ table: string; op: RecordedQuery["op"]; error: { message: string; code?: string } }> = [];

  function rowsOf(table: string): Row[] {
    if (!tables[table]) tables[table] = [];
    return tables[table];
  }

  function violatesUnique(table: string, candidate: Row, ignore?: Row): boolean {
    return (unique[table] ?? []).some((cols) =>
      rowsOf(table).some((row) => row !== ignore && cols.every((col) => row[col] === candidate[col])),
    );
  }

  function builder(table: string) {
    const recorded: RecordedQuery = { table, op: "select", filters: [] };
    queries.push(recorded);
    const preds: Array<(row: Row) => boolean> = [];
    let payload: Row | Row[] | null = null;
    let upsertConflict: string[] = [];
    let upsertIgnoreDuplicates = false;
    let rangeFrom = 0;
    let rangeTo = Number.POSITIVE_INFINITY;
    let wantRows = true;

    const filter = (kind: string, column: string, value: unknown, pred: (row: Row) => boolean) => {
      recorded.filters.push({ kind, column, value });
      preds.push(pred);
      return api;
    };
    const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

    function matches(): Row[] {
      return rowsOf(table).filter((row) => preds.every((pred) => pred(row)));
    }

    function execute(): { data: unknown; error: unknown; count?: number } {
      const failure = failures.findIndex((f) => f.table === table && f.op === recorded.op);
      if (failure >= 0) return { data: null, error: failures.splice(failure, 1)[0].error };
      switch (recorded.op) {
        case "insert": {
          const list = Array.isArray(payload) ? payload : [payload ?? {}];
          for (const row of list) {
            if (violatesUnique(table, row)) return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const defaults: Row = table === "monthly_scorecard_sends" ? { send_count: 0 } : {};
          const inserted = list.map((row) => ({ id: `id-${++idCounter}`, ...defaults, ...row }));
          rowsOf(table).push(...inserted);
          return { data: inserted, error: null };
        }
        case "upsert": {
          const row = payload as Row;
          const existing = rowsOf(table).find((r) => upsertConflict.every((col) => r[col] === row[col]));
          if (existing) {
            if (!upsertIgnoreDuplicates) Object.assign(existing, row);
            return { data: [{ ...existing }], error: null };
          }
          const created = { id: `id-${++idCounter}`, ...row };
          rowsOf(table).push(created);
          return { data: [{ ...created }], error: null };
        }
        case "update": {
          const hit = matches();
          for (const row of hit) Object.assign(row, payload);
          return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        case "delete": {
          const hit = new Set(matches());
          tables[table] = rowsOf(table).filter((row) => !hit.has(row));
          return { data: null, error: null };
        }
        default: {
          const hit = matches();
          const sliced = hit.slice(rangeFrom, rangeTo + 1).map((r) => ({ ...r }));
          return { data: sliced, error: null, count: hit.length };
        }
      }
    }

    const api: Record<string, unknown> = {
      select: (_cols?: string) => {
        if (recorded.op !== "select") wantRows = true;
        return api;
      },
      eq: (column: string, value: unknown) => filter("eq", column, value, (row) => readColumn(row, column) === value),
      neq: (column: string, value: unknown) => filter("neq", column, value, (row) => row[column] !== value),
      in: (column: string, values: unknown[]) => filter("in", column, values, (row) => values.includes(row[column])),
      gte: (column: string, value: unknown) => filter("gte", column, value, (row) => row[column] != null && cmp(row[column], value) >= 0),
      gt: (column: string, value: unknown) => filter("gt", column, value, (row) => row[column] != null && cmp(row[column], value) > 0),
      lt: (column: string, value: unknown) => filter("lt", column, value, (row) => row[column] != null && cmp(row[column], value) < 0),
      lte: (column: string, value: unknown) => filter("lte", column, value, (row) => row[column] != null && cmp(row[column], value) <= 0),
      is: (column: string, value: unknown) => filter("is", column, value, (row) => (row[column] ?? null) === value),
      not: (column: string, _op: string, value: unknown) =>
        filter("not", column, value, (row) => (row[column] ?? null) !== value),
      order: () => api,
      limit: () => api,
      range: (from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return api;
      },
      insert: (row: Row | Row[]) => {
        recorded.op = "insert";
        payload = row;
        return api;
      },
      update: (row: Row) => {
        recorded.op = "update";
        payload = row;
        wantRows = false;
        return api;
      },
      upsert: (row: Row, options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        recorded.op = "upsert";
        payload = row;
        upsertConflict = (options?.onConflict ?? "id").split(",").map((c) => c.trim());
        upsertIgnoreDuplicates = options?.ignoreDuplicates ?? false;
        return api;
      },
      delete: () => {
        recorded.op = "delete";
        return api;
      },
      maybeSingle: () => {
        const result = execute();
        const rows = (result.data as Row[] | null) ?? [];
        return Promise.resolve({ data: rows[0] ?? null, error: result.error });
      },
      single: () => {
        const result = execute();
        const rows = (result.data as Row[] | null) ?? [];
        return Promise.resolve(
          rows[0] ? { data: rows[0], error: null } : { data: null, error: result.error ?? { message: "no rows" } },
        );
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(execute()).then(resolve, reject),
    };
    return api;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  };

  return {
    tables,
    queries,
    unique,
    client: client as never,
    failNext(table, op, error = { message: `injected ${op} failure on ${table}` }) {
      failures.push({ table, op, error });
    },
  };
}
