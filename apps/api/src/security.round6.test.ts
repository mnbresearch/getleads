/**
 * Round 6: what a negative-path pass found, each pinned by a test.
 *
 *  1. password hashing runs on worker threads, keeps every existing hash valid, and falls
 *     back to the main thread when a worker dies;
 *  2. per-workspace ceilings (rows and queued jobs) hold when requests arrive together;
 *  3. log lines carry no customer text, addresses or statements (the search log is covered in
 *     packages/core/src/search/webSearchDetailed.test.ts);
 *  4. a webhook's path never reaches a log line or a stored job error - only its origin;
 *  5. a database outage is a 503 that says to try again, never a 401 or a 500;
 *  6. (the purge of sign-in attempt rows is in security.privacy.test.ts, with the purge);
 *  7. the standalone "find email" tool honours the platform's do-not-contact list;
 *  8. a create refused because the queue is full saves nothing, and says when to retry;
 *  9. LIST_QUERY_TIMEOUT_MS is clamped, not ignored;
 * 10. no security-log response carries an address fingerprint;
 * 11. the mailing address cannot carry invisible or direction-changing characters;
 * 12. invitations sent together cannot exceed the seats;
 * 14. hourly mail allowances are shared across instances; an address as a parameter name is
 *     not logged; an address with unusual characters can be erased by the admin.
 *
 * Through the real app (createApp) and a real database, in its own Postgres schema. `fetch`
 * is stubbed and mail is captured: nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "sec_round6";
const ADMIN_TOKEN = randomBytes(24).toString("hex");

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
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "OUTBOUND_SENDING_ENABLED", "DEBUG_SEARCH", "LIST_QUERY_TIMEOUT_MS", "PASSWORD_HASH_CONCURRENCY"]) delete process.env[k];
}

type Sent = { to: string; from: string; subject: string; text: string };
const mocks = vi.hoisted(() => ({ sent: [] as { to: string; from: string; subject: string; text: string }[], platformMailer: false, findEmail: null as null | ((...a: unknown[]) => unknown) }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    systemMailerConfig: () => (mocks.platformMailer ? { provider: "resend" as const, resendApiKey: "re_test_platform_key" } : orig.systemMailerConfig()),
    sendMail: vi.fn(async (_cfg: unknown, input: Sent) => {
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Math.random().toString(36).slice(2)}` };
    }),
  };
});
// Only `findEmail` is replaced, and only while a test sets one: everything else is the real package.
vi.mock("@prospex/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@prospex/core")>();
  return { ...orig, findEmail: (...a: unknown[]) => (mocks.findEmail ? mocks.findEmail(...a) : (orig.findEmail as (...x: unknown[]) => unknown)(...a)) };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] "round 6" did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests for password workers, parallel limits, outage answers and log contents.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("round 6: negative-path findings", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db
  let limits: typeof import("./lib/limits.js");
  let authLib: typeof import("./lib/auth.js");
  let pool: typeof import("./lib/passwordWorkers.js");
  let rateWindow: typeof import("./lib/rateWindow.js");
  let jobHandlers: any;

  const PASSWORD = "correct-horse-battery";
  const u8 = () => randomUUID().slice(0, 8);
  const rows = (r: any): any[] => (Array.isArray(r) ? [...r] : (r?.rows ?? []));
  const q = async (strings: TemplateStringsArray, ...values: unknown[]) => rows(await db.execute(S.sql(strings, ...values)));
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const realFetch = globalThis.fetch;
  const net = { calls: [] as { url: string }[], answer: null as null | ((url: string, init?: RequestInit) => Response | null) };
  const tally = (rs: { status: number; body: any }[]) => {
    const t: Record<string, number> = {};
    for (const r of rs) {
      const k = `${r.status}${r.body?.error?.code ? `:${r.body.error.code}` : ""}`;
      t[k] = (t[k] ?? 0) + 1;
    }
    return t;
  };

  async function req(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const auth = token ? (token.startsWith("px_") ? { "x-api-key": token } : { authorization: `Bearer ${token}` }) : {};
    const res: Response = await app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, headers: res.headers as Headers };
  }
  const admin = (method: string, path: string, body?: unknown) => req(method, `/v1/admin${path}`, null, body, { "x-admin-token": ADMIN_TOKEN });

  type Org = { token: string; orgId: string; userId: string; email: string; apiKey: string };
  async function signup(name: string, limitsPatch: Record<string, unknown> = {}): Promise<Org> {
    const email = `${name}-${u8()}@example.com`;
    const r = await req("POST", "/v1/auth/signup", null, { email, password: PASSWORD, orgName: `${name} ${u8()}` });
    expect(r.status).toBe(201);
    const orgId = r.body.org.id as string;
    await db.update(S.organizations).set({ plan: "scale", planLimits: { ...S.limitsFor("scale"), ...limitsPatch } }).where(S.eq(S.organizations.id, orgId));
    return { token: r.body.token, orgId, userId: r.body.user.id, email, apiKey: r.body.apiKey };
  }
  const countOf = async (table: string, orgId: string, extra = "") => (await db.execute(S.sql.raw(`SELECT count(*)::int AS n FROM "${table}" WHERE org_id = '${orgId}'${extra}`)))[0].n as number;
  const openJobs = async (orgId: string, type?: string) =>
    (await db.execute(S.sql.raw(`SELECT count(*)::int AS n FROM jobs WHERE org_id = '${orgId}' AND status IN ('queued','running')${type ? ` AND type = '${type}'` : ""}`)))[0].n as number;
  /** Something a database that cannot be reached throws, as the ORM hands it on. */
  const outage = () => Object.assign(new Error('Failed query: select "id", "email" from "users" where "users"."id" = $1 params: sara.outage@example.com'), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }) });

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
    vi.stubGlobal("fetch", (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? input);
      net.calls.push({ url });
      const res = net.answer?.(url, init);
      if (res) return res;
      throw new Error("security.round6: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    limits = await import("./lib/limits.js");
    authLib = await import("./lib/auth.js");
    pool = await import("./lib/passwordWorkers.js");
    rateWindow = await import("./lib/rateWindow.js");
    ({ handlers: jobHandlers } = await import("./jobs.js"));
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    mocks.sent.length = 0;
    mocks.platformMailer = false;
    mocks.findEmail = null;
    net.calls.length = 0;
    net.answer = null;
    for (const k of Object.keys(process.env)) if (k.startsWith("ROW_CAP_") || k.startsWith("JOB_OPEN_")) delete process.env[k];
    limits.resetReservations();
    rateWindow.resetWindows();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.stubGlobal("fetch", realFetch);
    await pool.stopPasswordWorkers();
  });

  // ── 1. Password hashing on worker threads ──────────────────────────────────────────
  describe("password hashing on worker threads", () => {
    const bcrypt = createRequire(import.meta.url)("bcryptjs") as { hashSync: (p: string, r: number) => string; compareSync: (p: string, h: string) => boolean };

    it("every existing hash still verifies, new hashes are ordinary bcrypt, and the work is done off the main thread", async () => {
      pool.resetPasswordWorkers();
      // Hashes as this product has always stored them: made by the library, on the main thread.
      const stored = [bcrypt.hashSync("first-password-1", 10), bcrypt.hashSync("s3cond pässword ✓", 10), bcrypt.hashSync("x".repeat(72), 10)];
      const before = { ...pool.passwordWorkerStats };
      expect(await authLib.checkPassword("first-password-1", stored[0])).toBe(true);
      expect(await authLib.checkPassword("first-password-2", stored[0])).toBe(false);
      expect(await authLib.checkPassword("s3cond pässword ✓", stored[1])).toBe(true);
      expect(await authLib.checkPassword("x".repeat(72), stored[2])).toBe(true);
      const fresh = await authLib.hashPassword("brand-new-password");
      expect(fresh).toMatch(/^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/);
      // ...and the library itself, on the main thread, agrees with what the worker made.
      expect(bcrypt.compareSync("brand-new-password", fresh)).toBe(true);
      expect(bcrypt.compareSync("brand-new-passw0rd", fresh)).toBe(false);
      // An account with no password never matches, and never costs a hash.
      const none = await authLib.unusablePasswordHash("google-sub");
      expect(none.startsWith(authLib.NO_PASSWORD_PREFIX)).toBe(true);
      expect(await authLib.checkPassword("anything", none)).toBe(false);
      await authLib.burnPasswordCheck("whatever");
      expect(pool.passwordWorkerStats.tasks - before.tasks).toBeGreaterThanOrEqual(7);
      expect(pool.passwordWorkerStats.fallbacks - before.fallbacks).toBe(0);
      expect(pool.passwordWorkerThreads().length).toBeGreaterThanOrEqual(1);
      expect(pool.passwordWorkerThreads().length).toBeLessThanOrEqual(2);
    });

    it("a burst is spread over at most PASSWORD_HASH_CONCURRENCY workers and every answer is right", async () => {
      pool.resetPasswordWorkers();
      const good = bcrypt.hashSync("burst-password", 10);
      const before = { ...pool.passwordWorkerStats };
      const answers = await Promise.all(Array.from({ length: 24 }, (_, i) => authLib.checkPassword(i % 3 === 0 ? "burst-password" : `wrong-${i}`, good)));
      expect(answers).toEqual(Array.from({ length: 24 }, (_, i) => i % 3 === 0));
      expect(pool.passwordWorkerStats.tasks - before.tasks).toBe(24);
      expect(pool.passwordWorkerStats.fallbacks - before.fallbacks).toBe(0);
      expect(pool.passwordWorkerThreads().length).toBeLessThanOrEqual(2);
    });

    it("a worker that dies mid-task costs nothing: the check finishes on the main thread, with one log line", async () => {
      pool.resetPasswordWorkers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Twelve rounds: long enough for the worker to be killed while it is still working.
      const slow = bcrypt.hashSync("slow-password", 12);
      await authLib.checkPassword("warm-up", bcrypt.hashSync("warm-up", 4)); // make sure a worker exists
      const before = { ...pool.passwordWorkerStats };
      const pending = [authLib.checkPassword("slow-password", slow), authLib.checkPassword("not-it", slow)];
      await new Promise((r) => setTimeout(r, 25));
      const killed = pool.passwordWorkerThreads();
      expect(killed.length).toBeGreaterThanOrEqual(1);
      await Promise.all(killed.map((w) => w.terminate()));
      expect(await Promise.all(pending)).toEqual([true, false]);
      expect(pool.passwordWorkerStats.fallbacks - before.fallbacks).toBeGreaterThanOrEqual(1);
      expect(pool.passwordWorkerStats.failures - before.failures).toBeGreaterThanOrEqual(1);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[auth] password hashing is running on the main thread"));
      expect(lines).toHaveLength(1);
      // While the pool is resting, sign-in still works (main thread), and says nothing more.
      const mid = { ...pool.passwordWorkerStats };
      expect(await authLib.checkPassword("first", bcrypt.hashSync("first", 4))).toBe(true);
      expect(pool.passwordWorkerStats.fallbacks - mid.fallbacks).toBe(1);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[auth] password hashing"))).toHaveLength(1);
      // ...and once it is tried again, the work is back on a worker.
      pool.resetPasswordWorkers();
      const after = { ...pool.passwordWorkerStats };
      expect(await authLib.checkPassword("slow-password", slow)).toBe(true);
      expect(pool.passwordWorkerStats.tasks - after.tasks).toBe(1);
      expect(pool.passwordWorkerStats.fallbacks - after.fallbacks).toBe(0);
    }, 30_000);

    it("a malformed stored hash is an answer about the hash, not a broken worker", async () => {
      pool.resetPasswordWorkers();
      const before = { ...pool.passwordWorkerStats };
      // bcryptjs answers false for a string that is not a hash; the pool must hand that on unchanged.
      expect(await authLib.checkPassword("x", "not-a-bcrypt-hash")).toBe(false);
      expect(pool.passwordWorkerStats.failures - before.failures).toBe(0);
    });

    it("graceful shutdown ends the workers; a sign-in still in flight afterwards finishes on the main thread", async () => {
      pool.resetPasswordWorkers();
      await authLib.checkPassword("warm-up", bcrypt.hashSync("warm-up", 4));
      const live = pool.passwordWorkerThreads();
      expect(live.length).toBeGreaterThanOrEqual(1);
      const exited = Promise.all(live.map((w) => new Promise<number>((r) => w.once("exit", r))));
      const { gracefulShutdown } = await import("./shutdown.js");
      const lines: string[] = [];
      await gracefulShutdown({ graceMs: 1000, closePool: async () => {}, log: (l) => lines.push(l) });
      await exited;
      expect(pool.passwordWorkerThreads()).toHaveLength(0);
      const before = { ...pool.passwordWorkerStats };
      expect(await authLib.checkPassword("late", bcrypt.hashSync("late", 4))).toBe(true);
      expect(pool.passwordWorkerStats.fallbacks - before.fallbacks).toBe(1);
      expect(pool.passwordWorkerThreads()).toHaveLength(0);
      pool.resetPasswordWorkers();
    });

    it("sign-in through the API uses the pool end to end", async () => {
      pool.resetPasswordWorkers();
      const o = await signup("pool-signin");
      const before = { ...pool.passwordWorkerStats };
      const ok = await req("POST", "/v1/auth/login", null, { email: o.email, password: PASSWORD });
      expect(ok.status).toBe(200);
      const bad = await req("POST", "/v1/auth/login", null, { email: o.email, password: "not-the-password" });
      expect(bad.status).toBe(401);
      const nobody = await req("POST", "/v1/auth/login", null, { email: `nobody-${u8()}@example.com`, password: "some-password-1" });
      expect(nobody.status).toBe(401);
      expect(pool.passwordWorkerStats.tasks - before.tasks).toBeGreaterThanOrEqual(3);
      expect(pool.passwordWorkerStats.fallbacks - before.fallbacks).toBe(0);
    });
  });

  // ── 2. Ceilings under parallel requests ────────────────────────────────────────────
  describe("per-workspace ceilings hold for requests that arrive together", () => {
    it("40 parallel creates of each kind never leave more rows than the cap, and the cap itself stays reachable", async () => {
      const o = await signup("caps");
      const types = (await req("GET", "/v1/signals/types", o.token)).body.types;
      const sigType = typeof types[0] === "string" ? types[0] : (types[0].id ?? types[0].type);
      const kinds: [string, string, number, string, (i: number) => [string, unknown], string?][] = [
        ["LISTS", "lists", 5, "lists", (i) => ["/v1/leads/lists", { name: `L${i}` }]],
        ["WEBHOOKS", "webhooks", 3, "webhooks", (i) => ["/v1/webhooks", { url: `https://hooks.round6-test.example/in/${i}` }]],
        ["APIKEYS", "API keys", 4, "api_keys", (i) => ["/v1/auth/api-keys", { name: `K${i}`, scope: "read" }], " AND revoked_at IS NULL"],
        ["CLIENTS", "clients", 4, "clients", (i) => ["/v1/clients", { name: `C${i}` }]],
        ["ICPS", "ICPs", 3, "icps", (i) => ["/v1/icps", { name: `I${i}`, buildWithAi: false }]],
        ["PIXELS", "pixels", 3, "pixels", (i) => ["/v1/visitors/pixels", { name: `P${i}` }]],
        ["TASKS", "tasks", 6, "tasks", (i) => ["/v1/tools/tasks", { title: `T${i}` }]],
        ["CAMPAIGNS", "campaigns", 3, "campaigns", (i) => ["/v1/campaigns", { name: `Camp${i}` }]],
        ["SAVEDSEARCHES", "saved searches", 3, "saved_searches", (i) => ["/v1/tools/saved-searches", { name: `S${i}`, query: { titles: ["CEO"] } }]],
        ["MONITORS", "monitors", 3, "monitors", (i) => ["/v1/signals/monitors", { type: "keyword", name: `M${i}`, target: `keyword ${i}` }]],
        ["SIGNALSUBSCRIPTIONS", "signal subscriptions", 3, "signal_subscriptions", (i) => ["/v1/signals/subscriptions", { name: `Sub${i}`, types: [sigType] }]],
        ["AUTOPILOTS", "autopilots", 3, "autopilots", (i) => ["/v1/tools/autopilots", { name: `A${i}`, query: { titles: ["CEO"] }, active: false }]],
      ];
      const report: string[] = [];
      for (const [envKind, noun, cap, table, mk, extra] of kinds) {
        process.env[`ROW_CAP_${envKind}`] = String(cap);
        await q`DELETE FROM jobs WHERE org_id = ${o.orgId}`; // so the job ceilings do not mix into the answers
        const already = await countOf(table, o.orgId, extra ?? "");
        const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => req("POST", mk(i)[0], o.token, mk(i)[1])));
        const n = await countOf(table, o.orgId, extra ?? "");
        report.push(`${noun}: cap ${cap}, rows ${n}, ${JSON.stringify(tally(rs))}`);
        // Never more than the cap. The count is conservative (a row that has landed is counted
        // with its reservation until its request has been answered), so a burst may stop one
        // or two short of it - but every "created" answer is a row, and every other answer is the limit.
        expect(n, report.join(" | ")).toBeLessThanOrEqual(Math.max(cap, already));
        const made = rs.filter((r) => r.status >= 200 && r.status < 300).length;
        expect(made, report.join(" | ")).toBe(n - already);
        if (already < cap) expect(made, report.join(" | ")).toBeGreaterThanOrEqual(1);
        const refused = rs.filter((r) => r.status === 403);
        expect(refused.length, report.join(" | ")).toBe(40 - made);
        for (const r of refused) expect(r.body.error.code).toBe("limit_reached");
        expect(refused[0].body.error.message).toMatch(new RegExp(`reached the limit of ${cap} `));
        // The cap itself is still reachable: one at a time, the remaining places fill and then it is full.
        expect(limits.reservedCount(`row:`)).toBe(0);
        for (let i = 0; i < cap + 1; i++) await req("POST", mk(100 + i)[0], o.token, mk(100 + i)[1]);
        expect(await countOf(table, o.orgId, extra ?? ""), report.join(" | ")).toBe(Math.max(cap, already));
      }
    }, 120_000);

    it("one at a time the cap is exact, and deleting one frees its place at once", async () => {
      process.env.ROW_CAP_LISTS = "3";
      const o = await signup("caps-seq");
      const made: any[] = [];
      for (let i = 0; i < 5; i++) made.push(await req("POST", "/v1/leads/lists", o.token, { name: `Seq${i}` }));
      expect(made.map((r) => r.status)).toEqual([201, 201, 201, 403, 403]);
      // Nothing is left reserved once the requests have been answered.
      expect(limits.reservedCount(`row:lists:${o.orgId}`)).toBe(0);
      expect((await req("DELETE", `/v1/leads/lists/${made[0].body.id}`, o.token)).status).toBe(200);
      expect((await req("POST", "/v1/leads/lists", o.token, { name: "after delete" })).status).toBe(201);
      expect((await req("POST", "/v1/leads/lists", o.token, { name: "one too many" })).status).toBe(403);
      expect(await countOf("lists", o.orgId)).toBe(3);
    });

    it("a check whose insert never happens holds its place for a few seconds only", async () => {
      process.env.ROW_CAP_LISTS = "1";
      const o = await signup("caps-expiry");
      vi.useFakeTimers({ toFake: ["Date"] });
      // Outside a request (a job, a script): nothing gives the reservation back early.
      await limits.assertRowCap(db, S.lists, o.orgId, "lists");
      expect(limits.reservedCount(`row:lists:${o.orgId}`)).toBe(1);
      // The caller's insert failed. Until the reservation runs out the place is taken...
      await expect(limits.assertRowCap(db, S.lists, o.orgId, "lists")).rejects.toMatchObject({ status: 403, code: "limit_reached" });
      // (a refused check leaves nothing behind)
      expect(limits.reservedCount(`row:lists:${o.orgId}`)).toBe(1);
      vi.setSystemTime(Date.now() + 6_000);
      // ...and then it is free again, by itself.
      expect(limits.reservedCount(`row:lists:${o.orgId}`)).toBe(0);
      await limits.assertRowCap(db, S.lists, o.orgId, "lists");
      // Outside a request a reservation stands for its row until it runs out - also once the
      // row has landed (nothing tells it so). Conservative: a second create straight after
      // the first is counted against both the row and the reservation.
      process.env.ROW_CAP_LISTS = "3";
      limits.resetReservations();
      await db.insert(S.lists).values({ orgId: o.orgId, name: "direct 0" });
      await limits.assertRowCap(db, S.lists, o.orgId, "lists"); // 1 row + this one = 2
      await db.insert(S.lists).values({ orgId: o.orgId, name: "direct 1" });
      // 2 rows, 1 still reserved, 1 more wanted: refused although only 2 of 3 exist...
      await expect(limits.assertRowCap(db, S.lists, o.orgId, "lists")).rejects.toMatchObject({ status: 403 });
      // ...and exact again as soon as the reservation has run out.
      vi.setSystemTime(Date.now() + 6_000);
      await limits.assertRowCap(db, S.lists, o.orgId, "lists");
      await db.insert(S.lists).values({ orgId: o.orgId, name: "direct 2" });
      vi.setSystemTime(Date.now() + 6_000);
      await expect(limits.assertRowCap(db, S.lists, o.orgId, "lists")).rejects.toMatchObject({ status: 403 });
      expect(await countOf("lists", o.orgId)).toBe(3);
    });

    /** A stand-in database whose row count is a number here, so the order of events is the test's to fix. */
    function standIn() {
      const state = { rows: 0, jobs: 0 };
      const rowsDb = { select: () => ({ from: () => ({ where: async () => [{ n: state.rows }] }) }) };
      const jobsDb = { execute: async () => [{ n: state.jobs }] };
      return { state, rowsDb: rowsDb as any, jobsDb: jobsDb as any };
    }
    const gate = () => {
      let open!: () => void;
      const p = new Promise<void>((r) => {
        open = r;
      });
      return { p, open };
    };
    const beat = () => new Promise((r) => setTimeout(r, 5));

    it("a create that arrives after an earlier one has committed and ended still sees the ones in flight (fixed order of events)", async () => {
      process.env.ROW_CAP_LISTS = "5";
      const { state, rowsDb } = standIn();
      const org = `org-${u8()}`;
      const results: string[] = [];
      const create = (name: string, commit: { p: Promise<void> }) =>
        limits.withReservationScope(async () => {
          try {
            await limits.assertRowCap(rowsDb, { orgId: "org_id" }, org, "lists");
          } catch (e: any) {
            results.push(`${name}: refused (${e.code})`);
            return;
          }
          await commit.p;
          state.rows++;
          results.push(`${name}: created`);
        });
      const g = Object.fromEntries(["A", "B", "C", "D", "E", "F", "G"].map((n) => [n, gate()]));
      // Five creates are in flight: each counted 0 rows and was let through.
      const five = ["A", "B", "C", "D", "E"].map((n) => create(n, g[n]));
      await beat();
      // The first commits and its request ends.
      g.A.open();
      await five[0];
      await beat();
      expect(state.rows).toBe(1);
      // A sixth arrives: the database holds 1 row and four more are on their way. It does not fit.
      const sixth = create("F", g.F);
      await beat();
      for (const n of ["B", "C", "D", "E", "F"]) g[n].open();
      await Promise.all([...five, sixth]);
      expect(results.filter((r) => r.endsWith("created")).sort()).toEqual(["A: created", "B: created", "C: created", "D: created", "E: created"]);
      expect(results).toContain("F: refused (limit_reached)");
      expect(state.rows).toBe(5);
      // Nothing stays reserved once every request has been answered, and the next one is refused on the rows alone.
      expect(limits.reservedCount(`row:lists:${org}`)).toBe(0);
      await create("G", g.G);
      expect(results).toContain("G: refused (limit_reached)");

      // The same order of events for the job ceilings: refused once the workspace is AT the ceiling.
      process.env.JOB_OPEN_TYPE_CAP = "5";
      process.env.JOB_OPEN_TOTAL_CAP = "50";
      const j = standIn();
      const jobOrg = randomUUID();
      const outcomes: string[] = [];
      const enqueue = (name: string, commit: { p: Promise<void> }) =>
        limits.withReservationScope(async () => {
          try {
            await limits.guardJobCapacity(j.jobsDb, jobOrg, "lead.enrich");
          } catch (e: any) {
            outcomes.push(`${name}: refused (${e.code})`);
            return;
          }
          await commit.p;
          j.state.jobs++;
          outcomes.push(`${name}: queued`);
        });
      const h = Object.fromEntries(["A", "B", "C", "D", "E", "F"].map((n) => [n, gate()]));
      const firstFive = ["A", "B", "C", "D", "E"].map((n) => enqueue(n, h[n]));
      await beat();
      h.A.open();
      await firstFive[0];
      await beat();
      const late = enqueue("F", h.F);
      await beat();
      for (const n of ["B", "C", "D", "E", "F"]) h[n].open();
      await Promise.all([...firstFive, late]);
      expect(outcomes).toContain("F: refused (queue_full)");
      expect(j.state.jobs).toBe(5);
      expect(limits.reservedCount(`job:${jobOrg}`)).toBe(0);
    });

    it("200 rounds of 50 parallel creates under CPU load never pass the cap - with counts and commits landing in any order", async () => {
      process.env.ROW_CAP_LISTS = "5";
      process.env.JOB_OPEN_TYPE_CAP = "5";
      process.env.JOB_OPEN_TOTAL_CAP = "7";
      // A busy loop on the same thread, so timers and promise callbacks fire late and out of their usual order.
      const spin = setInterval(() => {
        const until = performance.now() + 2;
        while (performance.now() < until);
      }, 1);
      const pause = (ms: number) => new Promise((r) => (ms <= 0 ? setImmediate(r) : setTimeout(r, ms)));
      const worst = { rows: 0, jobs: 0, total: 0 };
      let fewest = 99;
      try {
        for (let round = 0; round < 200; round++) {
          const state = { rows: 0, jobsA: 0, jobsB: 0 };
          // The count is read at some moment during the query, as a real one is.
          const slowCount = async (read: () => number) => {
            await pause(Math.random() * 3 - 1);
            const n = read();
            await pause(Math.random() * 3 - 1);
            return [{ n }];
          };
          const rowsDb: any = { select: () => ({ from: () => ({ where: () => slowCount(() => state.rows) }) }) };
          const org = randomUUID();
          // Which count a job query is: the first of a guard is the type's, the second the total.
          const jobsDbFor = (type: "A" | "B") => {
            let calls = 0;
            return { execute: () => slowCount(calls++ === 0 ? () => (type === "A" ? state.jobsA : state.jobsB) : () => state.jobsA + state.jobsB) } as any;
          };
          // Arrivals are spread out, so some creates arrive after earlier ones have committed and ended
          // while others are still between their check and their insert.
          const createRow = () =>
            limits.withReservationScope(async () => {
              await pause(Math.random() * 8 - 1);
              try {
                await limits.assertRowCap(rowsDb, { orgId: "org_id" }, org, "lists");
              } catch {
                return;
              }
              await pause(Math.random() * 6 - 1); // the insert
              state.rows++;
              await pause(Math.random() * 2 - 1); // the rest of the request (audit, the answer)
            });
          const queueJob = (type: "A" | "B") =>
            limits.withReservationScope(async () => {
              await pause(Math.random() * 8 - 1);
              try {
                await limits.guardJobCapacity(jobsDbFor(type), org, `type.${type}`);
              } catch {
                return;
              }
              await pause(Math.random() * 6 - 1);
              if (type === "A") state.jobsA++;
              else state.jobsB++;
              await pause(Math.random() * 2 - 1);
            });
          await Promise.all([...Array.from({ length: 50 }, createRow), ...Array.from({ length: 25 }, () => queueJob("A")), ...Array.from({ length: 25 }, () => queueJob("B"))]);
          worst.rows = Math.max(worst.rows, state.rows);
          worst.jobs = Math.max(worst.jobs, state.jobsA, state.jobsB);
          worst.total = Math.max(worst.total, state.jobsA + state.jobsB);
          fewest = Math.min(fewest, state.rows);
          if (state.rows > 5 || state.jobsA > 5 || state.jobsB > 5 || state.jobsA + state.jobsB > 7) break;
          // Every request has been answered: nothing is left reserved, and one at a time the cap is reached exactly.
          expect(limits.reservedCount(`row:lists:${org}`) + limits.reservedCount(`job:${org}`)).toBe(0);
          for (let i = 0; i < 6; i++) await createRow();
          expect(state.rows).toBe(5);
        }
      } finally {
        clearInterval(spin);
      }
      expect(worst).toEqual({ rows: expect.any(Number), jobs: expect.any(Number), total: expect.any(Number) });
      expect(worst.rows).toBeLessThanOrEqual(5);
      expect(worst.jobs).toBeLessThanOrEqual(5);
      expect(worst.total).toBeLessThanOrEqual(7);
      // Conservative, not useless: a burst always creates something.
      expect(fewest).toBeGreaterThanOrEqual(1);
    }, 180_000);

    it("the same through the real routes and database: rounds of 50 parallel creates under CPU load stay within the cap", async () => {
      process.env.ROW_CAP_LISTS = "5";
      const spin = setInterval(() => {
        const until = performance.now() + 2;
        while (performance.now() < until);
      }, 1);
      try {
        for (let round = 0; round < 8; round++) {
          const o = await signup(`caps-load-${round}`);
          const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => req("POST", "/v1/leads/lists", o.token, { name: `R${round}-${i}` })));
          const n = await countOf("lists", o.orgId);
          expect(n, `round ${round}: ${JSON.stringify(tally(rs))}`).toBeLessThanOrEqual(5);
          expect(rs.filter((r) => r.status === 201).length).toBe(n);
          expect(n).toBeGreaterThanOrEqual(1);
        }
      } finally {
        clearInterval(spin);
      }
    }, 180_000);

    it("a request that adds several rows reserves all of them, and is told how many still fit", async () => {
      process.env.ROW_CAP_VISIBILITYPROMPTS = "10";
      const o = await signup("caps-bulk");
      const batch = (tag: string, n: number) => ({ prompts: Array.from({ length: n }, (_, i) => ({ text: `best tool for ${tag} number ${i}?` })) });
      const bulkPath = "/v1/visibility/prompts/bulk";
      const rs = await Promise.all(["a", "b", "c", "d"].map((t) => req("POST", bulkPath, o.token, batch(t, 6))));
      const n = await countOf("visibility_prompts", o.orgId);
      expect(n, JSON.stringify(tally(rs))).toBe(6);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of rs.filter((x) => x.status !== 201)) expect(r.body.error.code).toBe("limit_reached");
      // On its own, a batch that does not fit is told how many would.
      const refused = await req("POST", bulkPath, o.token, batch("z", 6));
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("limit_reached");
      expect(refused.body.error.message).toBe("This workspace can hold 10 tracked prompts and has room for 4 more. Add fewer at once, delete some you no longer need, or contact support if you need more.");
      // Four still fit; a fifth does not.
      expect((await req("POST", bulkPath, o.token, batch("e", 4))).status).toBe(201);
      const full = await req("POST", "/v1/visibility/prompts", o.token, { text: "one more prompt, please?" });
      expect(full.status).toBe(403);
      expect(full.body.error.message).toContain("reached the limit of 10 tracked prompts");
      expect(await countOf("visibility_prompts", o.orgId)).toBe(10);
    });

    it("40 parallel enqueues never pass the per-type or the total ceiling, and a refusal says when to retry", async () => {
      process.env.JOB_OPEN_TYPE_CAP = "5";
      process.env.JOB_OPEN_TOTAL_CAP = "8";
      const o = await signup("jobcaps");
      const [lead] = await db.insert(S.leads).values({ orgId: o.orgId, email: `jobcap-${u8()}@prospect.example`, fullName: "Job Cap" }).returning();
      const hook = (await req("POST", "/v1/webhooks", o.token, { url: `https://hooks.round6-test.example/jobs/${u8()}` })).body;
      await q`DELETE FROM jobs WHERE org_id = ${o.orgId}`;
      const e1 = await Promise.all(Array.from({ length: 40 }, () => req("POST", `/v1/leads/${lead.id}/enrich`, o.token, {})));
      // Never past the ceiling; a burst may stop short of it (the count is conservative), and every 202 is a job.
      const queued1 = e1.filter((r) => r.status === 202).length;
      expect(await openJobs(o.orgId, "lead.enrich"), JSON.stringify(tally(e1))).toBe(queued1);
      expect(queued1).toBeGreaterThanOrEqual(1);
      expect(queued1).toBeLessThanOrEqual(5);
      expect(Object.keys(tally(e1)).sort()).toEqual(["202", "429:queue_full"]);
      // One at a time the rest of the places fill, to the ceiling exactly.
      for (let i = 0; i < 6; i++) await req("POST", `/v1/leads/${lead.id}/enrich`, o.token, {});
      expect(await openJobs(o.orgId, "lead.enrich")).toBe(5);
      const e2 = await Promise.all(Array.from({ length: 40 }, () => req("POST", `/v1/webhooks/${hook.id}/test`, o.token, {})));
      const queued2 = e2.filter((r) => r.status === 202 || r.status === 200).length;
      expect(await openJobs(o.orgId, "webhook.deliver"), JSON.stringify(tally(e2))).toBe(queued2);
      expect(queued2).toBeGreaterThanOrEqual(1);
      expect(queued2).toBeLessThanOrEqual(3);
      expect(await openJobs(o.orgId)).toBeLessThanOrEqual(8);
      for (let i = 0; i < 4; i++) await req("POST", `/v1/webhooks/${hook.id}/test`, o.token, {});
      expect(await openJobs(o.orgId, "webhook.deliver")).toBe(3);
      expect(await openJobs(o.orgId)).toBe(8);
      const full = e2.find((r) => r.status === 429)!;
      expect(full.body.error).toMatchObject({ code: "queue_full", message: "Too much work is already queued for this workspace. Let it finish, then try again.", details: { retryAfterSeconds: 30 } });
      expect(full.headers.get("retry-after")).toBe("30");
      // A test event is only written for a delivery that was queued.
      expect((await q`SELECT count(*)::int AS n FROM events WHERE org_id = ${o.orgId} AND type = 'webhook.test'`)[0].n).toBe(3);

      // One at a time: exactly the cap, then refused; and room again once a job has finished.
      const o2 = await signup("jobcaps-seq");
      const [lead2] = await db.insert(S.leads).values({ orgId: o2.orgId, email: `seqcap-${u8()}@prospect.example`, fullName: "Seq Cap" }).returning();
      const seq: number[] = [];
      for (let i = 0; i < 7; i++) seq.push((await req("POST", `/v1/leads/${lead2.id}/enrich`, o2.token, {})).status);
      expect(seq).toEqual([202, 202, 202, 202, 202, 429, 429]);
      await q`UPDATE jobs SET status = 'done' WHERE id = (SELECT id FROM jobs WHERE org_id = ${o2.orgId} LIMIT 1)`;
      expect((await req("POST", `/v1/leads/${lead2.id}/enrich`, o2.token, {})).status).toBe(202);
    }, 60_000);

    // ── 8. A create answered "queue full" saves nothing ──
    it("a monitor, a subscription or an ICP refused because the queue is full is not saved (a retry cannot duplicate it)", async () => {
      process.env.JOB_OPEN_TOTAL_CAP = "8";
      const o = await signup("queue-full");
      const types = (await req("GET", "/v1/signals/types", o.token)).body.types;
      const sigType = typeof types[0] === "string" ? types[0] : (types[0].id ?? types[0].type);
      for (let i = 0; i < 8; i++) await db.insert(S.jobs).values({ orgId: o.orgId, type: "lead.enrich", payload: {}, runAt: new Date(Date.now() + 365 * 86_400_000) });
      const monitor = await req("POST", "/v1/signals/monitors", o.token, { type: "keyword", name: "when full", target: "kw" });
      const sub = await req("POST", "/v1/signals/subscriptions", o.token, { name: "when full", types: [sigType] });
      const icp = await req("POST", "/v1/icps", o.token, { name: "when full", description: "B2B fintech founders in India", buildWithAi: true });
      for (const r of [monitor, sub, icp]) {
        expect(r.status).toBe(429);
        expect(r.body.error.code).toBe("queue_full");
        expect(r.headers.get("retry-after")).toBe("30");
      }
      expect(await countOf("monitors", o.orgId)).toBe(0);
      expect(await countOf("signal_subscriptions", o.orgId)).toBe(0);
      expect(await countOf("icps", o.orgId)).toBe(0);
      // An ICP that queues nothing is not held back by the queue.
      expect((await req("POST", "/v1/icps", o.token, { name: "no build", buildWithAi: false })).status).toBe(201);
      // With room again, each of them is created once.
      await q`DELETE FROM jobs WHERE org_id = ${o.orgId}`;
      expect((await req("POST", "/v1/signals/monitors", o.token, { type: "keyword", name: "now", target: "kw" })).status).toBe(201);
      expect((await req("POST", "/v1/signals/subscriptions", o.token, { name: "now", types: [sigType] })).status).toBe(201);
      expect(await countOf("monitors", o.orgId)).toBe(1);
      expect(await countOf("signal_subscriptions", o.orgId)).toBe(1);
    });

    // ── 12. Invitations ──
    it("20 invitations sent at once leave exactly as many pending as there are free seats, and existing invites are never removed", async () => {
      const o = await signup("invite-race", { seats: 4 });
      // One invite already pending: 1 member + 1 pending of 4 seats, so 2 are free.
      const first = await req("POST", "/v1/tools/team/invite", o.token, { email: `early-${u8()}@example.com`, role: "member" });
      expect(first.status).toBe(201);
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => req("POST", "/v1/tools/team/invite", o.token, { email: `pi${i}-${u8()}@example.com`, role: "member" })));
      const pending = await q`SELECT id FROM invites WHERE org_id = ${o.orgId} AND accepted_at IS NULL AND revoked_at IS NULL`;
      expect(pending.length, JSON.stringify(tally(rs))).toBe(3);
      expect(pending.map((p: any) => p.id)).toContain(first.body.id);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
      const refused = rs.filter((r) => r.status !== 201);
      expect(refused).toHaveLength(18);
      for (const r of refused) expect(r.body.error.message).toMatch(/^Seat limit reached \(4: 1 member and 3 pending invites\)/);
      // The same address invited twice at the same moment gets one invite, not two.
      const o2 = await signup("invite-dupe", { seats: 10 });
      const same = `twice-${u8()}@example.com`;
      const twice = await Promise.all([0, 1, 2].map(() => req("POST", "/v1/tools/team/invite", o2.token, { email: same, role: "member" })));
      expect(twice.filter((r) => r.status === 201)).toHaveLength(1);
      expect(twice.filter((r) => r.status === 409 && r.body.error.code === "already_invited")).toHaveLength(2);
    }, 60_000);
  });

  // ── 3 / 14. What log lines may carry ───────────────────────────────────────────────
  describe("log lines", () => {
    it("an address used as the NAME of a query parameter is not written to the request log", async () => {
      const { redactRequestLine, createApp } = await import("./app.js");
      expect(redactRequestLine("/v1/leads", "jane.zzodd%40person-r6.example=1")).toBe("/v1/leads?[redacted]=[redacted]");
      expect(redactRequestLine("/v1/leads", "jane.zzodd@person-r6.example")).toBe("/v1/leads?[redacted]");
      expect(redactRequestLine("/v1/leads", "limit=5&jane.zzodd@person-r6.example=x&tag=vip")).toBe("/v1/leads?limit=5&[redacted]=[redacted]&tag=vip");
      // Ordinary parameters are untouched.
      expect(redactRequestLine("/v1/leads", "limit=5&sort=score")).toBe("/v1/leads?limit=5&sort=score");
      const lines: string[] = [];
      const logged = createApp({ accessLog: (l) => lines.push(l) });
      await logged.request("/v1/leads?jane.zzodd%40person-r6.example=1&jane.zzodd@person-r6.example");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.join("\n")).not.toMatch(/zzodd|person-r6/);
    });

    it("an unexpected error is described without its statement, its values or an address", async () => {
      const { errorLine } = await import("./lib/errors.js");
      const dbErr = Object.assign(new Error('Failed query: insert into "leads" ("email") values ($1) params: priya.private@prospect.example'), {
        cause: Object.assign(new Error('duplicate key value violates unique constraint "leads_org_email_idx"'), { code: "23505", constraint_name: "leads_org_email_idx" }),
      });
      const line = errorLine(dbErr);
      expect(line).toContain("[23505]");
      expect(line).toContain("duplicate key value");
      expect(line).not.toMatch(/priya|prospect\.example|insert into/);
      expect(errorLine(new Error("550 5.1.1 <priya.private@prospect.example>: Recipient address rejected"))).not.toContain("priya");
    });

    it("a failed job is logged and stored without the statement it failed on; the log line carries no address", async () => {
      const dbErr = Object.assign(new Error('Failed query: update "leads" set "email" = $1 where "id" = $2 params: priya.private@prospect.example,0b1c'), {
        cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      });
      expect(S.jobErrorText(dbErr)).toBe("database query failed [57014]: canceling statement due to statement timeout [query omitted]");
      expect(S.jobErrorForLog(new Error("550 mailbox priya.private@prospect.example unavailable"))).toBe("550 mailbox [email] unavailable");
      // An ordinary failure message is stored as it always was.
      expect(S.jobErrorText(new Error("webhook https://hooks.example.com → 500 Internal Server Error"))).toBe("webhook https://hooks.example.com → 500 Internal Server Error");

      const o = await signup("job-log");
      const lines: string[] = [];
      const [row] = await db.insert(S.jobs).values({ orgId: o.orgId, type: "r6.fails", payload: {}, status: "running", attempts: 1, maxAttempts: 1, lockedBy: "t", lockedAt: new Date() }).returning();
      await S.runJob(db, row, { "r6.fails": async () => { throw dbErr; } }, (m: string) => lines.push(m));
      const [stored] = await q`SELECT status, error FROM jobs WHERE id = ${row.id}`;
      expect(stored.status).toBe("failed");
      expect(stored.error).toContain("statement timeout");
      expect(`${stored.error}\n${lines.join("\n")}`).not.toMatch(/priya|prospect\.example|update "leads"/);
      expect(lines.join("\n")).toContain("failed: database query failed [57014]");
    });

    // ── 4. Webhook paths ──
    it("a webhook's path is a secret: failures name the origin only, in the log, the job error and the event", async () => {
      const o = await signup("hook-secret");
      const SECRET_PATH = "/services/T0R6SECRET/B0R6SECRET/zzR6pathTokenValue";
      const [hook] = await db.insert(S.webhooks).values({ orgId: o.orgId, url: `https://hooks.round6-chat.example${SECRET_PATH}?also=zzR6queryToken`, events: ["*"], secret: "legacy-secret", failures: 9 }).returning();
      const [ev] = await db.insert(S.events).values({ orgId: o.orgId, type: "lead.created", data: { leadId: "abc" } }).returning();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const lines: string[] = [];
      const leak = /T0R6SECRET|B0R6SECRET|zzR6pathTokenValue|zzR6queryToken/;

      // (a) the endpoint answers 500 on the last attempt: the hook is disabled, the job fails.
      net.answer = () => new Response("nope", { status: 500, statusText: "Internal Server Error" });
      const [job1] = await db.insert(S.jobs).values({ orgId: o.orgId, type: "webhook.deliver", payload: { webhookId: hook.id, eventId: ev.id }, status: "running", attempts: 1, maxAttempts: 1, lockedBy: "t", lockedAt: new Date() }).returning();
      await S.runJob(db, job1, jobHandlers, (m: string) => lines.push(m));
      const [stored] = await q`SELECT status, error FROM jobs WHERE id = ${job1.id}`;
      expect(stored.status).toBe("failed");
      expect(stored.error).toBe("webhook https://hooks.round6-chat.example → 500 Internal Server Error");
      expect((await db.query.webhooks.findFirst({ where: S.eq(S.webhooks.id, hook.id) })).active).toBe(false);
      const disabled = await q`SELECT data FROM events WHERE org_id = ${o.orgId} AND type = 'webhook.disabled'`;
      expect(disabled).toHaveLength(1);
      expect(disabled[0].data.url).toBe("https://hooks.round6-chat.example");

      // (b) a network error that quotes the address it could not reach.
      await db.update(S.webhooks).set({ active: true, failures: 0 }).where(S.eq(S.webhooks.id, hook.id));
      net.answer = (url) => {
        throw new Error(`request to ${url} failed, reason: socket hang up`);
      };
      const job2 = { ...job1, id: randomUUID(), attempts: 1, maxAttempts: 5 };
      await expect(jobHandlers["webhook.deliver"](job2, { db, progress: async () => {}, log: (m: string) => lines.push(m) })).rejects.toThrow(/^webhook https:\/\/hooks\.round6-chat\.example → 0 /);
      const thrown = await jobHandlers["webhook.deliver"](job2, { db, progress: async () => {}, log: () => {} }).catch((e: Error) => e.message);
      expect(thrown).not.toMatch(leak);

      // (c) an address that is not public: skipped, and the reason names the origin only.
      const [priv] = await db.insert(S.webhooks).values({ orgId: o.orgId, url: `http://127.0.0.1:9${SECRET_PATH}`, events: ["*"], secret: "legacy-secret" }).returning();
      const skipped = await jobHandlers["webhook.deliver"]({ ...job1, id: randomUUID(), payload: { webhookId: priv.id, eventId: ev.id } }, { db, progress: async () => {}, log: (m: string) => lines.push(m) });
      expect(skipped).toEqual({ skipped: "http://127.0.0.1:9 is not a public address" });

      const everything = `${lines.join("\n")}\n${warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n")}\n${JSON.stringify(await q`SELECT error, result FROM jobs WHERE org_id = ${o.orgId}`)}\n${JSON.stringify(await q`SELECT data FROM events WHERE org_id = ${o.orgId}`)}`;
      expect(everything).not.toMatch(leak);
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes(`[webhooks] disabled ${hook.id} (https://hooks.round6-chat.example) `))).toBe(true);
    });
  });

  // ── 5. A database outage ───────────────────────────────────────────────────────────
  describe("a database that cannot be reached", () => {
    const UNAVAILABLE = { code: "service_unavailable", message: "The server is temporarily unavailable. Try again in a minute." };

    it("a valid session is answered 503 'try again', never 401 (which signs the person out)", async () => {
      const o = await signup("outage");
      expect((await req("GET", "/v1/auth/me", o.token)).status).toBe(200);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(db.query.users, "findFirst").mockRejectedValue(outage());
      const during = await req("GET", "/v1/auth/me", o.token);
      expect(during.status).toBe(503);
      expect(during.body.error).toMatchObject(UNAVAILABLE);
      expect(during.headers.get("retry-after")).toBe("10");
      expect(during.text).not.toMatch(/sara\.outage|Failed query|ECONNREFUSED|127\.0\.0\.1/);
      // The same for any other route behind a session.
      expect((await req("GET", "/v1/leads", o.token)).status).toBe(503);
      // What is logged says what happened without the statement or the address in it.
      const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("[api] database unavailable");
      expect(logged).not.toMatch(/sara\.outage|Failed query/);
      vi.restoreAllMocks();
      // The session was never the problem: it works again the moment the database does.
      expect((await req("GET", "/v1/auth/me", o.token)).status).toBe(200);
    });

    it("the same for an API key (it answered 500)", async () => {
      const o = await signup("outage-key");
      expect((await req("GET", "/v1/leads", o.apiKey)).status).toBe(200);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(db.query.apiKeys, "findFirst").mockRejectedValue(outage());
      const during = await req("GET", "/v1/leads", o.apiKey);
      expect(during.status).toBe(503);
      expect(during.body.error).toMatchObject(UNAVAILABLE);
      vi.restoreAllMocks();
      expect((await req("GET", "/v1/leads", o.apiKey)).status).toBe(200);
    });

    it("the same for the sign-in form, sign-up and password reset (they answered 500)", async () => {
      const o = await signup("outage-form");
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(db, "select").mockImplementation(() => {
        throw outage();
      });
      vi.spyOn(db.query.users, "findFirst").mockRejectedValue(outage());
      vi.spyOn(db, "execute").mockRejectedValue(outage());
      vi.spyOn(db, "insert").mockImplementation(() => {
        throw outage();
      });
      const login = await req("POST", "/v1/auth/login", null, { email: o.email, password: PASSWORD });
      expect(login.status).toBe(503);
      expect(login.body.error).toMatchObject(UNAVAILABLE);
      expect(login.text).not.toMatch(/Internal error|Failed query|ECONNREFUSED/);
      const signupDuring = await req("POST", "/v1/auth/signup", null, { email: `late-${u8()}@example.com`, password: PASSWORD, orgName: "Late" });
      expect(signupDuring.status).toBe(503);
      vi.restoreAllMocks();
      expect((await req("POST", "/v1/auth/login", null, { email: o.email, password: PASSWORD })).status).toBe(200);
    });

    it("only a credential that does not check out is a 401", async () => {
      const o = await signup("outage-401");
      const { sign } = await import("hono/jwt");
      const now = Math.floor(Date.now() / 1000);
      const forged = await sign({ sub: o.userId, org: o.orgId, tv: 0, aud: "session", iat: now, exp: now + 600 }, "z".repeat(48));
      // A token whose subject is not an id the database can even look up: still "not recognised".
      const oddSubject = await sign({ sub: "not-a-uuid", org: o.orgId, tv: 0, aud: "session", iat: now, exp: now + 600 }, process.env.JWT_SECRET!);
      const stale = await sign({ sub: o.userId, org: o.orgId, tv: 99, aud: "session", iat: now, exp: now + 600 }, process.env.JWT_SECRET!);
      for (const t of ["garbage.token.value", forged, oddSubject, stale]) {
        const r = await req("GET", "/v1/auth/me", t);
        expect(r.status, t.slice(0, 20)).toBe(401);
        expect(r.body.error.code).toBe("unauthorized");
      }
      expect((await req("GET", "/v1/leads", "px_live_thisKeyDoesNotExist000000000000")).status).toBe(401);
      expect((await req("GET", "/v1/auth/me")).status).toBe(401);
    });

    it("recognises an outage in every shape the driver reports it, and nothing else", async () => {
      const { isDatabaseUnavailable } = await import("./lib/errors.js");
      const dbUrl = new URL(process.env.DATABASE_URL!);
      const dbPort = Number(dbUrl.port) || 5432;
      const wrap = (cause: unknown) => Object.assign(new Error("Failed query: select 1 params: "), { cause });
      // Wrapped by the ORM: any socket failure, any driver code, any "cannot connect" SQLSTATE.
      for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT", "57P01", "57P03", "53300", "08006", "08001"]) {
        expect(isDatabaseUnavailable(wrap(Object.assign(new Error("x"), { code }))), code).toBe(true);
      }
      // Node's "every address refused", wrapped.
      expect(isDatabaseUnavailable(wrap(Object.assign(new Error("agg"), { errors: [Object.assign(new Error("a"), { code: "ECONNREFUSED" })] })))).toBe(true);
      // Opening a transaction is not wrapped: a bare failure naming the database's port or host.
      expect(isDatabaseUnavailable(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect", address: "10.9.8.7", port: dbPort }))).toBe(true);
      expect(isDatabaseUnavailable(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname: dbUrl.hostname }))).toBe(true);
      expect(isDatabaseUnavailable(Object.assign(new Error("agg"), { code: "ECONNREFUSED", errors: [Object.assign(new Error("a"), { code: "ECONNREFUSED", address: "::1", port: dbPort })] }))).toBe(true);
      // The driver's own codes and Postgres' own states need no wrapper.
      expect(isDatabaseUnavailable(Object.assign(new Error("write CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" }))).toBe(true);
      expect(isDatabaseUnavailable(Object.assign(new Error("the database system is starting up"), { code: "57P03" }))).toBe(true);

      // NOT an outage: the same socket errors from anything else this server connects to.
      const refusedElsewhere = Object.assign(new Error("connect ECONNREFUSED 203.0.113.5:25"), { code: "ECONNREFUSED", syscall: "connect", address: "203.0.113.5", port: 25 });
      expect(isDatabaseUnavailable(refusedElsewhere)).toBe(false);
      expect(isDatabaseUnavailable(Object.assign(new Error("getaddrinfo ENOTFOUND hooks.customer.example"), { code: "ENOTFOUND", hostname: "hooks.customer.example" }))).toBe(false);
      expect(isDatabaseUnavailable(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", port: dbPort }) }))).toBe(false);
      expect(isDatabaseUnavailable(Object.assign(new Error("queryMx ETIMEOUT"), { code: "ETIMEOUT" }))).toBe(false);
      // ...and database errors that are about the request, not the connection.
      for (const code of ["23505", "22P02", "57014", "42P01", "40001", undefined]) {
        expect(isDatabaseUnavailable(wrap(Object.assign(new Error("x"), code ? { code } : {}))), String(code)).toBe(false);
      }
      for (const nothing of [null, undefined, "ECONNREFUSED", 42]) expect(isDatabaseUnavailable(nothing)).toBe(false);
    });

    it("a failed outbound connection in a route is not reported as a database outage", async () => {
      const { errorHandler } = await import("./lib/errors.js");
      const { Hono } = await import("hono");
      const probe = new Hono();
      probe.onError(errorHandler);
      probe.get("/fetch", () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.5:443"), { code: "ECONNREFUSED", address: "203.0.113.5", port: 443 }) });
      });
      probe.get("/db", () => {
        throw outage();
      });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const outbound = await probe.request("/fetch");
      expect(outbound.status).toBe(500);
      expect((await outbound.json()).error.code).toBe("internal_error");
      const database = await probe.request("/db");
      expect(database.status).toBe(503);
      expect(database.headers.get("retry-after")).toBe("10");
      expect((await database.json()).error).toMatchObject(UNAVAILABLE);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/sara\.outage|Failed query/);
    });
  });

  // ── 7. The standalone "find email" tool ────────────────────────────────────────────
  describe("POST /v1/search/find-email and the platform do-not-contact list", () => {
    const used = async (orgId: string) => Number((await q`SELECT coalesce(sum(count), 0)::int AS n FROM usage WHERE org_id = ${orgId} AND metric = 'verifications'`)[0].n);

    it("an address on the list is not handed out and the look-up is not charged; a plus-tagged form counts as the same person", async () => {
      const o = await signup("find-email");
      const listed = `asked.out.${u8()}@do-not-find.example`;
      await db.insert(S.globalSuppressions).values({ email: listed, reason: "erasure_request" });
      const before = await used(o.orgId);
      for (const found of [listed, listed.replace("@", "+work@"), listed.toUpperCase()]) {
        mocks.findEmail = async () => ({ email: found, status: "valid", confidence: 0.9, candidates: [{ email: found, status: "valid", confidence: 0.9 }], source: "pattern" });
        const r = await req("POST", "/v1/search/find-email", o.token, { firstName: "Asked", lastName: "Out", domain: "do-not-find.example" });
        expect(r.status, found).toBe(409);
        expect(r.body.error).toMatchObject({ code: "suppressed", message: "This person has asked not to be contacted through Scout, so their address is not shown." });
        expect(r.text.toLowerCase()).not.toContain("asked.out");
      }
      expect(await used(o.orgId)).toBe(before);
    });

    it("an ordinary address is returned and charged as before; a listed runner-up is left out of the candidates", async () => {
      const o = await signup("find-email-ok");
      const listed = `runner.up.${u8()}@find-me.example`;
      await db.insert(S.globalSuppressions).values({ email: listed, reason: "unsubscribed" });
      const before = await used(o.orgId);
      mocks.findEmail = async () => ({ email: "priya.raman@find-me.example", status: "valid", confidence: 0.9, candidates: [{ email: "priya.raman@find-me.example", status: "valid", confidence: 0.9 }, { email: listed, status: "unknown", confidence: 0.3 }], source: "pattern" });
      const r = await req("POST", "/v1/search/find-email", o.token, { firstName: "Priya", lastName: "Raman", domain: "find-me.example" });
      expect(r.status).toBe(200);
      expect(r.body.email).toBe("priya.raman@find-me.example");
      expect(r.body.candidates).toEqual([{ email: "priya.raman@find-me.example", status: "valid", confidence: 0.9 }]);
      expect(await used(o.orgId)).toBe(before + 1);
      // Nothing found: the answer is passed on untouched.
      mocks.findEmail = async () => ({ email: null, status: "unknown", confidence: 0, candidates: [] });
      const none = await req("POST", "/v1/search/find-email", o.token, { firstName: "No", lastName: "Body", domain: "find-me.example" });
      expect(none.status).toBe(200);
      expect(none.body).toMatchObject({ email: null, candidates: [] });
    });
  });

  // ── 9. LIST_QUERY_TIMEOUT_MS ───────────────────────────────────────────────────────
  it("LIST_QUERY_TIMEOUT_MS is brought into 250 ms - 60 s and says so, instead of being ignored", async () => {
    const { listQueryTimeout, LIST_QUERY_TIMEOUT_MS } = await import("./lib/listSearch.js");
    expect(LIST_QUERY_TIMEOUT_MS).toBe(8000);
    expect(listQueryTimeout(undefined)).toEqual({ ms: 8000, note: null });
    expect(listQueryTimeout("")).toEqual({ ms: 8000, note: null });
    expect(listQueryTimeout("1000")).toEqual({ ms: 1000, note: null });
    expect(listQueryTimeout("250")).toEqual({ ms: 250, note: null });
    expect(listQueryTimeout("60000")).toEqual({ ms: 60_000, note: null });
    expect(listQueryTimeout("1500.9")).toEqual({ ms: 1500, note: null });
    const low = listQueryTimeout("1");
    expect(low.ms).toBe(250);
    expect(low.note).toBe("[config] LIST_QUERY_TIMEOUT_MS=1 is outside 250-60000 ms; using 250 ms.");
    const high = listQueryTimeout("600000");
    expect(high.ms).toBe(60_000);
    expect(high.note).toContain("using 60000 ms");
    for (const bad of ["abc", "-5", "0", "NaN"]) {
      const r = listQueryTimeout(bad);
      expect(r.ms, bad).toBe(8000);
      expect(r.note, bad).toContain("is not a positive number of milliseconds");
    }
  });

  // ── 10. Fingerprints in security-log responses ─────────────────────────────────────
  describe("security-log responses never carry an address fingerprint", () => {
    const fp = (address: string) => `sha256:${createHash("sha256").update(address.toLowerCase(), "utf8").digest("hex")}`;

    it("the customer's log, the admin's log and the export leave it out; the once-a-day notice still works off the stored row", async () => {
      const o = await signup("audit-fp");
      const { notifySecurity } = await import("./lib/securityMail.js");
      mocks.platformMailer = true;
      // The real path that writes the fingerprint-keyed row: a new-sign-in notice.
      const user = await db.query.users.findFirst({ where: S.eq(S.users.id, o.userId) });
      expect(await notifySecurity(user, "new_signin", { ip: "203.0.113.50" })).toBe(true);
      const [stored] = await q`SELECT target_id FROM audit_log WHERE org_id = ${o.orgId} AND action = 'security.new_signin_notice'`;
      expect(stored.target_id).toBe(fp(o.email));
      // A second one within the day is not sent: the stored row is still what decides that.
      rateWindow.resetWindows();
      expect(await notifySecurity(user, "new_signin", { ip: "203.0.113.51" })).toBe(false);
      expect(mocks.sent.filter((m) => m.to === o.email)).toHaveLength(1);
      // A row carrying a fingerprint inside its data, as the admin's rows do.
      await db.insert(S.auditLog).values({ orgId: o.orgId, actorType: "admin", action: "admin.suppression_added", targetType: "global_suppression", targetId: randomUUID(), data: { address: fp("someone@else.example"), reason: "manual", nested: { also: fp("x@y.example"), kept: "yes" }, list: [fp("z@y.example"), "plain"] } });

      const mine = await req("GET", "/v1/audit-log?limit=200", o.token);
      expect(mine.status).toBe(200);
      expect(mine.text).not.toContain("sha256:");
      const notice = mine.body.entries.find((e: any) => e.action === "security.new_signin_notice");
      expect(notice).toMatchObject({ targetType: "user", targetId: null, data: {} });
      const added = mine.body.entries.find((e: any) => e.action === "admin.suppression_added");
      expect(added.data).toEqual({ addressHidden: true, reason: "manual", nested: { alsoHidden: true, kept: "yes" }, list: ["plain"] });
      // Ordinary rows keep their target and data exactly.
      const signedUp = mine.body.entries.find((e: any) => e.action === "auth.signup");
      expect(signedUp.targetId).toBeTruthy();

      // The admin's own actions, through the admin routes.
      const person = `erase.me.${u8()}@fp-test.example`;
      expect((await admin("GET", `/data-subject?email=${encodeURIComponent(person)}`)).status).toBe(200);
      const add = await admin("POST", "/suppressions", { email: person, reason: "manual" });
      expect(add.status).toBeLessThan(300);
      const theirs = await admin("GET", "/audit-log?limit=100&action=admin.*");
      expect(theirs.status).toBe(200);
      expect(theirs.text).not.toContain("sha256:");
      const viewed = theirs.body.entries.find((e: any) => e.action === "admin.data_subject_viewed");
      expect(viewed).toMatchObject({ targetType: "data_subject", targetId: null });
      const listed = theirs.body.entries.find((e: any) => e.action === "admin.suppression_added" && e.targetId === add.body.suppression.id);
      expect(listed.data).toMatchObject({ addressHidden: true, reason: "manual" });
      expect(listed.data.address).toBeUndefined();
      const all = await admin("GET", `/audit-log?limit=100&orgId=${o.orgId}`);
      expect(all.text).not.toContain("sha256:");
      // Stored rows are untouched (the fingerprint is the server's bookkeeping).
      expect((await q`SELECT count(*)::int AS n FROM audit_log WHERE target_id LIKE 'sha256:%' OR data::text LIKE '%sha256:%'`)[0].n).toBeGreaterThanOrEqual(3);

      // The workspace export.
      const { exportWorkspaceFragments } = await import("./services/accountExport.js");
      const org = await db.query.organizations.findFirst({ where: S.eq(S.organizations.id, o.orgId) });
      let doc = "";
      for await (const part of exportWorkspaceFragments(org)) doc += part;
      const parsed = JSON.parse(doc);
      expect(parsed.summary.complete).toBe(true);
      expect(parsed.auditLog.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(parsed.auditLog)).not.toContain("sha256:");
      expect(parsed.auditLog.find((e: any) => e.action === "security.new_signin_notice")).toMatchObject({ targetId: null });
      expect(parsed.auditLog.find((e: any) => e.action === "admin.suppression_added").data).toMatchObject({ addressHidden: true, reason: "manual" });
    });
  });

  // ── 11. The mailing address ────────────────────────────────────────────────────────
  describe("the mailing address", () => {
    const INVISIBLE = /[\u0080-\u009F­؜​-‏‪-‮⁠-⁯﻿]/;

    it("is saved without direction-changing, zero-width or other invisible characters, through both routes", async () => {
      const o = await signup("address");
      const tricky = "Scout Labs​ Pvt Ltd\nSuite 1‮gpj.exe‬ ⁦hidden⁩­﻿⁠\n‏Mumbai‎ 400001";
      const saved = await req("PATCH", "/v1/account/privacy", o.token, { mailingAddress: tricky });
      expect(saved.status).toBe(200);
      expect(saved.body.mailingAddress).toBe("Scout Labs Pvt Ltd\nSuite 1gpj.exe hidden\nMumbai 400001");
      expect(saved.body.mailingAddress).not.toMatch(INVISIBLE);
      const [{ settings }] = await q`SELECT settings FROM organizations WHERE id = ${o.orgId}`;
      expect(settings.mailingAddress).toBe("Scout Labs Pvt Ltd\nSuite 1gpj.exe hidden\nMumbai 400001");
      // The general settings route is held to the same rule.
      const general = await req("PATCH", "/v1/auth/org", o.token, { settings: { mailingAddress: "12 High‮ Street​, London" } });
      expect(general.status).toBe(200);
      const [{ settings: s2 }] = await q`SELECT settings FROM organizations WHERE id = ${o.orgId}`;
      expect(s2.mailingAddress).toBe("12 High Street, London");
    });

    it("is cleaned again where it is printed, so a value stored before this rule cannot carry them into an email", async () => {
      const { mailingAddressOf, unsubscribeFooter, withoutInvisibleCharacters } = await import("./services/campaigns.js");
      const old = { settings: { mailingAddress: "Acme‮ dtL‬\n1 Main​ St\u0085 Springfield" } };
      const shown = mailingAddressOf(old);
      expect(shown).toBe("Acme dtL\n1 Main St Springfield");
      const footer = unsubscribeFooter("https://api.scout.test/t/u/token", shown);
      expect(`${footer.text}${footer.html}`).not.toMatch(INVISIBLE);
      expect(footer.text).toContain("Acme dtL");
      // Scripts that spell words with a joiner keep it between their own letters...
      const persian = "می‌خواهم"; // "mi-khaham", written with a zero-width non-joiner
      expect(withoutInvisibleCharacters(persian)).toBe(persian);
      const hindi = "क्‍ष"; // a conjunct held open by a zero-width joiner
      expect(withoutInvisibleCharacters(hindi)).toBe(hindi);
      // ...but not between Latin letters, at the edges, or next to a space.
      expect(withoutInvisibleCharacters("pay‌pal ‍x‍")).toBe("paypal x");
      // Ordinary text, accents, other scripts and emoji are untouched.
      for (const plain of ["221B Baker Street, London NW1 6XE", "Zürich, Straße 5, 2. OG", "東京都千代田区1-1", "Ул. Ленина, 5", "Café №7 ☕"]) expect(mailingAddressOf({ settings: { mailingAddress: plain } })).toBe(plain);
      expect(mailingAddressOf({ settings: {} })).toBe("");
    });
  });

  // ── 14. Smaller notes ──────────────────────────────────────────────────────────────
  describe("smaller notes from the same pass", () => {
    it("the confirmation-email allowance is counted from the security log, so a second instance or a restart does not reset it", async () => {
      mocks.platformMailer = true;
      const o = await signup("resend");
      mocks.sent.length = 0;
      for (let i = 0; i < 3; i++) {
        const r = await req("POST", "/v1/auth/verify/resend", o.token, {});
        expect(r.status).toBe(200);
        expect(r.body.emailed).toBe(true);
      }
      // "Another instance", or this one after a restart: its in-memory count starts at zero.
      rateWindow.resetWindows();
      const fourth = await req("POST", "/v1/auth/verify/resend", o.token, {});
      expect(fourth.status).toBe(429);
      expect(fourth.body.error).toMatchObject({ code: "rate_limited", message: "We have already sent 3 confirmation emails in the last hour. Check your inbox and spam folder, or try again later." });
      expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(3000);
      expect(mocks.sent.filter((m) => m.to === o.email)).toHaveLength(3);
      // An hour on, the allowance is back.
      await q`UPDATE audit_log SET created_at = created_at - interval '61 minutes' WHERE org_id = ${o.orgId} AND action = 'auth.verification_sent'`;
      rateWindow.resetWindows();
      expect((await req("POST", "/v1/auth/verify/resend", o.token, {})).status).toBe(200);
    });

    it("the invitation allowances are shared the same way (3 an hour to one address, across workspaces)", async () => {
      const target = `invited-${u8()}@example.com`;
      const sentTo = async () => {
        const o = await signup("inv-allow", { seats: 10 });
        return req("POST", "/v1/tools/team/invite", o.token, { email: target, role: "member" });
      };
      for (let i = 0; i < 3; i++) {
        expect((await sentTo()).status).toBe(201);
        rateWindow.resetWindows(); // each from "another instance"
      }
      const fourth = await sentTo();
      expect(fourth.status).toBe(429);
      expect(fourth.body.error).toMatchObject({ code: "rate_limited", message: "That address has already been sent 3 invitations in the last hour. Share the invite link with them directly, or try again later." });
      // The refused invite was not saved.
      expect((await q`SELECT count(*)::int AS n FROM invites WHERE email = ${target}`)[0].n).toBe(3);
    });

    it("the admin can look up and erase an address with unusual but valid characters, and only that address", async () => {
      const o = await signup("percent");
      const odd = `o%reilly.${u8()}@percent-r6.example`;
      const lookalike = odd.replace("%", "x");
      const wildcard = odd.replace("o%reilly", "%");
      await db.insert(S.messages).values([
        { orgId: o.orgId, toEmail: odd, subject: "to the odd one", bodyText: "hello odd", status: "sent" },
        { orgId: o.orgId, toEmail: lookalike, subject: "to the look-alike", bodyText: "hello other", status: "sent" },
      ]);
      await db.insert(S.leads).values({ orgId: o.orgId, email: lookalike, fullName: "Look Alike" });
      const report = await admin("GET", `/data-subject?email=${encodeURIComponent(odd)}`);
      expect(report.status).toBe(200);
      expect(report.body.held).toBe(true);
      // A confirmation that is a pattern, or the look-alike, is not a confirmation.
      for (const confirm of [wildcard, lookalike, "%"]) expect((await admin("POST", "/data-subject/erase", { email: odd, confirm })).status).toBe(400);
      const erased = await admin("POST", "/data-subject/erase", { email: odd, confirm: odd.toUpperCase() });
      expect(erased.status).toBe(200);
      expect(erased.body).toMatchObject({ ok: true, messagesAnonymised: 1, globallySuppressed: true });
      const left = await q`SELECT to_email, subject FROM messages WHERE org_id = ${o.orgId} ORDER BY created_at`;
      expect(left.filter((m: any) => m.to_email === odd)).toHaveLength(0);
      expect(left.find((m: any) => m.to_email === lookalike)).toMatchObject({ subject: "to the look-alike" });
      expect((await q`SELECT count(*)::int AS n FROM leads WHERE org_id = ${o.orgId} AND email = ${lookalike}`)[0].n).toBe(1);
      expect((await q`SELECT count(*)::int AS n FROM global_suppressions WHERE email = ${odd}`)[0].n).toBe(1);
      // Things that are not one address are still refused.
      for (const bad of ["not-an-address", "two@x.example, three@x.example", "a b@x.example", "@x.example", "a@b", ".a@x.example", "a..b@x.example"]) {
        expect((await admin("GET", `/data-subject?email=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
      }
    });
  });
});
