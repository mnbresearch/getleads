import * as S from "@prospex/db";
import { and, eq, getDb, gt, sql, type Organization } from "@prospex/db";
import { auditForResponse, shownAddress } from "../lib/privacySuppression.js";
import { isLiveShareCopy } from "../lib/linkTokens.js";

/**
 * A removed contact's address is kept as a one-way fingerprint so the do-not-contact entry
 * and the unsubscribe link keep working. The fingerprint is not an address and is not
 * exported: the field is null and `recipientRemoved` says why, the same as the list routes.
 */
const withoutFingerprint = (field: string) => (r: Record<string, unknown>) => {
  const shown = shownAddress(typeof r[field] === "string" ? (r[field] as string) : null);
  return { [field]: shown.address, recipientRemoved: shown.recipientRemoved };
};

/**
 * "Export all data": everything a workspace owns, as one JSON document.
 *
 * Streamed. Each table is read in pages of 1,000 rows by primary key and written to the
 * response as it is read, so a workspace with a million leads costs the server one page of
 * memory, not the whole table - and the database is only asked for the next page when the
 * client has taken the previous one.
 *
 * What is NOT in an export, by design:
 *  - anything that authenticates: password hashes, two-factor secrets and recovery codes,
 *    API key hashes, session state, invite and report-link tokens, tracking tokens;
 *  - stored credentials: sender (SMTP / Resend) configs, integration configs, webhook
 *    signing secrets;
 *  - anything belonging to another workspace, and the platform's own tables.
 *
 * Columns are left out twice over: by name on the table's entry below, and by a pattern
 * (`SECRET_COLUMN`) that drops any column whose name says it holds a hash, token, secret,
 * password or encrypted value - so a credential column added to a table later is excluded
 * until someone decides otherwise (`keep`).
 *
 * The document is not a point-in-time snapshot: a row changed while the export runs may
 * appear in either state.
 */
export const EXPORT_PAGE_SIZE = 1000;
export const EXPORT_FORMAT = "scout-workspace-export";
export const EXPORT_VERSION = 1;

const SECRET_COLUMN = /hash|token|secret|password|encrypted|credential/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyColumn = any;
type Scope = (orgId: string) => ReturnType<typeof sql>;

interface TableSpec {
  /** Key of the array in the exported document. */
  key: string;
  table: AnyTable;
  /** Which rows are this workspace's. Default: `org_id = <workspace>`. */
  scope?: Scope;
  /** Column(s) the pages are ordered and resumed by. Default: `id`. */
  cursor?: AnyColumn[];
  /** Columns left out, by property name. */
  omit?: string[];
  /** Columns the secret-name pattern would drop but that are plain data. */
  keep?: string[];
  /** Extra fields derived from a row (computed in the database is not needed for any of these). */
  derive?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Columns selected only to compute `derive`, then dropped. */
  deriveFrom?: string[];
}

const viaParent = (column: AnyColumn, parentTable: string): Scope => (orgId) => sql`${column} IN (SELECT id FROM ${sql.raw(parentTable)} WHERE org_id = ${orgId})`;

/**
 * Every table that holds a workspace's data, in the order it is written. A table with an
 * `org_id` column that is neither here nor in `NOT_EXPORTED` fails security.data.test.ts.
 */
export const EXPORT_TABLES: TableSpec[] = [
  { key: "users", table: S.users, omit: ["googleSub", "totpLastStep", "tokenVersion"], derive: (r) => ({ twoFactorEnabled: !!r.totpEnabledAt, hasGoogleSignIn: !!r.googleSub }), deriveFrom: ["googleSub"] },
  { key: "apiKeys", table: S.apiKeys },
  { key: "invites", table: S.invites },
  { key: "companies", table: S.companies },
  { key: "icps", table: S.icps },
  { key: "clients", table: S.clients, derive: (r) => ({ sharing: !!(r.shareToken || (r.shareTokenHash && isLiveShareCopy(r.shareTokenEncrypted as string | null))) }), deriveFrom: ["shareTokenHash", "shareToken", "shareTokenEncrypted"] },
  { key: "leads", table: S.leads },
  { key: "lists", table: S.lists },
  { key: "listLeads", table: S.listLeads, scope: viaParent(S.listLeads.listId, "lists"), cursor: [S.listLeads.listId, S.listLeads.leadId] },
  { key: "clientLeadDeliveries", table: S.clientLeadDeliveries, scope: viaParent(S.clientLeadDeliveries.clientId, "clients"), cursor: [S.clientLeadDeliveries.clientId, S.clientLeadDeliveries.leadId] },
  { key: "searches", table: S.searches },
  { key: "savedSearches", table: S.savedSearches },
  { key: "emailAccounts", table: S.emailAccounts },
  { key: "campaigns", table: S.campaigns },
  { key: "sequenceSteps", table: S.sequenceSteps, scope: viaParent(S.sequenceSteps.campaignId, "campaigns") },
  { key: "campaignContacts", table: S.campaignContacts, scope: viaParent(S.campaignContacts.campaignId, "campaigns") },
  { key: "messages", table: S.messages, derive: withoutFingerprint("toEmail") },
  { key: "suppressions", table: S.suppressions, derive: withoutFingerprint("email") },
  { key: "tasks", table: S.tasks },
  { key: "autopilots", table: S.autopilots },
  { key: "plays", table: S.plays },
  { key: "playRuns", table: S.playRuns },
  { key: "playCandidates", table: S.playCandidates },
  { key: "signals", table: S.signals },
  { key: "signalSubscriptions", table: S.signalSubscriptions },
  { key: "signalMatches", table: S.signalMatches, cursor: [S.signalMatches.signalId, S.signalMatches.subscriptionId] },
  { key: "monitors", table: S.monitors },
  { key: "monitorResults", table: S.monitorResults },
  { key: "pixels", table: S.pixels },
  { key: "visitorCompanies", table: S.visitorCompanies },
  { key: "visits", table: S.visits },
  { key: "visibilityPrompts", table: S.visibilityPrompts },
  { key: "visibilityRuns", table: S.visibilityRuns },
  { key: "webhooks", table: S.webhooks },
  { key: "integrations", table: S.integrations },
  { key: "scrapedLeads", table: S.scrapedLeads },
  { key: "agentRuns", table: S.agentRuns, keep: ["tokensUsed"] },
  { key: "universities", table: S.universities },
  { key: "studentUniversityMatches", table: S.studentUniversityMatches },
  { key: "regulatoryChanges", table: S.regulatoryChanges },
  { key: "complianceAlerts", table: S.complianceAlerts },
  { key: "competitors", table: S.competitors },
  { key: "competitorTracking", table: S.competitorTracking },
  { key: "marketAnalysis", table: S.marketAnalysis },
  { key: "usage", table: S.usage },
  { key: "events", table: S.events },
  { key: "upgradeRequests", table: S.upgradeRequests },
  { key: "deletionRequests", table: S.workspaceDeletionRequests },
  // The security log, with any address fingerprint left out (see auditForResponse).
  { key: "auditLog", table: S.auditLog, derive: (r) => auditForResponse(typeof r.targetId === "string" ? r.targetId : null, r.data) },
];

/** Tables with an org_id that are deliberately not exported, and why. */
export const NOT_EXPORTED: Record<string, string> = {
  jobs: "the platform's internal work queue, not workspace data",
};

const isColumn = (v: unknown): boolean => !!v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string" && "table" in (v as object);

/** The columns of a table that an export may contain, by property name. */
export function exportedColumns(spec: TableSpec): Record<string, AnyColumn> {
  const out: Record<string, AnyColumn> = {};
  for (const [prop, col] of Object.entries(spec.table as Record<string, unknown>)) {
    if (!isColumn(col)) continue;
    if (spec.omit?.includes(prop)) continue;
    if (SECRET_COLUMN.test(prop) && !spec.keep?.includes(prop)) continue;
    out[prop] = col;
  }
  return out;
}

/** One page of one table, after `cursor` (the key values of the last row already written). */
async function page(spec: TableSpec, orgId: string, cursor: unknown[] | null, limit: number): Promise<{ rows: Record<string, unknown>[]; next: unknown[] | null }> {
  const { db } = getDb();
  const t = spec.table;
  const keys: AnyColumn[] = spec.cursor ?? [t.id];
  const shown = exportedColumns(spec);
  // Selected for paging / deriving only; removed again before the row is written.
  const extra: Record<string, AnyColumn> = {};
  keys.forEach((k, i) => (extra[`__k${i}`] = k));
  for (const prop of spec.deriveFrom ?? []) extra[`__d_${prop}`] = t[prop];
  const scope = spec.scope ? spec.scope(orgId) : eq(t.orgId, orgId);
  const after = !cursor
    ? sql`true`
    : keys.length === 1
      ? gt(keys[0], cursor[0])
      : sql`(${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) > (${sql.join(cursor.map((v) => sql`${v}::uuid`), sql`, `)})`;
  const raw = (await db
    .select({ ...shown, ...extra })
    .from(t)
    .where(and(scope, after))
    .orderBy(...keys)
    .limit(limit)) as Record<string, unknown>[];
  const rows = raw.map((r) => {
    const row: Record<string, unknown> = {};
    for (const k of Object.keys(shown)) row[k] = r[k];
    if (spec.derive) {
      const src: Record<string, unknown> = { ...row };
      for (const prop of spec.deriveFrom ?? []) src[prop] = r[`__d_${prop}`];
      Object.assign(row, spec.derive(src));
    }
    return row;
  });
  const last = raw[raw.length - 1];
  return { rows, next: raw.length === limit && last ? keys.map((_k, i) => last[`__k${i}`]) : null };
}

export interface ExportResult {
  complete: boolean;
  aborted?: boolean;
  counts: Record<string, number>;
  bytes: number;
  error?: string;
}

/**
 * The export as a sequence of JSON fragments which, concatenated, are one JSON document:
 *
 *   { "export": {...}, "organization": {...}, "<table>": [...], ..., "summary": { "complete": true, "counts": {...} } }
 *
 * If reading fails part-way the document is still closed properly and says so:
 * `"error": {...}` and `"summary": { "complete": false }`. A partial export never looks
 * like a complete one.
 */
export async function* exportWorkspaceFragments(org: Organization, opts: { pageSize?: number; result?: ExportResult } = {}): AsyncGenerator<string, void, void> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? EXPORT_PAGE_SIZE, 1), EXPORT_PAGE_SIZE);
  const result = opts.result ?? { complete: false, counts: {}, bytes: 0 };
  const organization = { id: org.id, name: org.name, slug: org.slug, plan: org.plan, planLimits: org.planLimits, status: org.status, settings: org.settings, createdAt: org.createdAt };
  yield `{"export":${JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, generatedAt: new Date().toISOString(), workspaceId: org.id, workspaceName: org.name, excluded: "Passwords, two-factor secrets, API key values, link and tracking tokens, and saved credentials (senders, integrations, webhook secrets) are never exported." })}`;
  yield `,"organization":${JSON.stringify(organization)}`;
  let open = false;
  try {
    for (const spec of EXPORT_TABLES) {
      yield `,${JSON.stringify(spec.key)}:[`;
      open = true;
      let cursor: unknown[] | null = null;
      let n = 0;
      for (;;) {
        const p = await page(spec, org.id, cursor, pageSize);
        if (p.rows.length) {
          yield (n > 0 ? "," : "") + p.rows.map((r) => JSON.stringify(r)).join(",");
          n += p.rows.length;
        }
        if (!p.next) break;
        cursor = p.next;
      }
      result.counts[spec.key] = n;
      yield "]";
      open = false;
    }
    result.complete = true;
    yield `,"summary":${JSON.stringify({ complete: true, counts: result.counts, finishedAt: new Date().toISOString() })}}`;
  } catch (e) {
    // The response is already under way, so the status cannot change. The document is
    // closed as valid JSON that states, in words, that it is incomplete.
    result.complete = false;
    result.error = (e as Error).name || "Error";
    console.error(`[account] export of workspace ${org.id} stopped early: ${result.error}`);
    yield `${open ? "]" : ""},"error":${JSON.stringify({ code: "export_incomplete", message: "The export stopped before it finished, so this file is incomplete. Please run the export again." })},"summary":${JSON.stringify({ complete: false, counts: result.counts })}}`;
  }
}

/**
 * The export as a byte stream for a Response. Pull-based: the next page is read from the
 * database only when the client has taken what was already produced. `onDone` is called
 * exactly once - when the document is finished, or when the client goes away first.
 */
export function exportWorkspaceStream(org: Organization, opts: { pageSize?: number; onDone?: (r: ExportResult) => void | Promise<void> } = {}): ReadableStream<Uint8Array> {
  const result: ExportResult = { complete: false, counts: {}, bytes: 0 };
  const gen = exportWorkspaceFragments(org, { pageSize: opts.pageSize, result });
  const enc = new TextEncoder();
  let finished = false;
  const done = async (aborted: boolean) => {
    if (finished) return;
    finished = true;
    if (aborted) result.aborted = true;
    try {
      await opts.onDone?.(result);
    } catch {
      // reporting the outcome must not break the response
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { value, done: end } = await gen.next();
          if (end) {
            await done(false);
            controller.close();
            return;
          }
          const bytes = enc.encode(value);
          result.bytes += bytes.byteLength;
          controller.enqueue(bytes);
        } catch (e) {
          await done(true);
          controller.error(e);
        }
      },
      async cancel() {
        await gen.return().catch(() => {});
        await done(true);
      },
    },
    // No read-ahead: one fragment in flight at a time.
    { highWaterMark: 0 },
  );
}
