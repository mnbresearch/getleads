/**
 * Seeds a demo organization + owner user + API key for local development.
 * Prints the API key once. Safe to re-run (skips if org exists).
 */
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { loadEnv } from "./loadEnv.js";
loadEnv();
import { createDb } from "./client.js";
import { apiKeys, organizations, users } from "./schema.js";
import { limitsFor } from "./plans.js";

/**
 * The seed creates an owner account with a password that is printed in the README. Against a
 * production database that is a ready-made way in, so it refuses to run there. `--force` (or
 * SEED_FORCE=true) is for the person who really means it, e.g. a throwaway staging database.
 */
export function seedRefusal(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): string | null {
  const forced = argv.includes("--force") || /^(1|true|yes)$/i.test(env.SEED_FORCE ?? "");
  if (forced) return null;
  if ((env.NODE_ENV ?? "").toLowerCase() === "production") {
    return "[seed] refusing to run with NODE_ENV=production: the demo account has a published password. Run with --force only against a database you intend to throw away.";
  }
  return null;
}

async function main() {
  const refusal = seedRefusal();
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }
  const { db, sql } = createDb();
  try {
    const existing = await db.query.organizations.findFirst({ where: eq(organizations.slug, "demo") });
    if (existing) {
      console.log("[seed] demo org exists, skipping");
      return;
    }
    const [org] = await db
      .insert(organizations)
      .values({ name: "Demo Org", slug: "demo", plan: "pilot", planLimits: limitsFor("pilot") })
      .returning();
    // password: demo1234 (bcrypt handled in API; here we store a marker the API knows how to upgrade)
    const { default: bcrypt } = await import("bcryptjs");
    const hash = await bcrypt.hash("demo1234", 10);
    await db.insert(users).values({ orgId: org.id, email: "demo@prospex.local", passwordHash: hash, name: "Demo User", role: "owner" });
    const raw = `px_live_${randomBytes(24).toString("base64url")}`;
    await db.insert(apiKeys).values({
      orgId: org.id,
      name: "Seed key",
      prefix: raw.slice(0, 12),
      keyHash: createHash("sha256").update(raw).digest("hex"),
    });
    console.log("[seed] demo org created");
    console.log("       login:   demo@prospex.local / demo1234");
    console.log(`       api key: ${raw}`);
  } finally {
    await sql.end();
  }
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    const err = e as { name?: string; code?: string; message?: string };
    console.error(`[seed] failed: ${err?.name ?? "Error"}${err?.code ? ` [${err.code}]` : ""}: ${String(err?.message ?? e).split(/Failed query:|\bparams:/i)[0]!.slice(0, 300)}`);
    process.exit(1);
  });
}
