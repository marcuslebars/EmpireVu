import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lead ids are TEXT, everywhere.
 *
 * genLeadId() returns `lead_${hex}` — never a uuid. quotes.source_lead_id was
 * declared uuid anyway, so every auto-quote insert died with
 *
 *   22P02  invalid input syntax for type uuid: "lead_6bb7f1190a2f219b"
 *
 * and nothing caught it: maybeAutoQuoteLead cannot throw by design, so the only
 * trace was one line in a service log. A static check is the cheapest guard that
 * would have — no database, no fixtures, just the schema disagreeing with the
 * generator.
 */
const migrations = join(process.cwd(), "supabase", "migrations");
const sql = (name: string) => readFileSync(join(migrations, name), "utf8");

describe("the lead id format and the schema agree", () => {
  it("generates a prefixed hex id, not a uuid", async () => {
    const src = readFileSync(join(process.cwd(), "src/server/services/lead-intake/intake.ts"), "utf8");
    // If this ever becomes randomUUID(), the columns below can go back to uuid —
    // and this test is where you will find out that they must.
    expect(src).toMatch(/lead_\$\{randomBytes\(/);
    expect(src).not.toMatch(/function genLeadId\(\): string \{\s*return randomUUID/);
  });

  it("stores source_lead_id as text, like every other lead reference", () => {
    const fixed = sql("20260903000000_source_lead_id_is_text.sql");
    expect(fixed).toMatch(/alter column source_lead_id type text/i);
  });

  it("keeps the one-auto-quote-per-lead index after the type change", () => {
    // A type change invalidates the index; losing it would silently allow a
    // second auto-quote — and a second email — for the same lead.
    const fixed = sql("20260903000000_source_lead_id_is_text.sql");
    expect(fixed).toMatch(/create unique index if not exists quotes_auto_generated_lead_uniq/i);
    expect(fixed).toMatch(/where auto_generated and source_lead_id is not null/i);
  });
});
