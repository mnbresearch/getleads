/**
 * G3 robustness regression tests (security round 4).
 *
 * Every case reproduces a round-3 defect through the real app (createApp) and a real
 * database, then asserts the fix. The mailer and AI are never called (no providers
 * configured), and each case uses its own workspace so caps never couple.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = `admin-${"g".repeat(40)}`;

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "inline";
  process.env.APP_URL = "https://app.scout.test";
  process.env.API_URL = "https://api.scout.test";
  delete process.env.PILOT_INVITE_CODE;
  delete process.env.DEFAULT_PLAN;
  delete process.env.TRUSTED_PROXY;
  // Small ceilings so the cap/queue mechanisms can be exercised without thousands of rows.
  process.env.ROW_CAP_LISTS = "3";
  process.env.ROW_CAP_WEBHOOKS = "3";
  process.env.ROW_CAP_APIKEYS = "3";
  process.env.JOB_OPEN_TYPE_CAP = "3";
}

if (!TEST_DB) {
  process.stderr.write(`\n[!] "security: robustness" did NOT run: TEST_DATABASE_URL is not set.\n`);
}

const suite = TEST_DB ? describe : describe.skip;

suite("security: robustness, caps, races (G3)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let A: typeof import("./lib/auth.js");

  let ipSeq = 0;
  const ip = () => `198.19.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

  async function req(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, headers: res.headers as Headers };
  }

  async function signup(tag = "g3"): Promise<{ token: string; orgId: string; userId: string; email: string; password: string }> {
    const email = `${tag}-${randomUUID().slice(0, 8)}@example.com`;
    const password = "Zq9!vK2#mLp7$wXe";
    const r = await req("POST", "/v1/auth/signup", undefined, { email, password, orgName: `${tag} ${randomUUID().slice(0, 6)}` });
    expect(r.status, r.text).toBe(201);
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id, email, password };
  }

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    A = await import("./lib/auth.js");
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    await S.closeDb?.().catch(() => {});
  });

  // D3 - a validation error on a field literally named "constructor" used to 500.
  it("a validation error on a field named `constructor` is a clean 400, not a 500", async () => {
    const o = await signup();
    const r = await req("PUT", "/v1/integrations/webhook", o.token, { config: { constructor: 1 } });
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe("validation_error");
    expect(typeof r.body?.error?.message).toBe("string");
  });

  // D3 at the unit level, and the control that a normal acronym still renders.
  it("humanizePath handles inherited property names without throwing", async () => {
    const v = await import("./lib/validate.js");
    expect(v.humanizePath(["config", "constructor"])).toBe("Constructor");
    expect(v.humanizePath(["config", "toString"])).toBe("To string");
    expect(v.humanizePath(["config", "url"])).toBe("URL");
  });

  // D2 - a lone surrogate in a term reached encodeURIComponent and threw a 500.
  it("a signal scan with an unpaired surrogate in a keyword does not 500", async () => {
    const o = await signup();
    const r = await req("POST", "/v1/signals/scan", o.token, { types: ["funding"], keywords: ["\ud800"], days: 1 });
    // No provider configured, so it comes back with an empty/parsed result - the point is it
    // is not a 500.
    expect(r.status).toBeLessThan(500);
  });

  it("wellFormed / encodeURIComponentSafe never throw on malformed text", async () => {
    const t = await import("@prospex/core");
    expect(t.wellFormed("\ud800").charCodeAt(0)).toBe(0xfffd);
    expect(() => t.encodeURIComponentSafe("a\ud800b")).not.toThrow();
  });

  // D1 - list search text is bounded, and a leading-wildcard pattern is escaped to a literal.
  it("list search text is length-bounded (over-long q is refused, not run)", async () => {
    const o = await signup();
    const r = await req("GET", `/v1/leads?q=${"a".repeat(5000)}`, o.token);
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe("validation_error");
  });

  it("a wildcard in q is a literal, not a scan-widening pattern", async () => {
    const o = await signup();
    // Create two leads; only one matches the literal "%".
    await req("POST", "/v1/leads", o.token, { email: `a-${randomUUID().slice(0, 6)}@ex.com`, fullName: "Plain Name" });
    await req("POST", "/v1/leads", o.token, { email: `b-${randomUUID().slice(0, 6)}@ex.com`, fullName: "Has % Percent" });
    const all = await req("GET", "/v1/leads", o.token);
    expect(all.body.total).toBe(2);
    const pct = await req("GET", "/v1/leads?q=%25", o.token); // %25 -> "%"
    expect(pct.status).toBe(200);
    expect(pct.body.total).toBe(1); // only the literal-"%" lead, not both
  });

  it("a real statement timeout is recognised, and boundedRead maps it to a 503 with a plain message", async () => {
    const L = await import("./lib/listSearch.js");
    // A statement that runs past a 1 ms cap is cancelled by Postgres and recognised.
    await expect(
      S.withStatementTimeout(db, 1, async (tx: any) => tx.execute(S.sql`SELECT pg_sleep(0.3)`)),
    ).rejects.toSatisfy((e: unknown) => S.isStatementTimeout(e));
    // boundedRead turns a cancelled statement into a 503 ApiError, never a 500 or empty 200.
    let thrown: any;
    try {
      await L.boundedRead(db, async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.status).toBe(503);
    expect(thrown?.code).toBe("search_timeout");
    expect(thrown?.message).toMatch(/taking too long/i);
    // A non-timeout error is passed through unchanged (not disguised as a 503).
    await expect(L.boundedRead(db, async () => { throw new Error("other"); })).rejects.toThrow("other");
  });

  // D6 - row-count caps (lists cap set to 3 for this run).
  it("creating past the lists cap is refused with 403 limit_reached, existing rows kept", async () => {
    const o = await signup();
    for (let i = 0; i < 3; i++) {
      const r = await req("POST", "/v1/leads/lists", o.token, { name: `L${i}` });
      expect(r.status, r.text).toBe(201);
    }
    const over = await req("POST", "/v1/leads/lists", o.token, { name: "L-over" });
    expect(over.status).toBe(403);
    expect(over.body?.error?.code).toBe("limit_reached");
    // The three that existed are still there.
    const list = await req("GET", "/v1/leads/lists/all", o.token);
    expect(list.body.lists.length).toBe(3);
  });

  it("the webhooks cap and the active-api-key cap both refuse with 403 limit_reached", async () => {
    const o = await signup();
    for (let i = 0; i < 3; i++) expect((await req("POST", "/v1/webhooks", o.token, { url: `https://hooks.example.com/${i}` })).status).toBe(201);
    expect((await req("POST", "/v1/webhooks", o.token, { url: "https://hooks.example.com/x" })).body?.error?.code).toBe("limit_reached");

    // API keys: signup already made one "Default" key, so two more reach the cap of 3.
    expect((await req("POST", "/v1/auth/api-keys", o.token, { name: "k1" })).status).toBe(201);
    expect((await req("POST", "/v1/auth/api-keys", o.token, { name: "k2" })).status).toBe(201);
    const over = await req("POST", "/v1/auth/api-keys", o.token, { name: "k3" });
    expect(over.status).toBe(403);
    expect(over.body?.error?.code).toBe("limit_reached");
  });

  // D5 - per-workspace open-job ceiling (type cap set to 3). Enrich enqueues one job each.
  it("enqueuing past the per-type open-job ceiling is refused with 429, not piled up", async () => {
    const o = await signup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await req("POST", "/v1/leads", o.token, { email: `j${i}-${randomUUID().slice(0, 6)}@ex.com`, firstName: "J" });
      ids.push(r.body.lead.id);
    }
    // Inline job mode would drain immediately, so count open jobs before they run by leaving
    // them queued: bump run_at into the future via a direct enqueue is not needed - inline
    // only drains on the /search path. Enrich just enqueues. Fire several:
    const codes: number[] = [];
    for (const id of ids) codes.push((await req("POST", `/v1/leads/${id}/enrich`, o.token)).status);
    // At least one must be refused with 429 once three are open.
    expect(codes.filter((s) => s === 202).length).toBeLessThanOrEqual(3);
    expect(codes).toContain(429);
    const open = await S.openJobCount(db, o.orgId, "lead.enrich");
    expect(open).toBeLessThanOrEqual(3);
  });

  it("assertJobCapacity exempts platform/recurring work and null-org jobs", async () => {
    // A null org is never capped.
    await expect(S.assertJobCapacity(db, null, "campaign.tick", false)).resolves.toBeUndefined();
    const o = await signup();
    await expect(S.assertJobCapacity(db, o.orgId, "whatever", true)).resolves.toBeUndefined();
  });

  // D7 - unbounded text fields now have maxima.
  it("an over-long task body is refused at validation", async () => {
    const o = await signup();
    const r = await req("POST", "/v1/tools/tasks", o.token, { title: "t", body: "x".repeat(50_000) });
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe("validation_error");
  });

  // D8 - seat limit under parallel joins. Growth plan has 5 seats; we invite many and accept
  // all at once, and the member count must never exceed the seat limit.
  it("parallel invite-accepts cannot exceed the seat limit", async () => {
    const o = await signup("seats");
    // Put the workspace on a 2-seat plan via the admin API (owner already uses 1 seat).
    const plan = await req("PATCH", `/v1/admin/orgs/${o.orgId}/plan`, undefined, { plan: "starter" }, { "x-admin-token": ADMIN_TOKEN });
    expect(plan.status, plan.text).toBe(200); // starter = 2 seats
    // Create 4 invites directly, each with its own token. The join route accepts a legacy
    // plaintext-token invite (tokenHash null), which is all this needs.
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      const token = `tok-${randomUUID()}`;
      await db.insert(S.invites).values({ orgId: o.orgId, email: `seatjoin-${i}-${randomUUID().slice(0, 6)}@ex.com`, role: "member", token, invitedBy: o.userId, expiresAt: new Date(Date.now() + 3600_000) });
      tokens.push(token);
    }
    const results = await Promise.all(
      tokens.map((t) => req("POST", "/v1/auth/join", undefined, { token: t, password: "Zq9!vK2#mLp7$wXe", name: "Seat" })),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const [{ m }] = await db.select({ m: S.sql`count(*)::int` }).from(S.users).where(S.eq(S.users.orgId, o.orgId));
    expect(Number(m)).toBeLessThanOrEqual(2); // owner + at most one joiner
    expect(ok).toBeLessThanOrEqual(1);
  });

  // D10 - two concurrent creates of ONE new email charge once, not twice.
  it("concurrent creates of one new lead are billed once", async () => {
    const o = await signup();
    const email = `dup-${randomUUID().slice(0, 8)}@ex.com`;
    const before = (await req("GET", "/v1/usage", o.token)).body.usage.leads.used;
    const results = await Promise.all(Array.from({ length: 8 }, () => req("POST", "/v1/leads", o.token, { email, firstName: "Dup" })));
    const created = results.filter((r) => r.status === 201).length;
    const [{ n }] = await db.select({ n: S.sql`count(*)::int` }).from(S.leads).where(S.and(S.eq(S.leads.orgId, o.orgId), S.eq(S.leads.email, email)));
    const after = (await req("GET", "/v1/usage", o.token)).body.usage.leads.used;
    expect(Number(n)).toBe(1); // one row
    expect(created).toBe(1);
    expect(after - before).toBe(1); // charged exactly once
  });

  // D11 - concurrent signups with one address leave no orphan workspace.
  it("concurrent signups with one email create one user and no owner-less workspace", async () => {
    const email = `race-${randomUUID().slice(0, 8)}@example.com`;
    // A marker unique to this run's workspaces, so the orphan check sees only these orgs and
    // not the hundreds other suites create.
    const marker = `RaceMark${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => req("POST", "/v1/auth/signup", undefined, { email, password: "Zq9!vK2#mLp7$wXe", orgName: `${marker} ${i}` })));
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    const [{ u }] = await db.select({ u: S.sql`count(*)::int` }).from(S.users).where(S.eq(S.users.email, email));
    expect(Number(u)).toBe(1);
    // Exactly one workspace with this run's marker exists (the five losers rolled back whole),
    // and it is not owner-less.
    const rows = await db.execute(S.sql`SELECT (SELECT count(*)::int FROM users u WHERE u.org_id = o.id) AS members FROM organizations o WHERE o.name LIKE ${marker + " %"}`);
    const list = ((rows as any).rows ?? rows) as { members: number }[];
    expect(list.length).toBe(1);
    expect(Number(list[0].members)).toBe(1);
  });

  // D4 - password hashing is gated: a burst does not pile up unbounded, and hashes still verify.
  it("existing bcrypt hashes still verify after the gate", async () => {
    const hash = await A.hashPassword("Zq9!vK2#mLp7$wXe");
    expect(await A.checkPassword("Zq9!vK2#mLp7$wXe", hash)).toBe(true);
    expect(await A.checkPassword("wrong", hash)).toBe(false);
  });

  it("many concurrent hashes all resolve under the concurrency gate", async () => {
    const hashes = await Promise.all(Array.from({ length: 12 }, (_, i) => A.hashPassword(`pw-${i}-x`)));
    expect(hashes.every((h) => typeof h === "string" && h.startsWith("$2"))).toBe(true);
  });

  // D9 - the provider-event endpoint's "not configured" answer names no server setting.
  it("the delivery-event endpoint's not-configured reply names no env var", async () => {
    const saved = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    const r = await req("POST", "/v1/email-events/resend", undefined, { type: "email.bounced" });
    expect(r.status).toBe(503);
    expect(r.text).not.toMatch(/RESEND|SECRET|env/i);
    if (saved !== undefined) process.env.RESEND_WEBHOOK_SECRET = saved;
  });
});
