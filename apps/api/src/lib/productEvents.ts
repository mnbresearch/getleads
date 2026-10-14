/**
 * The platform's own product analytics: sign-ups, sign-ins, activation, pricing and checkout.
 *
 * These rows feed the admin "Growth" page and nothing else. Rules every caller relies on:
 *  - `trackProduct` never throws and never blocks a request for long. Callers write
 *    `void trackProduct(...)` and carry on; a row that cannot be written is one warning line
 *    (with no event data in it) and is forgotten.
 *  - Only a fixed set of property keys is stored, and every value is a short scalar. An email
 *    address, a token, a password or a card detail has no key to travel in, and a value that
 *    looks like an address is dropped as well, in case a caller passes one by mistake.
 *  - Page views carry no identifier at all (no org, no user, no IP); see routes/misc.ts.
 */
import { getDb, productEvents, sql } from "@prospex/db";

export const PRODUCT_EVENT_NAMES = [
  "page_view",
  "signup",
  "login_succeeded",
  "login_failed",
  "email_verified",
  "activated",
  "pricing_viewed",
  "checkout_started",
  // An upgrade asked for through the request form (the only way to upgrade without Stripe).
  "upgrade_requested",
  "checkout_completed",
  "checkout_abandoned",
  "subscription_cancelled",
  "api_key_created",
  "play_created",
  "campaign_launched",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/** The only property keys a product event may carry. Anything else is dropped. */
export const PRODUCT_PROP_KEYS = ["plan", "method", "source", "medium", "campaign", "referrer_host", "reason", "kind", "scope"] as const;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(PRODUCT_PROP_KEYS);
const MAX_STRING = 80;
const MAX_PATH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProductProps = Record<string, string | number | boolean | null>;

export interface TrackOptions {
  orgId?: string | null;
  userId?: string | null;
  path?: string | null;
  props?: ProductProps;
}

/**
 * Props reduced to what may be stored: allow-listed keys, scalar values, strings one line and
 * at most 80 characters. A string with an "@" in it is dropped: no allowed key ever needs one,
 * and it is the cheapest way to make sure an address never lands here by accident.
 */
export function sanitizeProductProps(props: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) return out;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (v === null) out[k] = null;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "string") {
      const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_STRING);
      if (s && !s.includes("@")) out[k] = s;
    }
  }
  return out;
}

/** A path fit to store: starts with "/", no query string or fragment, at most 200 characters. */
export function sanitizeProductPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const p = path.split(/[?#]/, 1)[0].replace(/[\u0000-\u001f\u007f\s]+/g, "").slice(0, MAX_PATH);
  return p.startsWith("/") ? p : null;
}

const idOrNull = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);

/** Record one product event. Never throws. */
export async function trackProduct(name: ProductEventName, opts: TrackOptions = {}): Promise<void> {
  try {
    if (!(PRODUCT_EVENT_NAMES as readonly string[]).includes(name)) return;
    const { db } = getDb();
    await db.insert(productEvents).values({
      name,
      orgId: idOrNull(opts.orgId),
      userId: idOrNull(opts.userId),
      path: opts.path == null ? null : sanitizeProductPath(opts.path),
      props: sanitizeProductProps(opts.props),
    });
  } catch (e) {
    // The event name and the error's class only: never the props, ids or the driver message
    // (which can quote the parameters).
    console.warn(`[product-events] could not record "${String(name).slice(0, 40)}": ${(e as Error)?.name ?? "error"}`);
  }
}

/**
 * Record that a workspace got real value for the first time: it saved its first lead or ran
 * its first search. Recorded once per workspace, ever; later calls do nothing. Never throws.
 *
 * The check-then-insert runs under a transaction-scoped advisory lock keyed on the workspace,
 * so two first leads saved at the same moment still record one `activated`.
 */
// Workspaces this process already knows are activated: after the first lead, every later
// lead skips the database entirely. Bounded so a very long-lived process cannot grow it forever.
const ACTIVATED_KNOWN = new Set<string>();
const ACTIVATED_KNOWN_MAX = 50_000;
const rememberActivated = (oid: string) => {
  if (ACTIVATED_KNOWN.size >= ACTIVATED_KNOWN_MAX) ACTIVATED_KNOWN.clear();
  ACTIVATED_KNOWN.add(oid);
};

export async function markActivated(orgId: string | null | undefined, userId?: string | null): Promise<boolean> {
  const oid = idOrNull(orgId);
  if (!oid) return false;
  if (ACTIVATED_KNOWN.has(oid)) return false;
  try {
    const { db } = getDb();
    // Cheap path first: almost every call is for a workspace that activated long ago.
    const seen = (await db.execute(sql`SELECT 1 FROM product_events WHERE name = 'activated' AND org_id = ${oid} LIMIT 1`)) as unknown as unknown[];
    if ([...seen].length) {
      rememberActivated(oid);
      return false;
    }
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`product:activated:${oid}`}))`);
      const again = (await tx.execute(sql`SELECT 1 FROM product_events WHERE name = 'activated' AND org_id = ${oid} LIMIT 1`)) as unknown as unknown[];
      if ([...again].length) return false;
      await tx.insert(productEvents).values({ name: "activated", orgId: oid, userId: idOrNull(userId), props: {} });
      return true;
    });
    rememberActivated(oid);
    return inserted;
  } catch (e) {
    console.warn(`[product-events] could not record "activated": ${(e as Error)?.name ?? "error"}`);
    return false;
  }
}

// ── The admin funnel ──
export const FUNNEL_STEPS = [
  ["visits", "Visits", "page_view"],
  ["pricing_views", "Pricing views", "pricing_viewed"],
  ["signups", "Sign-ups", "signup"],
  ["verified", "Email confirmed", "email_verified"],
  ["activated", "Activated", "activated"],
  ["checkout_started", "Checkout started", "checkout_started"],
  ["paid", "Paid", "checkout_completed"],
] as const;
export type FunnelStepKey = (typeof FUNNEL_STEPS)[number][0];

export interface ProductFunnel {
  range: { days: number; from: string; to: string };
  steps: { key: FunnelStepKey; label: string; count: number }[];
  /** From each step to the next: `rate` is 0-1, or null when the earlier step is zero. */
  conversion: { from: FunnelStepKey; to: FunnelStepKey; rate: number | null }[];
  daily: ({ day: string } & Record<FunnelStepKey, number>)[];
  referrers: { host: string; count: number }[];
  sources: { source: string; count: number }[];
  logins: { succeeded: number; failed: number };
  apiKeys: { active: number; usedInRange: number };
  abandonedCheckouts: number;
  subscriptionsCancelled: number;
}

const rowsOf = <T>(r: unknown): T[] => [...((Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as T[])];

/**
 * The platform funnel over the last `days` days, every number a count. Visits and pricing
 * views are counted views, not people: page views carry no identifier, by design.
 */
export async function productFunnel(days: number): Promise<ProductFunnel> {
  const { db } = getDb();
  const d = Math.min(365, Math.max(1, Math.floor(days)));
  const since = sql.raw(`(now() - interval '${d} days')`);
  const names = FUNNEL_STEPS.map(([, , n]) => n);
  const inList = sql.join(names.map((n) => sql`${n}`), sql`, `);
  const totals = rowsOf<{ name: string; n: number }>(
    await db.execute(sql`SELECT name, count(*)::int AS n FROM product_events WHERE created_at >= ${since} AND name IN (${inList}) GROUP BY name`),
  );
  const byName = new Map(totals.map((r) => [r.name, Number(r.n)]));
  const steps = FUNNEL_STEPS.map(([key, label, name]) => ({ key, label, count: byName.get(name) ?? 0 }));
  const conversion = steps.slice(1).map((s, i) => ({ from: steps[i].key, to: s.key, rate: steps[i].count > 0 ? Math.round((s.count / steps[i].count) * 1000) / 1000 : null }));

  const dailyRows = rowsOf<{ day: string; name: string; n: number }>(
    await db.execute(sql`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, name, count(*)::int AS n
      FROM product_events WHERE created_at >= ${since} AND name IN (${inList})
      GROUP BY 1, 2`),
  );
  const dayMap = new Map<string, Record<string, number>>();
  for (const r of dailyRows) {
    const m = dayMap.get(r.day) ?? {};
    m[r.name] = Number(r.n);
    dayMap.set(r.day, m);
  }
  const daily: ProductFunnel["daily"] = [];
  const today = new Date();
  for (let i = d - 1; i >= 0; i--) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10);
    const m = dayMap.get(day) ?? {};
    const row = { day } as { day: string } & Record<FunnelStepKey, number>;
    for (const [key, , name] of FUNNEL_STEPS) row[key] = m[name] ?? 0;
    daily.push(row);
  }

  const referrers = rowsOf<{ host: string; n: number }>(
    await db.execute(sql`
      SELECT props->>'referrer_host' AS host, count(*)::int AS n FROM product_events
      WHERE created_at >= ${since} AND name IN ('page_view', 'pricing_viewed') AND props ? 'referrer_host'
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`),
  ).map((r) => ({ host: String(r.host), count: Number(r.n) }));
  const sources = rowsOf<{ source: string; n: number }>(
    await db.execute(sql`
      SELECT props->>'source' AS source, count(*)::int AS n FROM product_events
      WHERE created_at >= ${since} AND name IN ('page_view', 'pricing_viewed') AND props ? 'source'
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`),
  ).map((r) => ({ source: String(r.source), count: Number(r.n) }));

  const [other] = rowsOf<{ ok: number; bad: number; abandoned: number; cancelled: number }>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE name = 'login_succeeded')::int AS ok,
             count(*) FILTER (WHERE name = 'login_failed')::int AS bad,
             count(*) FILTER (WHERE name = 'checkout_abandoned')::int AS abandoned,
             count(*) FILTER (WHERE name = 'subscription_cancelled')::int AS cancelled
      FROM product_events WHERE created_at >= ${since} AND name IN ('login_succeeded', 'login_failed', 'checkout_abandoned', 'subscription_cancelled')`),
  );
  const [keys] = rowsOf<{ active: number; used: number }>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::int AS active,
             count(*) FILTER (WHERE last_used_at >= ${since})::int AS used
      FROM api_keys`),
  );
  const to = new Date();
  return {
    range: { days: d, from: new Date(to.getTime() - d * 86_400_000).toISOString(), to: to.toISOString() },
    steps,
    conversion,
    daily,
    referrers,
    sources,
    logins: { succeeded: Number(other?.ok ?? 0), failed: Number(other?.bad ?? 0) },
    apiKeys: { active: Number(keys?.active ?? 0), usedInRange: Number(keys?.used ?? 0) },
    abandonedCheckouts: Number(other?.abandoned ?? 0),
    subscriptionsCancelled: Number(other?.cancelled ?? 0),
  };
}
