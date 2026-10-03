/**
 * Guard: client code must read `import.meta.env.VITE_X` by name. A whole-object reference
 * (`import.meta.env` passed around, spread, or indexed) makes Vite inline EVERY `VITE_*`
 * variable present at build time into the public bundle — including anything mis-named,
 * e.g. a server secret given a VITE_ prefix. This happened once (service-role key).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src", "mobile/src"];
const SKIP = /(^|\/)(test|server|app\/api)(\/|$)|\.test\.tsx?$|\.d\.ts$/;

function files(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("client env is only read by name", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    let list: string[] = [];
    try {
      list = files(root);
    } catch {
      continue;
    }
    for (const f of list) {
      if (SKIP.test(f.replace(/\\/g, "/"))) continue;
      const code = stripComments(readFileSync(f, "utf8"));
      // import.meta.env NOT immediately followed by `.IDENT`
      if (/import\.meta\.env(?!\s*\.\s*[A-Za-z_$])/.test(code)) offenders.push(f);
    }
  }

  it("has no whole-object import.meta.env references", () => {
    expect(offenders).toEqual([]);
  });
});
