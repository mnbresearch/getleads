import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Dependency-free .env loader: checks cwd, then two parent levels (monorepo root). Never overrides existing vars. */
export function loadEnv() {
  for (const p of [".env", "../.env", "../../.env"].map((x) => resolve(process.cwd(), x))) {
    try {
      const txt = readFileSync(p, "utf8");
      for (const line of txt.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2].replace(/\s+#.*$/, "");
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
      return p;
    } catch {}
  }
  return null;
}
