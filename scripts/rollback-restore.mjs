#!/usr/bin/env node
// Before rolling back to a release from before the account-security work (migration 0019):
// put back the two things only the old code's format can express.
//
//   1. Client report links. The old code finds a report by the plaintext token in
//      clients.share_token. Links created or rotated on the new release (and every link, if
//      LINK_TOKENS_CLEAR_PLAINTEXT=true was used) are stored as a hash plus an encrypted copy
//      only. This writes the plaintext back for those rows.
//   2. Sender and integration credentials. The old code reads its own encrypted format only.
//      Credentials saved on the new release (and every credential that was read, if
//      CREDENTIAL_REBIND_ON_READ=true was used) are in the new format. This rewrites those
//      rows in the old format, under the same key.
//
// Nothing is removed: the new columns stay as they are, so rolling forward again needs
// nothing - the new release simply carries on.
//
// Run it with the NEW build and the PRODUCTION environment, immediately BEFORE redeploying
// the previous build (while the new release is still the one deployed):
//
//   npm ci && npm run build -w packages/core -w packages/db -w apps/api
//   DATABASE_URL=... ENCRYPTION_KEY=... JWT_SECRET=... node scripts/rollback-restore.mjs --dry-run
//   DATABASE_URL=... ENCRYPTION_KEY=... JWT_SECRET=... node scripts/rollback-restore.mjs
//
// (plus ENCRYPTION_KEYS_OLD if it is set in production). --dry-run only counts;
// --org <workspace id> limits it to one workspace.
// It prints counts, never a token, a credential or a connection string. Safe to run twice.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The key and format the old release reads: AES-256-GCM under SHA-256(ENCRYPTION_KEY or
// JWT_SECRET), stored as "iv.tag.ciphertext" in base64.
export function legacyEncrypt(plain, rawKey) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(rawKey).digest(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

/**
 * The restore itself, separate from the command line so it can be tested.
 *
 *   dbPkg            the @prospex/db module (tables, eq, and)
 *   db               a connection from it
 *   openShareToken   (orgId, clientId, encrypted) -> token      from the API's lib/linkTokens
 *   openOrgSecret    (orgId, kind, blob) -> plaintext           from the API's lib/credentials
 *   rawKey           ENCRYPTION_KEY, or JWT_SECRET when that is not set
 *   dryRun           count only
 *   orgId            optional: one workspace only
 *
 * Returns counts. Never returns or logs a token or a credential.
 */
export async function restore({ dbPkg, db, openShareToken, openOrgSecret, legacyShareColumns = null, rawKey, dryRun = false, orgId = null }) {
  const { clients, emailAccounts, integrations, eq } = dbPkg;
  const out = { links: 0, linksAlready: 0, creds: 0, credsAlready: 0, failed: 0 };
  const rows = (table) => (orgId ? db.select().from(table).where(eq(table.orgId, orgId)) : db.select().from(table));

  for (const c of await rows(clients)) {
    if (c.shareToken) {
      out.linksAlready++;
      continue;
    }
    if (!c.shareTokenEncrypted) continue; // never shared
    try {
      const token = openShareToken(c.orgId, c.id, c.shareTokenEncrypted);
      // The copy kept next to a readable token is stored in its "legacy" marked form, the same
      // as for a link from before the upgrade. Without the mark, a link restored here and then
      // turned off on the previous release would come back to life after rolling forward.
      const marked = legacyShareColumns ? { shareTokenEncrypted: legacyShareColumns(c.orgId, c.id, token).shareTokenEncrypted } : {};
      if (!dryRun) await db.update(clients).set({ shareToken: token, ...marked }).where(eq(clients.id, c.id));
      out.links++;
    } catch {
      out.failed++;
    }
  }

  for (const [table, kind] of [
    [emailAccounts, "email-account"],
    [integrations, "integration"],
  ]) {
    for (const r of await rows(table)) {
      if (!r.configEncrypted) continue;
      if (!r.configEncrypted.startsWith("v2.")) {
        out.credsAlready++;
        continue;
      }
      try {
        const plain = openOrgSecret(r.orgId, kind, r.configEncrypted);
        if (!dryRun) await db.update(table).set({ configEncrypted: legacyEncrypt(plain, rawKey) }).where(eq(table.id, r.id));
        out.creds++;
      } catch {
        out.failed++;
      }
    }
  }
  return out;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const apiLib = join(here, "..", "apps", "api", "dist", "lib");
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const orgAt = args.indexOf("--org");
  const orgId = orgAt !== -1 ? args[orgAt + 1] : null;

  const stop = (line) => {
    console.error(`[rollback-restore] ${line}`);
    process.exit(1);
  };

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: node scripts/rollback-restore.mjs [--dry-run] [--org <workspace id>]\n" +
        "Restores plaintext report-link tokens and old-format sender/integration credentials before a rollback.\n" +
        "--dry-run counts without changing anything; --org limits it to one workspace. See DEPLOY.md, section B11.",
    );
    process.exit(0);
  }
  if (orgAt !== -1 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId ?? "")) stop("--org needs a workspace id (a UUID).");
  if (!process.env.DATABASE_URL) stop("DATABASE_URL is not set. Run this with the production environment (DATABASE_URL, ENCRYPTION_KEY, JWT_SECRET, and ENCRYPTION_KEYS_OLD if you use it).");
  const rawKey = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!rawKey) stop("Neither ENCRYPTION_KEY nor JWT_SECRET is set, so stored values cannot be read. Run this with the production environment.");
  for (const f of ["linkTokens.js", "credentials.js"]) {
    if (!existsSync(join(apiLib, f))) stop("The API has not been built. Run: npm ci && npm run build -w packages/core -w packages/db -w apps/api");
  }

  let dbPkg, db, openShareToken, openOrgSecret, legacyShareColumns;
  try {
    dbPkg = await import("@prospex/db");
    ({ openShareToken, legacyShareColumns } = await import(pathToFileURL(join(apiLib, "linkTokens.js")).href));
    ({ openOrgSecret } = await import(pathToFileURL(join(apiLib, "credentials.js")).href));
    ({ db } = dbPkg.getDb());
  } catch (e) {
    // The message of a configuration error is safe to show; never the object (it can carry a statement and its values).
    stop(`could not load the built packages: ${String(e?.message ?? e).split(/Failed query:|\bparams:/i)[0].slice(0, 300)}`);
  }

  let r;
  try {
    r = await restore({ dbPkg, db, openShareToken, openOrgSecret, legacyShareColumns, rawKey, dryRun, orgId });
  } catch (e) {
    await dbPkg.closeDb().catch(() => {});
    stop(`stopped part-way (it is safe to run again): ${e?.name ?? "Error"}${e?.code ? ` [${e.code}]` : ""}`);
  }

  console.log(`[rollback-restore]${dryRun ? " DRY RUN - nothing was changed." : ""}${orgId ? " One workspace only." : ""}`);
  console.log(`  report links ${dryRun ? "that would be " : ""}given their plaintext token back: ${r.links} (already readable by the old release: ${r.linksAlready})`);
  console.log(`  sender and integration credentials ${dryRun ? "that would be " : ""}rewritten in the old format: ${r.creds} (already in it: ${r.credsAlready})`);
  if (r.failed) console.log(`  could not be read (left untouched): ${r.failed}. These need the encryption key they were saved under - check ENCRYPTION_KEY / ENCRYPTION_KEYS_OLD.`);
  if (r.failed) console.log("  DO NOT redeploy the previous build yet: fix the key, run this again, and continue only when nothing is left unread.");
  else console.log(dryRun ? "  Run again without --dry-run, then redeploy the previous build." : "  Now redeploy the previous build. To roll forward later, just deploy the new build again.");
  await dbPkg.closeDb().catch(() => {});
  // Unread rows are a failure in a dry run too: the dry run exists to find this out first.
  process.exit(r.failed ? 2 : 0);
}

// Run only when started as a script, so a test can import `restore` without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
