import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The catalog seeds are generated SQL that nothing parses before it reaches the
 * Supabase SQL editor. A malformed `ON CONFLICT DO UPDATE SET` — e.g. a bare
 * column with no `=`, from a stray string-replace in the generator — would fail
 * mid-migration in front of an operator, not in CI. This asserts every SET
 * assignment is a real `col = value`, which is exactly the class of bug that
 * shipped once (a bare `review_rules,` in the SET list).
 */
const seedsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "seeds");
const CATALOG_SEEDS = ["a1-service-catalog.sql", "a1-care-catalog.sql", "a1-coatings-catalog.sql"];

describe("catalog seeds are well-formed SQL", () => {
  for (const file of CATALOG_SEEDS) {
    it(`${file}: every DO UPDATE SET assignment is a col = value`, () => {
      const sql = readFileSync(join(seedsDir, file), "utf8");
      // Each upsert's ON CONFLICT clause is one line ending in `;`, and the SET
      // values are all `excluded.<col>` (no embedded commas), so a comma split of
      // the captured clause yields one assignment per fragment.
      const setClauses = [...sql.matchAll(/do update set (.+?);/gi)].map((m) => m[1]);
      expect(setClauses.length, "expected at least one upsert").toBeGreaterThan(0);
      for (const clause of setClauses) {
        for (const assignment of clause.split(", ")) {
          expect(assignment.includes("="), `bare fragment in SET clause: "${assignment}"`).toBe(true);
        }
      }
    });
  }
});
