/**
 * API key lifecycle: 256-bit keys, expiry, rotation with an overlap, and the product events a
 * key and a sign-in record.
 *
 * Through the real app (createApp) and a real database, in its own Postgres schema. Mail is
 * captured and `fetch` is blocked: nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/apikeys.lifecycle.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "apikeys_lifecycle";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.MAIL_FROM = "Scout <no-reply@platform.test>";
  process.env.APP_URL = "https://app.scout.test";
  process.env.API_URL = "https://api.scout.test";
  process.env.ADMIN_API_TOKEN = randomBytes(24).toString("hex");
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "OUTBOUND_SENDING_ENABLED"]) delete process.env[k];
}

const mocks = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    // A platform mailer "exists", so security notices are composed (and captured, never sent).
    systemMailerConfig: () => ({ provider: "resend" as const, resendApiKey: "re_test_platform_key" }),
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string; text: string }) => {
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Math.random().toString(36).slice(2)}` };
    }),
  };
});

if (!TEST_DB) process.stderr.write(`\n[!] API key lifecycle tests did NOT run: TEST_DATABASE_URL is not set.\n`);

const suite = TEST_DB ? describe : describe.skip;

suite("API key lifecycle", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let authLib: typeof import("./lib/auth.js");
  let limits: typeof import("./lib/limits.js");
  let pool: typeof import("./lib/passwordWorkers.js");
  const realFetch = globalThis.fetch;
  const PASSWORD = "correct-horse-battery";
  const u8 = () => randomUUID().slice(0, 8);
  const DAY = 24 * 60 * 60 * 1000;
  let ipSeq = 0;
  const ip = () => `203.0.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

  async function req(method: string, path: string, token?: string | null, body?: unknown) {
    const auth = token ? (token.startsWith("px_") ? { "x-api-key": token } : { authorization: `Bearer ${token}` }) : {};
    const res: Response = await app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }

  type Org = { token: string; orgId: string; userId: string; email: string; apiKey: string };
  async function signup(name: string): Promise<Org> {
    const email = `${name}-${u8()}@example.com`;
    const r = await req("POST", "/v1/auth/signup", null, { email, password: PASSWORD, orgName: `${name} ${u8()}` });
    expect(r.status).toBe(201);
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id, email, apiKey: r.body.apiKey };
  }
  const keyRow = async (id: string) => (await db.select().from(S.apiKeys).where(S.eq(S.apiKeys.id, id)))[0];
  const listed = async (o: Org, id: string) => (await req("GET", "/v1/auth/api-keys", o.token)).body.apiKeys.find((k: any) => k.id === id);
  const works = async (key: string) => (await req("GET", "/v1/auth/me", key)).status;
  /** Product events are written fire-and-forget; give the insert a moment. */
  async function eventsFor(where: string, want = 1) {
    for (let i = 0; i < 40; i++) {
      const rows = [...(await db.execute(S.sql.raw(`SELECT name, org_id, user_id, props FROM product_events WHERE ${where}`)))];
      if (rows.length >= want) return rows as any[];
      await new Promise((r) => setTimeout(r, 25));
    }
    return [...(await db.execute(S.sql.raw(`SELECT name, org_id, user_id, props FROM product_events WHERE ${where}`)))] as any[];
  }

  beforeAll(async () => {
    try {
      const { default: postgres } = await import("postgres");
      const adminSql = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
      await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
      await adminSql.end({ timeout: 2 });
      process.env.DATABASE_URL = `${TEST_DB}${TEST_DB!.includes("?") ? "&" : "?"}search_path=${SCHEMA}`;
    } catch {
      process.env.DATABASE_URL = TEST_DB;
    }
    vi.stubGlobal("fetch", (async () => {
      throw new Error("apikeys.lifecycle: outbound fetch is blocked in this test");
    }) as unknown as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    authLib = await import("./lib/auth.js");
    limits = await import("./lib/limits.js");
    pool = await import("./lib/passwordWorkers.js");
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    mocks.sent.length = 0;
    delete process.env.ROW_CAP_APIKEYS;
    limits.resetReservations();
  });

  afterAll(async () => {
    vi.stubGlobal("fetch", realFetch);
    await pool.stopPasswordWorkers();
  });

  it("new keys carry 256 bits of randomness, and a key of the old length still works", async () => {
    const o = await signup("bits");
    // The key handed out at signup is a new one too.
    expect(o.apiKey.slice("px_live_".length).length).toBeGreaterThanOrEqual(43);
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "CI" });
    expect(k.status).toBe(201);
    const body = k.body.key.slice("px_live_".length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(Buffer.from(body, "base64url").length).toBe(32);
    expect(k.body.prefix).toBe(k.body.key.slice(0, 12));
    expect(k.body.expiresAt).toBeNull();
    expect(await works(k.body.key)).toBe(200);
    // A 24-byte key, as issued before this release, is found by its hash like any other.
    const legacy = `px_live_${randomBytes(24).toString("base64url")}`;
    await db.insert(S.apiKeys).values({ orgId: o.orgId, name: "Legacy", prefix: legacy.slice(0, 12), keyHash: createHash("sha256").update(legacy).digest("hex") });
    expect(await works(legacy)).toBe(200);
  });

  it("expiresInDays: 1 to 730 days, or never; anything else is refused", async () => {
    const o = await signup("bounds");
    for (const bad of [0, -1, 731, 1.5, "30"]) {
      const r = await req("POST", "/v1/auth/api-keys", o.token, { name: "Bad", expiresInDays: bad });
      expect(r.status, `expiresInDays ${JSON.stringify(bad)}`).toBe(400);
    }
    const before = Date.now();
    const one = await req("POST", "/v1/auth/api-keys", o.token, { name: "One day", expiresInDays: 1 });
    expect(one.status).toBe(201);
    expect(Math.abs(new Date(one.body.expiresAt).getTime() - (before + DAY))).toBeLessThan(60_000);
    const max = await req("POST", "/v1/auth/api-keys", o.token, { name: "Two years", expiresInDays: 730 });
    expect(max.status).toBe(201);
    expect(Math.abs(new Date(max.body.expiresAt).getTime() - (before + 730 * DAY))).toBeLessThan(60_000);
    const never = await req("POST", "/v1/auth/api-keys", o.token, { name: "Never", expiresInDays: null });
    expect(never.status).toBe(201);
    expect(never.body.expiresAt).toBeNull();
    // Who made it is stored.
    expect((await keyRow(one.body.id)).createdBy).toBe(o.userId);
    // The list says when, and how it stands: one day left is "expiring", two years is "active".
    expect((await listed(o, one.body.id)).status).toBe("expiring");
    expect((await listed(o, max.body.id)).status).toBe("active");
    expect((await listed(o, never.body.id))).toMatchObject({ status: "active", expiresAt: null, rotatedFromId: null });
  });

  it("an expired key and a revoked key get the same 401 as a key that never existed", async () => {
    const o = await signup("expired");
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "Short", expiresInDays: 30 });
    expect(await works(k.body.key)).toBe(200);
    await db.update(S.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(S.eq(S.apiKeys.id, k.body.id));
    const expired = await req("GET", "/v1/auth/me", k.body.key);
    const unknown = await req("GET", "/v1/auth/me", `px_live_${randomBytes(32).toString("base64url")}`);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("unauthorized");
    // Nothing in the answer says the key once worked.
    expect(expired.body.error.message).toBe(unknown.body.error.message);
    expect((await listed(o, k.body.id)).status).toBe("expired");

    const r = await req("POST", "/v1/auth/api-keys", o.token, { name: "Revoke me" });
    expect((await req("DELETE", `/v1/auth/api-keys/${r.body.id}`, o.token)).status).toBe(200);
    const revoked = await req("GET", "/v1/auth/me", r.body.key);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.message).toBe(unknown.body.error.message);
    expect((await listed(o, r.body.id)).status).toBe("revoked");
  });

  it("a read-only key still cannot write (403 insufficient_scope)", async () => {
    const o = await signup("readonly");
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "Reader", scope: "read", expiresInDays: 90 });
    expect(k.body.scope).toBe("read");
    expect(await works(k.body.key)).toBe(200);
    const w = await req("PATCH", "/v1/auth/org", k.body.key, { name: "Renamed" });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe("insufficient_scope");
  });

  it("rotate with an overlap: both keys work, then the old one stops when the overlap ends", async () => {
    const o = await signup("overlap");
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "Deploy", scope: "read" });
    const before = Date.now();
    const r = await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, o.token, { overlapMinutes: 60 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "Deploy", scope: "read", rotatedFromId: k.body.id, expiresAt: null, previous: { id: k.body.id, revoked: false } });
    expect(r.body.key).not.toBe(k.body.key);
    expect(r.body.key.slice("px_live_".length).length).toBeGreaterThanOrEqual(43);
    const until = new Date(r.body.previous.worksUntil).getTime();
    expect(Math.abs(until - (before + 60 * 60_000))).toBeLessThan(60_000);
    // Both work during the overlap.
    expect(await works(k.body.key)).toBe(200);
    expect(await works(r.body.key)).toBe(200);
    const oldRow = await keyRow(k.body.id);
    expect(oldRow.revokedAt).toBeNull();
    const newRow = await keyRow(r.body.id);
    expect(newRow).toMatchObject({ rotatedFromId: k.body.id, scopes: ["read"], createdBy: o.userId });
    expect((await listed(o, k.body.id)).status).toBe("expiring");
    expect((await listed(o, r.body.id))).toMatchObject({ status: "active", rotatedFromId: k.body.id });
    // The overlap ends (moved into the past rather than waiting an hour): the old key is refused.
    await db.update(S.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(S.eq(S.apiKeys.id, k.body.id));
    expect(await works(k.body.key)).toBe(401);
    expect(await works(r.body.key)).toBe(200);
    // Audited with prefixes only; the key itself is nowhere in the row.
    const audits = [...(await db.execute(S.sql`SELECT data FROM audit_log WHERE org_id = ${o.orgId} AND action = 'apikey.rotated'`))] as any[];
    expect(audits).toHaveLength(1);
    expect(audits[0].data).toMatchObject({ prefix: r.body.prefix, previousPrefix: k.body.prefix, overlapMinutes: 60 });
    expect(JSON.stringify(audits[0].data)).not.toContain(r.body.key);
    // The owner is told, as for a created key; the mail carries no key.
    for (let i = 0; i < 40 && !mocks.sent.some((m) => m.to === o.email && m.text.includes(r.body.prefix)); i++) await new Promise((res) => setTimeout(res, 25));
    const notice = mocks.sent.find((m) => m.to === o.email && m.text.includes(r.body.prefix));
    expect(notice).toBeTruthy();
    expect(notice!.text).not.toContain(r.body.key);
  });

  it("an overlap never extends a key that was due to expire sooner", async () => {
    const o = await signup("soon");
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "Soon", expiresInDays: 30 });
    const soon = new Date(Date.now() + 10 * 60_000);
    await db.update(S.apiKeys).set({ expiresAt: soon }).where(S.eq(S.apiKeys.id, k.body.id));
    const r = await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, o.token, { overlapMinutes: 1440 });
    expect(r.status).toBe(201);
    expect(new Date(r.body.previous.worksUntil).getTime()).toBe(soon.getTime());
    expect((await keyRow(k.body.id)).expiresAt.getTime()).toBe(soon.getTime());
  });

  it("rotate immediately: the old key stops at once and the new one keeps the expiry policy", async () => {
    const o = await signup("immediate");
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "Thirty", expiresInDays: 30 });
    // Created a while ago: the replacement gets the same 30-day lifetime, counted from now.
    await db.update(S.apiKeys).set({ createdAt: new Date(Date.now() - 20 * DAY), expiresAt: new Date(Date.now() + 10 * DAY) }).where(S.eq(S.apiKeys.id, k.body.id));
    const before = Date.now();
    const r = await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, o.token, {});
    expect(r.status).toBe(201);
    expect(r.body.previous).toMatchObject({ revoked: true, worksUntil: null });
    expect(Math.abs(new Date(r.body.expiresAt).getTime() - (before + 30 * DAY))).toBeLessThan(60_000);
    expect(await works(k.body.key)).toBe(401);
    expect(await works(r.body.key)).toBe(200);
    expect((await keyRow(k.body.id)).revokedAt).not.toBeNull();
    expect((await listed(o, k.body.id)).status).toBe("revoked");

    // An explicit expiresInDays wins over the old key's policy, and is bounded the same way.
    const k2 = await req("POST", "/v1/auth/api-keys", o.token, { name: "Forever" });
    expect((await req("POST", `/v1/auth/api-keys/${k2.body.id}/rotate`, o.token, { expiresInDays: 731 })).status).toBe(400);
    expect((await req("POST", `/v1/auth/api-keys/${k2.body.id}/rotate`, o.token, { overlapMinutes: 1441 })).status).toBe(400);
    expect((await req("POST", `/v1/auth/api-keys/${k2.body.id}/rotate`, o.token, { overlapMinutes: -1 })).status).toBe(400);
    const r2 = await req("POST", `/v1/auth/api-keys/${k2.body.id}/rotate`, o.token, { expiresInDays: 7 });
    expect(r2.status).toBe(201);
    expect(Math.abs(new Date(r2.body.expiresAt).getTime() - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    // A key that never expired, rotated without a choice, is replaced by one that never expires.
    const k3 = await req("POST", "/v1/auth/api-keys", o.token, { name: "Never" });
    const r3 = await req("POST", `/v1/auth/api-keys/${k3.body.id}/rotate`, o.token, { overlapMinutes: 0 });
    expect(r3.body.expiresAt).toBeNull();
  });

  it("only a working key can be rotated, and only once while its replacement is live", async () => {
    const o = await signup("once");
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "Once" });
    const [a, b] = await Promise.all([0, 1].map(() => req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, o.token, { overlapMinutes: 30 })));
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((x) => x.status === 409)!.body.error.code).toBe("api_key_already_rotated");
    const successors = [...(await db.execute(S.sql`SELECT id FROM api_keys WHERE rotated_from_id = ${k.body.id}`))];
    expect(successors).toHaveLength(1);

    const revoked = await req("POST", "/v1/auth/api-keys", o.token, { name: "Gone" });
    await req("DELETE", `/v1/auth/api-keys/${revoked.body.id}`, o.token);
    const r1 = await req("POST", `/v1/auth/api-keys/${revoked.body.id}/rotate`, o.token, {});
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe("api_key_not_active");

    const expired = await req("POST", "/v1/auth/api-keys", o.token, { name: "Old", expiresInDays: 5 });
    await db.update(S.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(S.eq(S.apiKeys.id, expired.body.id));
    expect((await req("POST", `/v1/auth/api-keys/${expired.body.id}/rotate`, o.token, {})).status).toBe(409);
  });

  it("another workspace's key cannot be rotated or revoked (404), and a member cannot rotate", async () => {
    const a = await signup("tenant-a");
    const b = await signup("tenant-b");
    const k = await req("POST", "/v1/auth/api-keys", a.token, { name: "A's key" });
    const rot = await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, b.token, { overlapMinutes: 0 });
    expect(rot.status).toBe(404);
    expect((await req("DELETE", `/v1/auth/api-keys/${k.body.id}`, b.token)).status).toBe(404);
    expect((await req("POST", `/v1/auth/api-keys/not-a-uuid/rotate`, b.token, {})).status).toBe(404);
    expect((await req("POST", `/v1/auth/api-keys/${randomUUID()}/rotate`, a.token, {})).status).toBe(404);
    // Untouched: A's key still works and has no replacement.
    expect(await works(k.body.key)).toBe(200);
    const row = await keyRow(k.body.id);
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt).toBeNull();
    // An API key (even a full one) is not a person and cannot rotate keys.
    expect((await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, k.body.key, {})).status).toBe(403);
    // A member of the workspace cannot either.
    const [member] = await db.insert(S.users).values({ orgId: a.orgId, email: `member-${u8()}@example.com`, passwordHash: "!nopassword:x", name: "", role: "member" }).returning();
    const memberToken = await authLib.issueJwt(member);
    expect((await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, memberToken, {})).status).toBe(403);
  });

  it("a rotation is not refused at the workspace's key limit", async () => {
    const o = await signup("cap");
    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "At cap" });
    const live = Number((await db.execute(S.sql`SELECT count(*)::int AS n FROM api_keys WHERE org_id = ${o.orgId} AND revoked_at IS NULL`))[0].n);
    process.env.ROW_CAP_APIKEYS = String(live);
    const create = await req("POST", "/v1/auth/api-keys", o.token, { name: "One more" });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe("limit_reached");
    const r = await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, o.token, { overlapMinutes: 0 });
    expect(r.status).toBe(201);
    expect(await works(r.body.key)).toBe(200);
  });

  it("records product events without personal data", async () => {
    const o = await signup("events");
    const signups = await eventsFor(`name = 'signup' AND org_id = '${o.orgId}'`);
    expect(signups).toHaveLength(1);
    expect(signups[0]).toMatchObject({ user_id: o.userId, props: { method: "password" } });

    const k = await req("POST", "/v1/auth/api-keys", o.token, { name: "Tracked", scope: "read" });
    await req("POST", `/v1/auth/api-keys/${k.body.id}/rotate`, o.token, {});
    const created = await eventsFor(`name = 'api_key_created' AND org_id = '${o.orgId}'`, 2);
    expect(created.map((e) => e.props.kind).sort()).toEqual(["created", "rotated"]);
    expect(created.every((e) => e.props.scope === "read" && e.user_id === o.userId)).toBe(true);

    const ok = await req("POST", "/v1/auth/login", null, { email: o.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(await eventsFor(`name = 'login_succeeded' AND user_id = '${o.userId}'`)).toHaveLength(1);

    const marker = Date.now();
    const bad = await req("POST", "/v1/auth/login", null, { email: o.email, password: "wrong-password-here" });
    expect(bad.status).toBe(401);
    const failed = await eventsFor(`name = 'login_failed' AND created_at >= to_timestamp(${marker / 1000 - 1})`);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    for (const f of failed) {
      expect(f.org_id).toBeNull();
      expect(f.user_id).toBeNull();
      expect(JSON.stringify(f.props)).not.toContain(o.email);
    }
    // Nothing anywhere in the events carries the address or a key.
    const all = [...(await db.execute(S.sql`SELECT props::text AS p FROM product_events WHERE org_id = ${o.orgId} OR org_id IS NULL`))] as any[];
    for (const row of all) {
      expect(row.p).not.toContain(o.email);
      expect(row.p).not.toContain("px_live_");
    }
  });

  it("pure helpers: status and rotated expiry", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(authLib.apiKeyStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
    expect(authLib.apiKeyStatus({ revokedAt: new Date(now), expiresAt: new Date(now - 1) }, now)).toBe("revoked");
    expect(authLib.apiKeyStatus({ revokedAt: null, expiresAt: new Date(now) }, now)).toBe("expired");
    expect(authLib.apiKeyStatus({ revokedAt: null, expiresAt: new Date(now + 7 * DAY) }, now)).toBe("expiring");
    expect(authLib.apiKeyStatus({ revokedAt: null, expiresAt: new Date(now + 7 * DAY + 1) }, now)).toBe("active");
    expect(authLib.apiKeyUsable({ revokedAt: null, expiresAt: new Date(now + 1) }, now)).toBe(true);
    expect(authLib.apiKeyUsable({ revokedAt: null, expiresAt: new Date(now) }, now)).toBe(false);
    expect(authLib.rotatedExpiry({ createdAt: new Date(now - 5 * DAY), expiresAt: null }, now)).toBeNull();
    expect(authLib.rotatedExpiry({ createdAt: new Date(now - 5 * DAY), expiresAt: new Date(now + 25 * DAY) }, now)!.getTime()).toBe(now + 30 * DAY);
    // A lifetime outside what a new key could be given is brought within the bounds.
    expect(authLib.rotatedExpiry({ createdAt: new Date(now - 1000 * DAY), expiresAt: new Date(now) }, now)!.getTime()).toBe(now + 730 * DAY);
    expect(authLib.rotatedExpiry({ createdAt: new Date(now), expiresAt: new Date(now + 60_000) }, now)!.getTime()).toBe(now + DAY);
  });
});
