/**
 * Seeds a demo organization + owner user + API key for local development.
 * Prints the API key once. Safe to re-run (skips if org exists).
 */
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadEnv } from "./loadEnv.js";
loadEnv();
import { createDb } from "./client.js";
import { apiKeys, organizations, users } from "./schema.js";
import { limitsFor } from "./plans.js";

async function main() {
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
