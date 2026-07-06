/**
 * Golden lead-envelope fixtures — the shared contract both spoke forwarders are built
 * against. This test proves the fixtures and the schema (docs/LEAD_SCHEMA.md, encoded
 * as leadEnvelopeSchema) can't disagree. Each spoke repo commits these same fixtures
 * and adds a test asserting its forwarder output matches them exactly, so the two
 * implementations can't drift without a red test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { leadEnvelopeSchema } from "@/server/services/lead-intake/envelope";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "server",
  "services",
  "lead-intake",
  "__fixtures__",
  "envelopes",
);
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
const load = (file: string) => JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as unknown;

describe("lead envelope golden fixtures", () => {
  it("has fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files)("%s is a valid canonical envelope (schema <-> fixtures agree)", (file) => {
    const result = leadEnvelopeSchema.safeParse(load(file));
    expect(result.success ? "" : JSON.stringify(result.error.issues)).toBe("");
  });

  it("covers every formType", () => {
    const types = new Set(files.map((f) => (load(f) as { formType: string }).formType));
    expect([...types].sort()).toEqual(["booking", "contact", "quote"]);
  });
});
