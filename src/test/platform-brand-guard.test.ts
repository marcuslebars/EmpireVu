import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression guard: owner-visible UI and owner-facing server copy must take the product
 * name from the platform brand module (src/lib/platform-brand-core.ts), never hardcode
 * "EmpireVu". See docs/branding.md.
 *
 * What counts as a hit: the display spelling "EmpireVu" / "Empire Vu" in CODE (comments
 * are stripped first). Lowercase internal identifiers — storage keys (empirevu_org_id),
 * protocol headers (x-empirevu-key, x-empirevu-signature), slugs, hostnames — are not
 * display text and are deliberately not matched. Changing those would break A1 spokes
 * and site integrations.
 */

const ROOT = path.resolve(__dirname, "../..");

/** Directories / files scanned. Owner-visible UI + owner-facing server email/alert copy. */
const SCANNED = [
  "src/App.tsx",
  "src/main.tsx",
  "src/screens",
  "src/components",
  "src/server/templates",
  "src/server/services/organization-invitations.ts",
  "src/server/services/owner-digest.ts",
  "src/server/services/lead-intake/notify.ts",
  "src/server/services/retell/health.ts",
  "src/server/services/workflow-engine/actions.ts",
  "src/server/services/push",
  "src/server/services/quotes/emails.ts",
  "mobile/src",
  "index.html",
  "mobile/index.html",
];

/**
 * Files allowed to still contain the display string, with the reason. Keep this short;
 * every entry is debt.
 */
const ALLOW: Record<string, string> = {
  // Owned by a parallel PR (do-not-touch for the branding PR). TODO: switch its three
  // headings to platformBrand.name, then delete this entry.
  "src/screens/onboarding/OnboardingWizard.tsx": "parallel PR — adopt platformBrand there",
};

const DISPLAY_NAME = /Empire\s?Vu/;

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((entry) => {
    const childRel = path.join(rel, entry);
    const childAbs = path.join(ROOT, childRel);
    if (statSync(childAbs).isDirectory()) return walk(childRel);
    return /\.(tsx?|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [childRel] : [];
  });
}

/** Remove block comments, JSX comments, HTML comments and // line comments (not "://"). */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function displayNameHits(source: string): string[] {
  return stripComments(source)
    .split("\n")
    .filter((line) => DISPLAY_NAME.test(line))
    .map((line) => line.trim());
}

describe("no hardcoded platform display name in owner-facing code", () => {
  const files = SCANNED.flatMap(walk).map((f) => f.split(path.sep).join("/"));

  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/components/brand/Logo.tsx");
    expect(files).toContain("src/server/templates/platform-emails.ts");
  });

  it.each(files.filter((f) => !(f in ALLOW)))("%s uses the brand module", (file) => {
    const hits = displayNameHits(readFileSync(path.join(ROOT, file), "utf8"));
    expect(hits, `Hardcoded "EmpireVu" in ${file} — use platformBrand.name (SPA), getPlatformBrand() (server) or brand.name (mobile)`).toEqual([]);
  });

  it("allow-listed files exist (drop stale entries)", () => {
    for (const file of Object.keys(ALLOW)) {
      expect(() => statSync(path.join(ROOT, file))).not.toThrow();
    }
  });
});

describe("the guard itself detects", () => {
  it("flags display text but not comments or internal identifiers", () => {
    expect(displayNameHits(`<h1>Welcome to EmpireVu</h1>`)).toHaveLength(1);
    expect(displayNameHits(`const s = "Empire Vu alert";`)).toHaveLength(1);
    expect(displayNameHits(`// EmpireVu is the engine\nconst k = "empirevu_org_id";`)).toEqual([]);
    expect(displayNameHits(`/** EmpireVu */\nheaders["x-empirevu-key"] = key;`)).toEqual([]);
    expect(displayNameHits(`{/* EmpireVu */}<a href="https://app.empirevu.com">x</a>`)).toEqual([]);
  });
});
