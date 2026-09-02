#!/usr/bin/env node
/**
 * Regenerate src/server/db/database.types.ts from the live Postgres schema via
 * the Supabase CLI. Cross-platform (spawns through the shell so Windows resolves
 * supabase.cmd / npx.cmd). Two env-selected modes:
 *
 *   remote  — when SUPABASE_PROJECT_REF is set:
 *             `supabase gen types typescript --project-id $SUPABASE_PROJECT_REF`
 *             Introspects the linked hosted project. Also needs SUPABASE_ACCESS_TOKEN.
 *
 *   local   — otherwise:
 *             `supabase gen types typescript --local`
 *             Introspects the local dev stack (requires `supabase start` first).
 *
 * See docs/EMPIREVU_RUNBOOK.md (section "Generating database types").
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "server",
  "db",
  "database.types.ts",
);

const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
const modeArgs = projectRef ? `--project-id ${projectRef}` : "--local";

if (projectRef && !process.env.SUPABASE_ACCESS_TOKEN) {
  console.error(
    "[gen:types] SUPABASE_PROJECT_REF is set but SUPABASE_ACCESS_TOKEN is not — remote generation needs both.",
  );
  process.exit(1);
}

const cliArgs = `gen types typescript --schema public ${modeArgs}`;

function run(cmd) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function looksMissing(res) {
  const haystack = `${res.stderr ?? ""}${res.error?.message ?? ""}`;
  return res.error?.code === "ENOENT" || /not recognized|command not found|: not found/i.test(haystack);
}

console.error(
  `[gen:types] ${projectRef ? `remote (project ${projectRef})` : "local"} -> ${OUT}`,
);

// Prefer a supabase on PATH; transparently fall back to npx if it isn't installed.
let res = run(`supabase ${cliArgs}`);
if (looksMissing(res)) {
  console.error("[gen:types] supabase not on PATH; retrying via npx…");
  res = run(`npx --yes supabase ${cliArgs}`);
}

if (res.status !== 0 || !res.stdout || !res.stdout.trim()) {
  console.error("[gen:types] generation failed:\n" + (res.stderr || res.error?.message || "unknown error"));
  console.error(
    projectRef
      ? "[gen:types] check SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN and network access."
      : "[gen:types] is the local stack running? Start it with `supabase start`, or set SUPABASE_PROJECT_REF for remote mode.",
  );
  process.exit(res.status || 1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, res.stdout);
console.error(`[gen:types] wrote ${res.stdout.length} bytes to database.types.ts`);
