import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

describe("Phase 3: Row Level Security (RLS) & Multi-Tenant Access Policies", () => {
  const schemaPath = path.join(root, "packages/db/src/schema.ts");
  const migration0027Path = path.join(root, "packages/db/migrations/0027_enable_row_level_security.sql");
  const rollback0027Path = path.join(root, "packages/db/rollbacks/0027_enable_row_level_security.rollback.sql");

  it("0027 migration file exists and enables Row Level Security", () => {
    expect(fs.existsSync(migration0027Path)).toBe(true);
    const sql = fs.readFileSync(migration0027Path, "utf8");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("0027 rollback migration exists and properly reverses RLS", () => {
    expect(fs.existsSync(rollback0027Path)).toBe(true);
    const sql = fs.readFileSync(rollback0027Path, "utf8");
    expect(sql).toContain("DISABLE ROW LEVEL SECURITY");
  });

  it("every table defined in schema.ts is covered in the 0027 RLS migration", () => {
    const schemaContent = fs.readFileSync(schemaPath, "utf8");
    const migrationContent = fs.readFileSync(migration0027Path, "utf8");
    const rollbackContent = fs.readFileSync(rollback0027Path, "utf8");

    const tableMatches = [...schemaContent.matchAll(/pgTable\(\s*["']([^"']+)["']/g)];
    const tableNames = [...new Set(tableMatches.map((m) => m[1]))];

    expect(tableNames.length).toBe(72);

    for (const table of tableNames) {
      expect(migrationContent).toContain(`'${table}'`);
      expect(rollbackContent).toContain(`'${table}'`);
    }
  });

  it("tenant-scoped tables contain an org_id column to prevent cross-tenant data leaks", () => {
    const schemaContent = fs.readFileSync(schemaPath, "utf8");

    // Sample major tenant tables holding user/business data
    const tenantTables = [
      "icps",
      "clients",
      "leads",
      "lists",
      "campaigns",
      "email_accounts",
      "suppressions",
      "monitors",
      "signals",
      "deals",
      "call_logs",
      "coaching_sessions",
      "waterfall_configs",
      "digital_workers",
      "digital_sales_rooms"
    ];

    for (const table of tenantTables) {
      // Find the table block in schema.ts
      const regex = new RegExp(`pgTable\\(\\s*["']${table}["'],\\s*\\{([\\s\\S]*?)\\}\\s*,`, "m");
      const match = schemaContent.match(regex);
      expect(match, `Table ${table} definition should be found`).not.toBeNull();
      if (match) {
        expect(match[1]).toMatch(/orgId|org_id/);
      }
    }
  });

  it("user role updates cannot be performed by arbitrary users to promote themselves", () => {
    const authRoutesPath = path.join(root, "apps/api/src/routes/auth.ts");
    const toolsRoutesPath = path.join(root, "apps/api/src/routes/tools.ts");
    const authContent = fs.readFileSync(authRoutesPath, "utf8");
    const toolsContent = fs.readFileSync(toolsRoutesPath, "utf8");

    // Ensure there is no user profile PATCH endpoint allowing role self-promotion
    expect(authContent).not.toMatch(/update\(users\)\.set\([^)]*\brole\b/);

    // In tools, role is only assigned on invite creation by owner/admin, never self-promoted
    expect(toolsContent).toContain('if (!["owner", "admin"].includes(a.user!.role)) throw forbidden("Only owners/admins can invite");');
  });

  it("no database views or functions bypass security definer settings with unfixed search_path", () => {
    const migrationsDir = path.join(root, "packages/db/migrations");
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

    for (const f of files) {
      const content = fs.readFileSync(path.join(migrationsDir, f), "utf8");
      if (/SECURITY\s+DEFINER/i.test(content)) {
        // If security definer exists, search_path must be locked
        expect(content).toMatch(/SET\s+search_path\s*=/i);
      }
    }
  });
});
