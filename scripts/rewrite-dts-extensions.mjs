// Rewrite relative `.ts`/`.tsx` import/export specifiers to `.js` in emitted
// `.d.ts` files. `tsc`'s `rewriteRelativeImportExtensions` rewrites the `.js`
// output but leaves declaration files pointing at `.ts`, which fails type
// resolution for consumers on `node16`/`nodenext` module resolution (the
// shipped folder has `layout.d.ts`, not `layout.ts`). This makes the published
// types resolve under every resolution mode. Idempotent.
//
// Usage: node scripts/rewrite-dts-extensions.mjs <distDir>

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: rewrite-dts-extensions.mjs <distDir>");
  process.exit(1);
}

// Matches `from "./x.ts"`, `from '../x.tsx'`, and `import("./x.ts")` forms,
// capturing the leading token, the relative path, and the closing quote.
const SPECIFIER = /(from\s*["']|import\(\s*["'])(\.\.?\/[^"']*?)\.tsx?(["'])/g;

function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!p.endsWith(".d.ts")) continue;
    const src = readFileSync(p, "utf8");
    const out = src.replace(SPECIFIER, (_m, lead, spec, close) => `${lead}${spec}.js${close}`);
    if (out !== src) writeFileSync(p, out);
  }
}

walk(dir);
