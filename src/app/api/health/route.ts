import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * SANCTIONED EXCEPTION (service role) — platform health probe.
 *
 * This route runs the service-role admin client to read AGGREGATE worker-queue
 * health only: `count(status='pending')` and `max(locked_at)` per job table. It
 * never reads row content and never touches tenant business data, so there is no
 * RLS identity to resolve — the health of the shared queue is platform-wide, not
 * tenant-scoped. The DB reachability probe uses the anon client, not the admin
 * client. Public + unauthenticated by design (Railway's healthcheck hits it with
 * no session); the response carries no secrets.
 *
 * Listed in docs/EMPIREVU_RUNBOOK.md.
 */

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;

// The three DB-backed queues, each with the same claim/queue columns
// (status='pending' = queued, locked_at = last claimed). jobber_sync_jobs is not
// yet in database.types.ts (Task 2 gen-types), so these reads go through the
// library's default (loosely-typed) SupabaseClient — a type annotation, not an
// `as any` cast. They are aggregate-only.
const WORKER_TABLES = {
  workflow_events: "workflow_event_jobs",
  billing_events: "billing_event_jobs",
  jobber_sync: "jobber_sync_jobs",
} as const;

type WorkerKey = keyof typeof WORKER_TABLES;

interface WorkerHealth {
  last_claimed_at: string | null;
  queued: number;
}

function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("health check timed out")), ms),
    ),
  ]);
}

async function readWorkerHealth(admin: SupabaseClient, table: string): Promise<WorkerHealth> {
  const queued = await admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  const claimed = await admin
    .from(table)
    .select("locked_at")
    .not("locked_at", "is", null)
    .order("locked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    last_claimed_at: (claimed.data as { locked_at: string | null } | null)?.locked_at ?? null,
    queued: queued.count ?? 0,
  };
}

export async function GET(): Promise<NextResponse> {
  const version = process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown";

  // 1) DB reachability via the anon client. An org SELECT returns zero rows to
  //    anon under RLS (no error) when the DB is up, and an error when it is not —
  //    a clean connectivity probe that reads no tenant data.
  let dbOk: boolean;
  try {
    const anon = createSupabaseServerClient();
    const { error } = await withTimeout(anon.from("organizations").select("id").limit(1), TIMEOUT_MS);
    dbOk = !error;
  } catch {
    dbOk = false;
  }

  if (!dbOk) {
    return NextResponse.json({ ok: false, db: "error", workers: null, version }, { status: 503 });
  }

  // 2) Worker freshness (aggregate only). Best-effort: a stats hiccup degrades to
  //    nulls but never turns a healthy DB into a 503.
  let workers: Record<WorkerKey, WorkerHealth> | null = null;
  try {
    const admin: SupabaseClient = createSupabaseAdminClient();
    const keys = Object.keys(WORKER_TABLES) as WorkerKey[];
    const results = await withTimeout(
      Promise.all(keys.map((key) => readWorkerHealth(admin, WORKER_TABLES[key]))),
      TIMEOUT_MS,
    );
    workers = Object.fromEntries(keys.map((key, i) => [key, results[i]])) as Record<WorkerKey, WorkerHealth>;
  } catch (err) {
    console.error("[health] worker stats failed:", err instanceof Error ? err.message : err);
    workers = null;
  }

  return NextResponse.json({ ok: true, db: "ok", workers, version }, { status: 200 });
}
