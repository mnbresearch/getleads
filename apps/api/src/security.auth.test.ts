/**
 * Security regressions: authentication, sessions, the admin credential, stored-credential
 * crypto and request limits.
 *
 * Each test replays an exploit a validator demonstrated against the running app (see the
 * security review, findings 1-13 for this area) and asserts that it no longer works. They go
 * through the real app (createApp) and a real database, except the crypto block, which is
 * pure.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

const INTERNAL = `internal-${"i".repeat(40)}`;
const ADMIN_TOKEN = `admin-${"a".repeat(40)}`;
const ADMIN_EMAIL = "root@scout.test";
const ADMIN_PASSWORD = "admin-password-for-tests-0123456789";
const GOOGLE_CLIENT = "test-client.apps.googleusercontent.com";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "inline";
  process.env.APP_URL = "https://app.scout.test";
  process.env.API_URL = "https://api.scout.test";
  process.env.INTERNAL_TOKEN = INTERNAL;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.GOOGLE_OAUTH_CLIENT_ID = GOOGLE_CLIENT;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-google-secret";
  delete process.env.PILOT_INVITE_CODE;
  delete process.env.ADMIN_JWT_SECRET;
  delete process.env.ENCRYPTION_KEYS_OLD;
  delete process.env.TRUSTED_PROXY;
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
}

/** Every email the app tries to send in this file, captured instead of sent. */
const mocks = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string; text: string }) => {
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}` };
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] ${JSON.stringify("security: auth")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the regression tests for the security review (sessions, lockout, Google sign-in, admin token, body limits).\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("security: auth, sessions, admin credential, crypto, limits", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db
  let G: typeof import("./lib/googleAuth.js");
  let A: typeof import("./lib/auth.js");
  let jwt: typeof import("hono/jwt");
  let createApp: typeof import("./app.js").createApp;

  type Acct = { token: string; orgId: string; userId: string; email: string; password: string; apiKey: string };

  /** A distinct client IP per call, so the per-IP limits never couple tests. */
  let ipSeq = 0;
  const ip = () => `198.18.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

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

  const PASSWORD = "correct-horse-battery";
  async function signup(name: string, password = PASSWORD, email = `${name}-${randomUUID().slice(0, 8)}@example.com`): Promise<Acct> {
    const r = await req("POST", "/v1/auth/signup", undefined, { email, password, orgName: `${name} Co` });
    expect(r.status, r.text).toBe(201);
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id, email, password, apiKey: r.body.apiKey };
  }
  const me = (token: string) => req("GET", "/v1/auth/me", token);
  const auditRows = (where: { action: string; orgId?: string }) =>
    db
      .select()
      .from(S.auditLog)
      .where(where.orgId ? S.and(S.eq(S.auditLog.action, where.action), S.eq(S.auditLog.orgId, where.orgId)) : S.eq(S.auditLog.action, where.action))
      .orderBy(S.desc(S.auditLog.createdAt));

  // ── Google test double: the token endpoint answers with whatever identity the test sets ──
  let googleClaims: Record<string, unknown> | null = null;
  const realFetch = globalThis.fetch;
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const identity = (email: string, sub = `g-${randomUUID()}`, extra: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT,
    exp: Math.floor(Date.now() / 1000) + 600,
    sub,
    email,
    email_verified: true,
    name: "G User",
    ...extra,
  });
  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, cv: createHash("sha256").update(verifier).digest("base64url") };
  };
  /** name=value of the g_state cookie from a Set-Cookie header. */
  const stateCookie = (h: Headers) => (h.get("set-cookie") ?? "").split(";")[0];
  const fragment = (location: string | null) => new URLSearchParams((location ?? "").split("#")[1] ?? "");

  /** /start in "this browser": returns the state Google would echo and the cookie the browser holds. */
  async function googleStart(cv: string, next = "/leads") {
    const r = await req("GET", `/v1/auth/google/start?next=${encodeURIComponent(next)}&cv=${cv}`);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    return { state: loc.searchParams.get("state")!, cookie: stateCookie(r.headers), setCookie: r.headers.get("set-cookie") ?? "", googleUrl: loc };
  }
  const googleCallback = (state: string, cookie?: string) => req("GET", `/v1/auth/google/callback?code=4/abc&state=${encodeURIComponent(state)}`, null, undefined, cookie ? { cookie } : {});
  /** The whole flow in one browser, up to the redirect that carries the one-time code. */
  async function googleSignIn(claims: Record<string, unknown>) {
    const p = pkce();
    const s = await googleStart(p.cv);
    googleClaims = claims;
    const cb = await googleCallback(s.state, s.cookie);
    const f = fragment(cb.headers.get("location"));
    return { cb, code: f.get("code"), next: f.get("next"), verifier: p.verifier, location: cb.headers.get("location") ?? "" };
  }

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    G = await import("./lib/googleAuth.js");
    A = await import("./lib/auth.js");
    jwt = await import("hono/jwt");
    ({ createApp } = await import("./app.js"));
    app = createApp();
    // The admin login has ONE subject for everyone; a previous run's failures must not lock this one.
    await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, "admin"));
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        if (!googleClaims) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return new Response(JSON.stringify({ id_token: `${b64u({ alg: "RS256" })}.${b64u(googleClaims)}.sig` }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (db) await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, "admin"));
  });

  // ── 1. INTERNAL_TOKEN is the job runner's credential and nothing else ──
  describe("INTERNAL_TOKEN vs the admin API", () => {
    it("INTERNAL_TOKEN no longer opens /v1/admin, under either header name", async () => {
      expect((await req("GET", "/v1/admin/orgs", null, undefined, { "x-internal-token": INTERNAL })).status).toBe(401);
      expect((await req("GET", "/v1/admin/orgs", null, undefined, { "x-admin-token": INTERNAL })).status).toBe(401);
      expect((await req("GET", "/v1/admin/orgs?token=" + INTERNAL)).status).toBe(401);
    });

    it("ADMIN_API_TOKEN does, and with it unset the header path is off entirely", async () => {
      expect((await req("GET", "/v1/admin/session", null, undefined, { "x-admin-token": ADMIN_TOKEN })).status).toBe(200);
      const { env } = await import("./env.js");
      const saved = env.adminApiToken;
      env.adminApiToken = "";
      try {
        expect((await req("GET", "/v1/admin/session", null, undefined, { "x-admin-token": ADMIN_TOKEN })).status).toBe(401);
        expect((await req("GET", "/v1/admin/session", null, undefined, { "x-internal-token": INTERNAL })).status).toBe(401);
        expect((await req("GET", "/v1/admin/session", null, undefined, { "x-admin-token": "" })).status).toBe(401);
        // The dashboard's password login is a different path and still works.
        const login = await req("POST", "/v1/admin/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
        expect(login.status).toBe(200);
        expect((await req("GET", "/v1/admin/session", login.body.token)).status).toBe(200);
      } finally {
        env.adminApiToken = saved;
      }
    });

    it("the job runner takes its token from the header only: ?token= is refused", async () => {
      const inUrl = await req("GET", `/internal/jobs/run?token=${INTERNAL}&maxMs=1000`);
      expect(inUrl.status).toBe(403);
      expect((await req("POST", `/internal/jobs/run?token=${INTERNAL}&maxMs=1000`)).status).toBe(403);
      expect((await req("GET", "/internal/jobs/run?maxMs=1000", null, undefined, { "x-internal-token": "wrong" })).status).toBe(403);
      // ADMIN_API_TOKEN is not the job runner's token either.
      expect((await req("GET", "/internal/jobs/run?maxMs=1000", null, undefined, { "x-internal-token": ADMIN_TOKEN })).status).toBe(403);
      const ok = await req("GET", "/internal/jobs/run?maxMs=1000", null, undefined, { "x-internal-token": INTERNAL });
      expect(ok.status).toBe(200);
    }, 30_000);

    it("the request log never contains a token, a share link, a tracking link or an OAuth code", async () => {
      const lines: string[] = [];
      const logged = createApp({ accessLog: (l) => lines.push(l) });
      const call = (path: string, init: RequestInit = {}) => logged.request(path, { ...init, headers: { "cf-connecting-ip": ip(), ...(init.headers as Record<string, string> | undefined) } });
      const secrets = {
        internal: INTERNAL,
        share: `SHARE-${randomUUID()}`,
        track: `TRACK-${randomUUID()}`,
        pixel: `px_${randomUUID().slice(0, 16)}`,
        code: "4/SECRET-GOOGLE-CODE",
        state: `STATE-${randomUUID()}`,
        cv: pkce().cv,
        bearer: `BEARER-${randomUUID()}`,
        apiKey: `px_live_${randomUUID()}`,
        reset: `RESET-${randomUUID()}`,
        target: "https://prospect.example/pricing?utm=SECRETCAMPAIGN",
      };
      await call(`/internal/jobs/run?token=${secrets.internal}&maxMs=1000`);
      await call(`/internal/jobs/run?maxMs=1000&TOKEN=${secrets.internal}`);
      await call(`/internal/jobs/run?%74oken=${secrets.internal}`);
      await call(`/v1/public/clients/report/${secrets.share}`);
      await call(`/t/o/${secrets.track}.gif`);
      await call(`/t/c/${secrets.track}?u=${encodeURIComponent(secrets.target)}`);
      await call(`/t/u/${secrets.track}`);
      await call(`/%74/u/${secrets.track}`);
      await call(`/px/${secrets.pixel}.js`);
      await call(`/px/${secrets.pixel}/collect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await call(`/v1/auth/google/callback?code=${encodeURIComponent(secrets.code)}&state=${secrets.state}`);
      await call(`/v1/auth/google/start?cv=${secrets.cv}&next=/leads`);
      await call(`/v1/leads?api_key=${secrets.apiKey}&key=${secrets.apiKey}&limit=5`, { headers: { authorization: `Bearer ${secrets.bearer}`, "x-api-key": secrets.apiKey, "x-internal-token": secrets.internal, cookie: `g_state=${secrets.state}` } });
      await call(`/v1/auth/password/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: secrets.reset, password: "whatever-password-1" }) });

      expect(lines.length).toBeGreaterThanOrEqual(28);
      const all = lines.join("\n");
      for (const [name, value] of Object.entries(secrets)) {
        expect(all.includes(value), `${name} leaked into the request log`).toBe(false);
        expect(all.includes(encodeURIComponent(value)), `${name} (encoded) leaked into the request log`).toBe(false);
      }
      // Still a useful log: the route and the harmless parameters are there.
      expect(all).toContain("GET /internal/jobs/run?token=[redacted]&maxMs=1000");
      expect(all).toContain("/v1/public/clients/report/[redacted]");
      expect(all).toContain("/t/o/[redacted]");
      expect(all).toContain("/px/[redacted].js");
      expect(all).toContain("limit=5");
    }, 30_000);

    it("redactRequestLine handles the awkward cases", async () => {
      const { redactRequestLine } = await import("./app.js");
      expect(redactRequestLine("/v1/leads", "limit=5&q=acme")).toBe("/v1/leads?limit=5&q=acme");
      expect(redactRequestLine("/internal/jobs/run", "token=abc")).toBe("/internal/jobs/run?token=[redacted]");
      expect(redactRequestLine("/x", "Token=abc&STATE=def&cv=ghi&u=jkl&code=m&key=n&api_key=o")).not.toMatch(/abc|def|ghi|jkl|=m|=n|=o/);
      expect(redactRequestLine("/x", "%zz=abc")).not.toContain("abc");
      expect(redactRequestLine("/t/c/tok123", "u=https%3A%2F%2Fa.example")).toBe("/t/c/[redacted]?u=[redacted]");
      expect(redactRequestLine("/px/px_abc/collect")).toBe("/px/[redacted]/collect");
      // A newline in a path must not be able to start a forged log line.
      expect(redactRequestLine("/v1/leads\n--> GET /v1/admin 200")).not.toContain("\n");
    });
  });

  // ── 2. Account pre-hijack through Google link-by-email ──
  describe("Google sign-in cannot be pre-hijacked", () => {
    it("claims an account someone registered with the victim's address: old password, session and API key all die", async () => {
      // The attacker registers the victim's address (signup never proved they own it)...
      const victimEmail = `victim-${randomUUID().slice(0, 8)}@example.com`;
      const attacker = await signup("squatter", "attacker-knows-this-1", victimEmail);
      expect((await me(attacker.token)).status).toBe(200);
      expect((await req("GET", "/v1/auth/me", null, undefined, { "x-api-key": attacker.apiKey })).status).toBe(200);

      // ...and waits. The victim signs in with Google.
      mocks.sent.length = 0;
      const sub = `g-${randomUUID()}`;
      const flow = await googleSignIn(identity(victimEmail, sub));
      expect(flow.code, flow.location).toBeTruthy();
      const ex = await req("POST", "/v1/auth/google/exchange", null, { code: flow.code, verifier: flow.verifier });
      expect(ex.status, ex.text).toBe(200);
      expect(ex.body.user.email).toBe(victimEmail);
      expect(ex.body.user.hasPassword).toBe(false);
      expect(ex.body.user.emailVerified).toBe(true);
      expect((await me(ex.body.token)).status).toBe(200);

      // Everything the attacker held is dead.
      const again = await req("POST", "/v1/auth/login", null, { email: victimEmail, password: "attacker-knows-this-1" });
      expect(again.status).toBe(401);
      expect((await me(attacker.token)).status).toBe(401);
      expect((await req("GET", "/v1/auth/me", null, undefined, { "x-api-key": attacker.apiKey })).status).toBe(401);

      const [row] = await db.select().from(S.users).where(S.eq(S.users.email, victimEmail));
      expect(row.googleSub).toBe(sub);
      expect(row.emailVerifiedAt).toBeTruthy();
      expect(row.tokenVersion).toBe(1);
      expect(row.passwordHash.startsWith("!nopassword:")).toBe(true);

      const [claimed] = await auditRows({ action: "auth.google_claimed_unverified_account", orgId: attacker.orgId });
      expect(claimed).toBeTruthy();
      expect(claimed.data).toMatchObject({ email: victimEmail, soleUser: true, apiKeysRevoked: 1 });
      // And the address is told what happened.
      await vi.waitFor(() => expect(mocks.sent.some((m) => m.to === victimEmail && /linked to Google/.test(m.subject))).toBe(true));
    });

    it("the claim logic itself (unit): sole user loses keys; in a team the keys stay but the password and sessions go", async () => {
      // Sole user.
      const solo = await signup("solo");
      const r1 = await G.resolveGoogleUser({ sub: `g-${randomUUID()}`, email: solo.email, emailVerified: true, name: "" });
      expect(r1.match).toBe("claimed_unverified");
      expect(r1.claim).toMatchObject({ soleUser: true, apiKeysRevoked: 1, otherUsers: 0 });

      // A workspace with a second user: the keys belong to the team and are left alone.
      const team = await signup("team");
      await db.insert(S.users).values({ orgId: team.orgId, email: `mate-${randomUUID().slice(0, 8)}@example.com`, passwordHash: await A.hashPassword("mate-password-123"), role: "member" });
      const r2 = await G.resolveGoogleUser({ sub: `g-${randomUUID()}`, email: team.email, emailVerified: true, name: "" });
      expect(r2.match).toBe("claimed_unverified");
      expect(r2.claim).toMatchObject({ soleUser: false, apiKeysRevoked: 0, otherUsers: 1 });
      expect((await req("GET", "/v1/auth/me", null, undefined, { "x-api-key": team.apiKey })).status).toBe(200);
      expect((await me(team.token)).status).toBe(401);
      expect((await req("POST", "/v1/auth/login", null, { email: team.email, password: team.password })).status).toBe(401);
    });

    it("an address already proved by a password reset is linked, not claimed: password and keys keep working", async () => {
      const u = await signup("proved");
      mocks.sent.length = 0;
      await req("POST", "/v1/auth/password/forgot", null, { email: u.email });
      const link = mocks.sent.find((m) => m.to === u.email)!.text.match(/token=([\w-]+)/)![1];
      const reset = await req("POST", "/v1/auth/password/reset", null, { token: link, password: "a-brand-new-password-9" });
      expect(reset.status).toBe(200);
      expect(reset.body.user.emailVerified).toBe(true);

      const sub = `g-${randomUUID()}`;
      const r = await G.resolveGoogleUser({ sub, email: u.email, emailVerified: true, name: "" });
      expect(r.match).toBe("linked");
      expect((await req("POST", "/v1/auth/login", null, { email: u.email, password: "a-brand-new-password-9" })).status).toBe(200);
      expect((await req("GET", "/v1/auth/me", null, undefined, { "x-api-key": u.apiKey })).status).toBe(200);
      expect((await me(reset.body.token)).status).toBe(200);
      // From now on the subject is the identity.
      expect((await G.resolveGoogleUser({ sub, email: u.email, emailVerified: true, name: "" })).match).toBe("matched_sub");
    });

    it("refuses a different Google account for an address that is already bound, and an unverified Google email", async () => {
      const email = `bound-${randomUUID().slice(0, 8)}@example.com`;
      const first = await googleSignIn(identity(email, "g-first-" + randomUUID()));
      expect(first.code).toBeTruthy();
      const other = await googleSignIn(identity(email, "g-other-" + randomUUID()));
      expect(other.code).toBeNull();
      expect(other.location).toContain("/login?error=");
      await expect(G.resolveGoogleUser({ sub: "g-x", email, emailVerified: false, name: "" })).rejects.toMatchObject({ code: "oauth_email_unverified" });
      await expect(G.resolveGoogleUser({ sub: "", email, emailVerified: true, name: "" })).rejects.toMatchObject({ code: "oauth_bad_token" });
    });

    it("a Google-created account stays a Google account: second sign-in matches the subject and changes nothing", async () => {
      const email = `fresh-${randomUUID().slice(0, 8)}@example.com`;
      const sub = `g-${randomUUID()}`;
      const one = await googleSignIn(identity(email, sub));
      const s1 = await req("POST", "/v1/auth/google/exchange", null, { code: one.code, verifier: one.verifier });
      expect(s1.status).toBe(200);
      const [row] = await db.select().from(S.users).where(S.eq(S.users.email, email));
      expect(row.googleSub).toBe(sub);
      expect(row.emailVerifiedAt).toBeTruthy();
      const two = await googleSignIn(identity(email, sub));
      const s2 = await req("POST", "/v1/auth/google/exchange", null, { code: two.code, verifier: two.verifier });
      expect(s2.status).toBe(200);
      expect(s2.body.user.id).toBe(s1.body.user.id);
      // The first session is still good: nothing was revoked.
      expect((await me(s1.body.token)).status).toBe(200);
    });
  });

  // ── 3. OAuth state is bound to the browser; tokens have audiences; the handoff is a one-time code ──
  describe("Google OAuth state and handoff", () => {
    it("/start sets an HttpOnly, SameSite=Lax, path-scoped cookie and a state with the oauth_state audience", async () => {
      const p = pkce();
      const s = await googleStart(p.cv);
      expect(s.googleUrl.host).toBe("accounts.google.com");
      expect(s.setCookie).toMatch(/^g_state=[\w-]{20,};/);
      expect(s.setCookie).toMatch(/HttpOnly/i);
      expect(s.setCookie).toMatch(/SameSite=Lax/i);
      expect(s.setCookie).toMatch(/Path=\/v1\/auth\/google/i);
      expect(s.setCookie).toMatch(/Max-Age=600/i);
      const claims = jwt.decode(s.state).payload as any;
      expect(claims.aud).toBe("oauth_state");
      expect(claims.cv).toBe(p.cv);
      expect(`g_state=${claims.nonce}`).toBe(s.cookie);
      // A state is not a session.
      expect((await me(s.state)).status).toBe(401);
    });

    it("/start without a valid cv does not start a flow", async () => {
      for (const q of ["", "?cv=short", `?cv=${"a".repeat(44)}`, "?cv=has+bad/chars=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
        const r = await req("GET", `/v1/auth/google/start${q}`);
        expect(r.status).toBe(302);
        expect(r.headers.get("location")).toContain("https://app.scout.test/login?error=");
        expect(r.headers.get("set-cookie")).toBeNull();
      }
    });

    it("a state used without its cookie (another browser) is refused: no login CSRF", async () => {
      const email = `csrf-${randomUUID().slice(0, 8)}@example.com`;
      googleClaims = identity(email);
      const attacker = await googleStart(pkce().cv);
      // The victim's browser has no cookie at all...
      const none = await googleCallback(attacker.state);
      expect(none.headers.get("location")).toContain("/login?error=");
      expect(none.headers.get("location")).not.toContain("#code=");
      // ...or holds the cookie of a flow of its own.
      const victim = await googleStart(pkce().cv);
      const crossed = await googleCallback(attacker.state, victim.cookie);
      expect(crossed.headers.get("location")).toContain("/login?error=");
      const forgedCookie = await googleCallback(attacker.state, "g_state=not-the-nonce-000000000000");
      expect(forgedCookie.headers.get("location")).toContain("/login?error=");
      // No account was created by any of those.
      expect(await db.select().from(S.users).where(S.eq(S.users.email, email))).toHaveLength(0);
      // In the right browser it works, and the cookie is cleared on the way through.
      const ok = await googleCallback(attacker.state, attacker.cookie);
      expect(ok.headers.get("location")).toContain("https://app.scout.test/auth/google#code=");
      expect(ok.headers.get("location")).not.toContain("token=");
      expect(ok.headers.get("set-cookie")).toMatch(/g_state=;.*Max-Age=0/i);
    });

    it("a session JWT, an admin JWT, a legacy audience-less state and a wrong-audience state are not states", async () => {
      const u = await signup("confuse");
      const email = `conf-${randomUUID().slice(0, 8)}@example.com`;
      googleClaims = identity(email);
      const { env } = await import("./env.js");
      const now = Math.floor(Date.now() / 1000);
      const nonce = "n".repeat(32);
      const cv = pkce().cv;
      const cookie = `g_state=${nonce}`;
      const adminLogin = await req("POST", "/v1/admin/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(adminLogin.status).toBe(200);
      const candidates: Record<string, string> = {
        session: u.token,
        admin: adminLogin.body.token,
        // What a state looked like before audiences existed.
        legacyState: await jwt.sign({ next: "/", nonce, cv, iat: now, exp: now + 600 }, env.jwtSecret),
        // A session-audience token dressed up with state fields.
        sessionAud: await jwt.sign({ aud: "session", next: "/", nonce, cv, iat: now, exp: now + 600 }, env.jwtSecret),
        adminAud: await jwt.sign({ aud: "admin", role: "admin", next: "/", nonce, cv, iat: now, exp: now + 600 }, env.jwtSecret),
        expired: await jwt.sign({ aud: "oauth_state", next: "/", nonce, cv, iat: now - 1200, exp: now - 600 }, env.jwtSecret),
        wrongKey: await jwt.sign({ aud: "oauth_state", next: "/", nonce, cv, iat: now, exp: now + 600 }, "some-other-secret-some-other-secret"),
      };
      for (const [name, state] of Object.entries(candidates)) {
        const r = await googleCallback(state, cookie);
        expect(r.headers.get("location"), name).toContain("/login?error=");
        expect(r.headers.get("location"), name).not.toContain("#code=");
      }
      expect(await db.select().from(S.users).where(S.eq(S.users.email, email))).toHaveLength(0);
      // The control: the same fields WITH the right audience and the matching cookie pass.
      const good = await jwt.sign({ aud: "oauth_state", next: "/", nonce, cv, iat: now, exp: now + 600 }, env.jwtSecret);
      expect((await googleCallback(good, cookie)).headers.get("location")).toContain("#code=");
    });

    it("audiences hold in the other directions too: state and admin tokens are not sessions, sessions are not admin", async () => {
      const u = await signup("aud");
      const { env } = await import("./env.js");
      const now = Math.floor(Date.now() / 1000);
      const adminLogin = await req("POST", "/v1/admin/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect((await me(adminLogin.body.token)).status).toBe(401);
      expect((await req("GET", "/v1/admin/session", u.token)).status).toBe(401);
      // A token with the user's id but the wrong audience is not a session.
      for (const aud of ["oauth_state", "admin", "anything"]) {
        const t = await jwt.sign({ sub: u.userId, org: u.orgId, tv: 0, aud, iat: now, exp: now + 600 }, env.jwtSecret);
        expect((await me(t)).status, aud).toBe(401);
      }
      // A session-audience token with role admin is not an admin session.
      const fake = await jwt.sign({ role: "admin", aud: "session", iat: now, exp: now + 600 }, env.jwtSecret);
      expect((await req("GET", "/v1/admin/session", fake)).status).toBe(401);
      // Legacy tokens (issued before aud/tv existed) keep working while the token version is 0.
      const legacy = await jwt.sign({ sub: u.userId, org: u.orgId, iat: now, exp: now + 600 }, env.jwtSecret);
      expect((await me(legacy)).status).toBe(200);
      const legacyAdmin = await jwt.sign({ role: "admin", iat: now, exp: now + 600 }, env.adminJwtSecret);
      expect((await req("GET", "/v1/admin/session", legacyAdmin)).status).toBe(200);
      // New session tokens say what they are.
      expect(jwt.decode(u.token).payload).toMatchObject({ aud: "session", tv: 0, sub: u.userId });
      expect(jwt.decode(adminLogin.body.token).payload).toMatchObject({ aud: "admin", role: "admin" });
    });

    it("the handoff code needs the right verifier, works once, and expires", async () => {
      const email = `code-${randomUUID().slice(0, 8)}@example.com`;
      // Wrong verifier: refused, and the code is spent by the attempt.
      const a = await googleSignIn(identity(email, "g-code-" + email));
      expect(a.location).toMatch(/^https:\/\/app\.scout\.test\/auth\/google#code=[\w-]{40,}&next=%2Fleads$/);
      const wrong = await req("POST", "/v1/auth/google/exchange", null, { code: a.code, verifier: pkce().verifier });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.code).toBe("invalid_exchange_code");
      expect((await req("POST", "/v1/auth/google/exchange", null, { code: a.code, verifier: a.verifier })).status).toBe(400);

      // Right verifier: a session, same body as /login. Reuse: refused.
      const b = await googleSignIn(identity(email, "g-code-" + email));
      const ok = await req("POST", "/v1/auth/google/exchange", null, { code: b.code, verifier: b.verifier });
      expect(ok.status, ok.text).toBe(200);
      expect(Object.keys(ok.body).sort()).toEqual(["org", "token", "user"]);
      expect(ok.body.user.email).toBe(email);
      expect((await req("POST", "/v1/auth/google/exchange", null, { code: b.code, verifier: b.verifier })).status).toBe(400);

      // Expired.
      const c = await googleSignIn(identity(email, "g-code-" + email));
      await db.update(S.oauthExchangeCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(S.eq(S.oauthExchangeCodes.codeHash, createHash("sha256").update(c.code!).digest("hex")));
      expect((await req("POST", "/v1/auth/google/exchange", null, { code: c.code, verifier: c.verifier })).status).toBe(400);

      // Unknown code, and the code is stored only as a hash.
      expect((await req("POST", "/v1/auth/google/exchange", null, { code: randomBytes(32).toString("base64url"), verifier: b.verifier })).status).toBe(400);
      const stored = await db.select().from(S.oauthExchangeCodes);
      expect(stored.some((r: any) => r.codeHash === b.code)).toBe(false);
    });

    it("with Google sign-in not configured the routes are off, as before", async () => {
      const { env } = await import("./env.js");
      const saved = env.google.clientId;
      env.google.clientId = undefined as any;
      try {
        expect((await req("GET", "/v1/auth/google/status")).body).toEqual({ enabled: false });
        expect((await req("GET", `/v1/auth/google/start?cv=${pkce().cv}`)).status).toBe(400);
        expect((await req("GET", "/v1/auth/google/callback?code=x&state=y")).headers.get("location")).toContain("/login?error=");
        expect((await req("POST", "/v1/auth/google/exchange", null, { code: "c".repeat(43), verifier: "v".repeat(43) })).status).toBe(400);
      } finally {
        env.google.clientId = saved;
      }
    });

    it("CORS never allows credentials, so the state cookie cannot ride a cross-origin call", async () => {
      const pre = async (origin: string) => {
        const r = await app.request("/v1/auth/google/exchange", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
        return { acao: r.headers.get("access-control-allow-origin"), acac: r.headers.get("access-control-allow-credentials") };
      };
      expect(await pre("https://app.scout.test")).toEqual({ acao: "https://app.scout.test", acac: null });
      expect(await pre("https://my-preview-abc123.vercel.app")).toEqual({ acao: "https://my-preview-abc123.vercel.app", acac: null });
      expect(await pre("http://localhost:5173")).toEqual({ acao: "http://localhost:5173", acac: null });
      // Not reflected any more.
      for (const o of ["https://evil.netlify.app", "https://evil.pages.dev", "https://evil.example", "http://evil.vercel.app", "https://evilvercel.app", "https://x.vercel.app.evil.example", "null"]) {
        expect(await pre(o), o).toEqual({ acao: "https://app.scout.test", acac: null });
      }
    });
  });

  // ── 4. Sessions are revocable ──
  describe("session revocation", () => {
    it("a password change kills every older token and hands this browser a fresh one", async () => {
      const u = await signup("chg");
      const second = await req("POST", "/v1/auth/login", null, { email: u.email, password: u.password });
      expect(second.status).toBe(200);
      const r = await req("POST", "/v1/auth/password/change", u.token, { currentPassword: u.password, newPassword: "an-entirely-new-password" });
      expect(r.status, r.text).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(typeof r.body.token).toBe("string");
      expect((await me(u.token)).status).toBe(401);
      expect((await me(second.body.token)).status).toBe(401);
      expect((await me(r.body.token)).status).toBe(200);
      expect((jwt.decode(r.body.token).payload as any).tv).toBe(1);
      // API keys are workspace credentials, not sessions.
      expect((await req("GET", "/v1/auth/me", null, undefined, { "x-api-key": u.apiKey })).status).toBe(200);
      expect((await auditRows({ action: "auth.password_changed", orgId: u.orgId })).length).toBe(1);
    });

    it("a password reset kills every older token; the token in the reset response works", async () => {
      const u = await signup("rst");
      mocks.sent.length = 0;
      expect((await req("POST", "/v1/auth/password/forgot", null, { email: u.email })).status).toBe(200);
      const token = mocks.sent.find((m) => m.to === u.email)!.text.match(/token=([\w-]+)/)![1];
      const r = await req("POST", "/v1/auth/password/reset", null, { token, password: "reset-to-this-password-7" });
      expect(r.status, r.text).toBe(200);
      expect((await me(u.token)).status).toBe(401);
      expect((await me(r.body.token)).status).toBe(200);
      expect((await req("POST", "/v1/auth/login", null, { email: u.email, password: u.password })).status).toBe(401);
      expect((await req("POST", "/v1/auth/login", null, { email: u.email, password: "reset-to-this-password-7" })).status).toBe(200);
      const [row] = await db.select().from(S.users).where(S.eq(S.users.id, u.userId));
      expect(row.emailVerifiedAt).toBeTruthy();
      expect((await auditRows({ action: "auth.password_reset_requested", orgId: u.orgId })).length).toBe(1);
      expect((await auditRows({ action: "auth.password_reset", orgId: u.orgId })).length).toBe(1);
    });

    it("POST /v1/auth/logout-all signs out every session, including the caller's", async () => {
      const u = await signup("out");
      const other = await req("POST", "/v1/auth/login", null, { email: u.email, password: u.password });
      expect((await req("POST", "/v1/auth/logout-all")).status).toBe(401);
      expect((await req("POST", "/v1/auth/logout-all", null, undefined, { "x-api-key": u.apiKey })).status).toBe(403);
      const r = await req("POST", "/v1/auth/logout-all", u.token);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect((await me(u.token)).status).toBe(401);
      expect((await me(other.body.token)).status).toBe(401);
      const fresh = await req("POST", "/v1/auth/login", null, { email: u.email, password: u.password });
      expect(fresh.status).toBe(200);
      expect((await me(fresh.body.token)).status).toBe(200);
      expect((await auditRows({ action: "auth.logout_all", orgId: u.orgId })).length).toBe(1);
    });

    it("a forged token version does not help", async () => {
      const u = await signup("tv");
      await req("POST", "/v1/auth/logout-all", u.token);
      const { env } = await import("./env.js");
      const now = Math.floor(Date.now() / 1000);
      for (const tv of [0, 2, "1", null]) {
        const t = await jwt.sign({ sub: u.userId, org: u.orgId, tv, aud: "session", iat: now, exp: now + 600 }, env.jwtSecret);
        expect((await me(t)).status, String(tv)).toBe(401);
      }
      // A legacy token (no tv) counts as version 0, which this user has moved past.
      const legacy = await jwt.sign({ sub: u.userId, org: u.orgId, iat: now, exp: now + 600 }, env.jwtSecret);
      expect((await me(legacy)).status).toBe(401);
    });
  });

  // ── 5. Brute force, enumeration, password policy ──
  describe("sign-in lockout and password policy", () => {
    it("locks an account after 5 failures from 5 different addresses, before checking the password; a reset unlocks it", async () => {
      const u = await signup("lock");
      for (let i = 0; i < 5; i++) {
        const r = await req("POST", "/v1/auth/login", null, { email: u.email, password: `wrong-guess-${i}` });
        expect(r.status).toBe(401);
      }
      // Sixth attempt, from yet another address, WITH THE RIGHT PASSWORD: refused.
      const locked = await req("POST", "/v1/auth/login", null, { email: u.email.toUpperCase(), password: u.password });
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe("too_many_attempts");
      expect(locked.body.error.message).toMatch(/Try again in/);
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Number(locked.headers.get("retry-after"))).toBeLessThanOrEqual(900);
      expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      // Attempts made while locked are not recorded, so the lock cannot be extended forever.
      const count = async () => (await db.select().from(S.loginAttempts).where(S.eq(S.loginAttempts.subject, u.email))).length;
      const before = await count();
      await req("POST", "/v1/auth/login", null, { email: u.email, password: "another-wrong-one" });
      expect(await count()).toBe(before);
      // An existing session is unaffected: the lock is on the password form.
      expect((await me(u.token)).status).toBe(200);

      // Audit: five failures and the lock, with the address tried, no password anywhere.
      const failed = (await auditRows({ action: "auth.login", orgId: u.orgId })).filter((r: any) => r.result === "failed");
      expect(failed.length).toBe(5);
      expect(failed[0].data).toMatchObject({ email: u.email, reason: "wrong_password" });
      expect(failed[0].ip).toMatch(/^198\.18\./);
      expect(JSON.stringify(failed)).not.toContain("wrong-guess");
      // The lock is logged against the workspace, once - not once per refused attempt.
      const lockedRows = await auditRows({ action: "auth.login_locked", orgId: u.orgId });
      expect(lockedRows.length).toBe(1);
      expect(lockedRows[0]).toMatchObject({ result: "denied", targetId: u.userId });
      expect(lockedRows[0].data.email).toBe(u.email);

      // Reset by email: unlocked at once.
      mocks.sent.length = 0;
      await req("POST", "/v1/auth/password/forgot", null, { email: u.email });
      const token = mocks.sent.find((m) => m.to === u.email)!.text.match(/token=([\w-]+)/)![1];
      expect((await req("POST", "/v1/auth/password/reset", null, { token, password: "unlocked-with-this-1" })).status).toBe(200);
      const after = await req("POST", "/v1/auth/login", null, { email: u.email, password: "unlocked-with-this-1" });
      expect(after.status).toBe(200);
      const okRows = (await auditRows({ action: "auth.login", orgId: u.orgId })).filter((r: any) => r.result === "ok");
      expect(okRows.length).toBe(1);
      expect(okRows[0].actorUserId).toBe(u.userId);
    });

    it("a success resets the count; failures older than the window do not count", async () => {
      const u = await signup("reset-count");
      for (let i = 0; i < 4; i++) expect((await req("POST", "/v1/auth/login", null, { email: u.email, password: "nope-nope-nope" })).status).toBe(401);
      expect((await req("POST", "/v1/auth/login", null, { email: u.email, password: u.password })).status).toBe(200);
      for (let i = 0; i < 4; i++) expect((await req("POST", "/v1/auth/login", null, { email: u.email, password: "nope-nope-nope" })).status).toBe(401);
      expect((await req("POST", "/v1/auth/login", null, { email: u.email, password: u.password })).status).toBe(200);

      const old = await signup("old-fails");
      await db.insert(S.loginAttempts).values(Array.from({ length: 6 }, () => ({ subject: old.email, succeeded: false, createdAt: new Date(Date.now() - 16 * 60 * 1000) })));
      expect((await req("POST", "/v1/auth/login", null, { email: old.email, password: old.password })).status).toBe(200);
    });

    it("an unknown address locks the same way and costs a password check, so neither says who is a customer", async () => {
      const ghost = `nobody-${randomUUID().slice(0, 8)}@example.com`;
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await req("POST", "/v1/auth/login", null, { email: ghost, password: "whatever-it-is" })).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      // Nothing about an address with no account goes to the audit log (it would be unbounded).
      const all = await db.select().from(S.auditLog).where(S.sql`${S.auditLog.data}->>'email' = ${ghost}`);
      expect(all).toHaveLength(0);
      // Timing: the unknown-address path is not a 2ms shortcut any more.
      const real = await signup("timing");
      const time = async (email: string) => {
        const t = performance.now();
        await req("POST", "/v1/auth/login", null, { email, password: "definitely-not-it" });
        return performance.now() - t;
      };
      const known = await time(real.email);
      const unknown = await time(`nobody-${randomUUID().slice(0, 8)}@example.com`);
      expect(unknown).toBeGreaterThan(known / 4);
    });

    it("the admin login locks too, and failures and successes are audited", async () => {
      await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, "admin"));
      const since = new Date();
      const good = await req("POST", "/v1/admin/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(good.status).toBe(200);
      for (let i = 0; i < 5; i++) expect((await req("POST", "/v1/admin/login", null, { email: ADMIN_EMAIL, password: `guess-${i}` })).status).toBe(400);
      const locked = await req("POST", "/v1/admin/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe("too_many_attempts");
      // A dashboard session that is already signed in, and the token header, are unaffected.
      expect((await req("GET", "/v1/admin/session", good.body.token)).status).toBe(200);
      expect((await req("GET", "/v1/admin/session", null, undefined, { "x-admin-token": ADMIN_TOKEN })).status).toBe(200);
      const rows = (await auditRows({ action: "admin.login" })).filter((r: any) => r.createdAt >= since);
      expect(rows.filter((r: any) => r.result === "ok").length).toBe(1);
      expect(rows.filter((r: any) => r.result === "failed").length).toBe(5);
      expect(rows.filter((r: any) => r.result === "denied").length).toBe(1);
      expect(JSON.stringify(rows)).not.toContain(ADMIN_PASSWORD);
      expect(JSON.stringify(rows)).not.toContain("guess-");
      await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, "admin"));
    });

    it("refuses the passwords the 8-character floor let through, wherever a password is chosen", async () => {
      const email = `pw-${randomUUID().slice(0, 8)}@example.com`;
      const bad = ["        ", "aaaaaaaa", "12345678", "password", "Password", email, "p".repeat(40) + "é".repeat(20), "x".repeat(100_000)];
      for (const password of bad) {
        const r = await req("POST", "/v1/auth/signup", null, { email, password });
        expect(r.status, JSON.stringify(password.slice(0, 20))).toBe(400);
        expect(r.body.error.code, password.slice(0, 20)).toBe("weak_password");
      }
      // 8 characters is still enough, and 72 bytes exactly is fine.
      const u = await signup("policy", "tr0ub4dor");
      expect((await signup("policy72", "abc".repeat(24))).token).toBeTruthy();
      // Change and reset apply the same rules, and a refused reset does not spend the link.
      const chg = await req("POST", "/v1/auth/password/change", u.token, { currentPassword: "tr0ub4dor", newPassword: "11111111" });
      expect(chg.status).toBe(400);
      expect(chg.body.error.code).toBe("weak_password");
      mocks.sent.length = 0;
      await req("POST", "/v1/auth/password/forgot", null, { email: u.email });
      const token = mocks.sent.find((m) => m.to === u.email)!.text.match(/token=([\w-]+)/)![1];
      expect((await req("POST", "/v1/auth/password/reset", null, { token, password: u.email })).status).toBe(400);
      expect((await req("POST", "/v1/auth/password/reset", null, { token, password: "a-perfectly-fine-one" })).status).toBe(200);
    });

    it("NUL bytes in sign-up and sign-in input are a 400, never a 500", async () => {
      const email = `nul-${randomUUID().slice(0, 8)}@example.com`;
      const cases: [string, unknown][] = [
        ["/v1/auth/signup", { email, password: "good-password-123", name: "Bad\u0000Name" }],
        ["/v1/auth/signup", { email, password: "good-password-123", orgName: "Bad\u0000Org" }],
        ["/v1/auth/signup", { email, password: "good\u0000password-123" }],
        ["/v1/auth/signup", { email: `nul\u0000@example.com`, password: "good-password-123" }],
        ["/v1/auth/login", { email, password: "good\u0000password-123" }],
        ["/v1/auth/login", { email: `nul\u0000@example.com`, password: "x" }],
        ["/v1/auth/password/forgot", { email: `nul\u0000@example.com` }],
        ["/v1/auth/password/reset", { token: "t\u0000".repeat(10), password: "good-password-123" }],
      ];
      for (const [path, body] of cases) {
        const r = await req("POST", path, null, body);
        expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
        expect(r.text).not.toMatch(/insert into|select |\$2[aby]\$/i);
      }
      expect(await db.select().from(S.users).where(S.eq(S.users.email, email))).toHaveLength(0);
    });

    it("clientIp trusts cf-connecting-ip only when told Cloudflare is in front", async () => {
      const { Hono } = await import("hono");
      const { clientIp } = await import("./middleware.js");
      const { env } = await import("./env.js");
      const h = new Hono();
      h.get("/ip", (c) => c.text(clientIp(c)));
      const ask = async (headers: Record<string, string>) => (await h.request("/ip", { headers })).text();
      const saved = env.trustedProxy;
      try {
        env.trustedProxy = "cloudflare";
        expect(await ask({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1, 10.0.0.1" })).toBe("203.0.113.7");
        env.trustedProxy = "xff";
        // Not behind Cloudflare: the header is whatever the client typed, so it is ignored.
        expect(await ask({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6, 10.0.0.1" })).toBe("10.0.0.1");
        expect(await ask({ "cf-connecting-ip": "203.0.113.7" })).toBe("unknown");
        env.trustedProxy = "none";
        expect(await ask({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" })).toBe("unknown");
      } finally {
        env.trustedProxy = saved;
      }
    });
  });

  // ── Audit log: admin mutations, and the endpoint ──
  describe("audit log", () => {
    it("every admin mutation leaves a row against the workspace it changed, with before and after", async () => {
      const u = await signup("adm-target");
      const admin = { "x-admin-token": ADMIN_TOKEN };
      const plan = await req("PATCH", `/v1/admin/orgs/${u.orgId}/plan`, null, { plan: "growth" }, admin);
      expect(plan.status, plan.text).toBe(200);
      const [p] = await auditRows({ action: "admin.plan_changed", orgId: u.orgId });
      expect(p).toMatchObject({ actorType: "admin", orgId: u.orgId, targetType: "organization", targetId: u.orgId, result: "ok" });
      expect(p.data.before.plan).toBe("free");
      expect(p.data.after.plan).toBe("growth");
      expect(p.data.via).toBe("token");

      expect((await req("PATCH", `/v1/admin/orgs/${u.orgId}/credits`, null, { metric: "leads", action: "set", amount: 7 }, admin)).status).toBe(200);
      const [cr] = await auditRows({ action: "admin.credits_changed", orgId: u.orgId });
      expect(cr.data).toMatchObject({ metric: "leads", action: "set", before: { used: 0 }, after: { used: 7 } });

      // Through the dashboard session this time.
      await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, "admin"));
      const session = (await req("POST", "/v1/admin/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body.token;
      expect((await req("PATCH", `/v1/admin/orgs/${u.orgId}/status`, session, { status: "deactivated" })).status).toBe(200);
      const [st] = await auditRows({ action: "admin.status_changed", orgId: u.orgId });
      expect(st.data).toMatchObject({ before: { status: "active" }, after: { status: "deactivated" }, via: "session" });
      expect((await req("PATCH", `/v1/admin/orgs/${u.orgId}/status`, session, { status: "active" })).status).toBe(200);

      const [ur] = await db.insert(S.upgradeRequests).values({ orgId: u.orgId, name: "N", email: u.email, mobile: "+1", country: "IN", planId: "growth" }).returning();
      expect((await req("PATCH", `/v1/admin/upgrade-requests/${ur.id}`, session, { status: "contacted" })).status).toBe(200);
      const [urAudit] = await auditRows({ action: "admin.upgrade_request_status_changed", orgId: u.orgId });
      expect(urAudit.data).toMatchObject({ before: { status: "new" }, after: { status: "contacted" } });
      expect(urAudit.targetId).toBe(ur.id);

      const tools = (await req("GET", "/v1/admin/tools", session)).body.tools;
      if (tools?.length) {
        const provider = tools[0].provider;
        expect((await req("PATCH", `/v1/admin/tools/${provider}`, session, { notes: `audited ${Date.now()}` })).status).toBe(200);
        const rows = (await auditRows({ action: "admin.tool_limit_changed" })).filter((r: any) => r.targetId === provider);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].data.after.notes).toMatch(/^audited /);
        await req("PATCH", `/v1/admin/tools/${provider}`, session, { notes: tools[0].notes ?? null });
      }

      // An unknown workspace is a 404 and writes nothing.
      const ghost = randomUUID();
      expect((await req("PATCH", `/v1/admin/orgs/${ghost}/plan`, null, { plan: "growth" }, admin)).status).toBe(404);
      expect((await auditRows({ action: "admin.plan_changed" })).filter((r: any) => r.targetId === ghost)).toHaveLength(0);

      // The owner can see what was done to their workspace.
      const log = await req("GET", "/v1/audit-log?limit=200", u.token);
      expect(log.status).toBe(200);
      const actions = log.body.entries.map((e: any) => e.action);
      for (const a of ["auth.signup", "admin.plan_changed", "admin.credits_changed", "admin.status_changed"]) expect(actions).toContain(a);
      expect(log.body.entries.find((e: any) => e.action === "admin.plan_changed").actorType).toBe("admin");
    });

    it("GET /v1/audit-log: owners and admins only, own workspace only, newest first, paginated", async () => {
      const u = await signup("log-owner");
      const other = await signup("log-other");
      const memberEmail = `member-${randomUUID().slice(0, 8)}@example.com`;
      const [member] = await db.insert(S.users).values({ orgId: u.orgId, email: memberEmail, passwordHash: await A.hashPassword("member-password-1"), role: "member" }).returning();
      const memberToken = await A.issueJwt(member);

      expect((await req("GET", "/v1/audit-log")).status).toBe(401);
      const denied = await req("GET", "/v1/audit-log", memberToken);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("forbidden_role");
      // An API key is not a person: it does not read who signed in from where.
      expect((await req("GET", "/v1/audit-log", null, undefined, { "x-api-key": u.apiKey })).status).toBe(403);

      // Some activity: API key created and revoked, settings changed, a failed and a good login.
      const k = await req("POST", "/v1/auth/api-keys", u.token, { name: "CI" });
      expect(k.status).toBe(201);
      expect((await req("DELETE", `/v1/auth/api-keys/${k.body.id}`, u.token)).status).toBe(200);
      expect((await req("PATCH", "/v1/auth/org", u.token, { name: "Renamed Co", settings: { senderName: "Private Value 123" } })).status).toBe(200);
      await req("POST", "/v1/auth/login", null, { email: u.email, password: "not-the-password" });
      await req("POST", "/v1/auth/login", null, { email: u.email, password: u.password });

      const r = await req("GET", "/v1/audit-log", u.token);
      expect(r.status).toBe(200);
      const entries = r.body.entries as any[];
      const actions = entries.map((e) => e.action);
      for (const a of ["auth.signup", "apikey.created", "apikey.revoked", "org.settings_changed", "auth.login"]) expect(actions, a).toContain(a);
      // Shape.
      const created = entries.find((e) => e.action === "apikey.created");
      expect(Object.keys(created).sort()).toEqual(["action", "actorEmail", "actorType", "createdAt", "data", "id", "ip", "result", "targetId", "targetType"]);
      expect(created).toMatchObject({ actorType: "user", actorEmail: u.email, targetType: "api_key", targetId: k.body.id, result: "ok" });
      expect(created.data).toMatchObject({ name: "CI", prefix: k.body.prefix });
      // No secrets: not the key, not a setting's value, not a password.
      const dump = JSON.stringify(entries);
      expect(dump).not.toContain(k.body.key);
      expect(dump).not.toContain("Private Value 123");
      expect(dump).not.toContain("not-the-password");
      expect(entries.find((e) => e.action === "org.settings_changed").data).toMatchObject({ name: { before: "log-owner Co", after: "Renamed Co" }, settingsChanged: ["senderName"] });
      // Newest first.
      const times = entries.map((e) => new Date(e.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      // Tenancy: nothing of the other workspace, and they see nothing of this one.
      const theirs = await req("GET", "/v1/audit-log", other.token);
      expect(theirs.body.entries.every((e: any) => e.actorEmail === null || e.actorEmail === other.email)).toBe(true);
      expect(JSON.stringify(theirs.body)).not.toContain(u.email);
      expect(dump).not.toContain(other.email);

      // Pagination: limit + before walk the whole log without repeats or gaps.
      const seen: string[] = [];
      let before: string | null = null;
      for (let i = 0; i < 20; i++) {
        const page: any = await req("GET", `/v1/audit-log?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`, u.token);
        expect(page.status).toBe(200);
        expect(page.body.entries.length).toBeLessThanOrEqual(2);
        seen.push(...page.body.entries.map((e: any) => e.id));
        if (!page.body.hasMore) break;
        before = page.body.nextBefore;
        expect(before).toBeTruthy();
      }
      expect(seen).toEqual(entries.map((e) => e.id));
      expect((await req("GET", "/v1/audit-log?limit=201", u.token)).status).toBe(400);
      expect((await req("GET", "/v1/audit-log?before=yesterday", u.token)).status).toBe(400);
    });
  });

  // ── 9. Request body limits ──
  describe("request body limits", () => {
    const big = (bytes: number) => "a".repeat(bytes);
    /** A body with no declared length, like a chunked upload. */
    const stream = (bytes: number, chunk = 64 * 1024) => {
      let sent = 0;
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (sent >= bytes) return controller.close();
          const n = Math.min(chunk, bytes - sent);
          sent += n;
          controller.enqueue(new Uint8Array(n).fill(97));
        },
      });
      return { body, sent: () => sent, pulls: () => pulls };
    };

    it("413 on a public endpoint over 256 KB, by declared length and by stream", async () => {
      const declared = await app.request("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "content-length": String(50 * 1024 * 1024), "cf-connecting-ip": ip() }, body: "{}" });
      expect(declared.status).toBe(413);
      expect(await declared.json()).toMatchObject({ error: { code: "payload_too_large" } });

      const s = stream(50 * 1024 * 1024);
      const streamed = await app.request("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip() }, body: s.body, duplex: "half" } as any);
      expect(streamed.status).toBe(413);
      expect((await streamed.json()).error.code).toBe("payload_too_large");
      // Cut off at the limit: nowhere near the 50 MB on offer was read.
      expect(s.sent()).toBeLessThan(1024 * 1024);

      for (const path of ["/v1/auth/signup", "/v1/upgrade-requests", "/px/px_whatever/collect", "/t/u/sometoken", "/v1/email-events/resend", "/v1/auth/google/exchange", "/v1/admin/login"]) {
        const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip() }, body: JSON.stringify({ pad: big(300 * 1024) }) });
        expect(r.status, path).toBe(413);
      }
      // Under the limit the request is handled normally (here: rejected for what it says, not its size).
      const ok = await app.request("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip() }, body: JSON.stringify({ email: `small-${randomUUID().slice(0, 8)}@example.com`, password: "x", pad: big(100 * 1024) }) });
      expect(ok.status).toBe(401);
    });

    it("413 on the lead import over 10 MB and on any other authenticated endpoint over 1 MB", async () => {
      const u = await signup("limits");
      const auth = { authorization: `Bearer ${u.token}` };
      const csv20 = await app.request("/v1/leads/import", { method: "POST", headers: { ...auth, "content-type": "text/csv" }, body: `email\n${big(20 * 1024 * 1024)}` });
      expect(csv20.status).toBe(413);
      expect((await csv20.json()).error).toMatchObject({ code: "payload_too_large" });
      const s = stream(20 * 1024 * 1024);
      const chunked = await app.request("/v1/leads/import", { method: "POST", headers: { ...auth, "content-type": "text/csv" }, body: s.body, duplex: "half" } as any);
      expect(chunked.status).toBe(413);
      expect(s.sent()).toBeLessThan(11 * 1024 * 1024);
      // The import still takes a body well over the 1 MB default...
      const rows = ["email,first_name"];
      for (let i = 0; i < 20; i++) rows.push(`imp-${randomUUID().slice(0, 8)}-${i}@example.com,Pat`);
      const csv = `${rows.join("\n")}\n`;
      const fine = await app.request("/v1/leads/import", { method: "POST", headers: { ...auth, "content-type": "text/csv" }, body: csv });
      expect(fine.status, await fine.clone().text()).toBeLessThan(300);
      const twoMb = await app.request("/v1/leads/import", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ leads: [], pad: big(2 * 1024 * 1024) }) });
      expect(twoMb.status).not.toBe(413);
      // ...and nothing else does.
      const other = await app.request("/v1/leads", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ email: "x@example.com", pad: big(2 * 1024 * 1024) }) });
      expect(other.status).toBe(413);
      const patch = await app.request("/v1/auth/org", { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "x", pad: big(2 * 1024 * 1024) }) });
      expect(patch.status).toBe(413);
    }, 60_000);

    it("a signed webhook still gets its raw body: the limiter does not disturb what the handler reads", async () => {
      const { bodyLimitFor, BODY_LIMITS } = await import("./app.js");
      expect(bodyLimitFor("POST", "/v1/leads/import")).toBe(BODY_LIMITS.leadImport);
      expect(bodyLimitFor("POST", "/v1/billing/webhook")).toBe(BODY_LIMITS.default);
      expect(bodyLimitFor("POST", "/v1/email-events/resend")).toBe(BODY_LIMITS.publicPost);
      expect(bodyLimitFor("POST", "/v1/auth/login")).toBe(BODY_LIMITS.publicPost);
      expect(bodyLimitFor("PATCH", "/v1/auth/org")).toBe(BODY_LIMITS.default);
      expect(bodyLimitFor("POST", "/v1/leads")).toBe(BODY_LIMITS.default);
      // Byte-exact pass-through, both with a declared length and streamed.
      const { Hono } = await import("hono");
      const { bodyLimit } = await import("hono/body-limit");
      const h = new Hono();
      h.use("*", bodyLimit({ maxSize: 1024 }));
      h.post("/raw", async (c) => c.text(createHash("sha256").update(await c.req.text()).digest("hex")));
      const payload = `{"id":"evt_1","data":{"a":"é ✓ \\u0000"}}  \n`;
      const want = createHash("sha256").update(payload).digest("hex");
      expect(await (await h.request("/raw", { method: "POST", body: payload })).text()).toBe(want);
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(payload);
          controller.enqueue(bytes.slice(0, 7));
          controller.enqueue(bytes.slice(7));
          controller.close();
        },
      });
      expect(await (await h.request("/raw", { method: "POST", body: chunks, duplex: "half" } as any)).text()).toBe(want);
    });
  });

  // ── 10. Response headers ──
  describe("response security headers", () => {
    it("JSON responses lock everything down; sign-in responses are not cacheable", async () => {
      const r = await app.request("/v1/auth/google/status", { headers: { "cf-connecting-ip": ip() } });
      expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const err = await app.request("/v1/auth/me");
      expect(err.status).toBe(401);
      expect(err.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    it("/docs loads one pinned, integrity-checked script and nothing else", async () => {
      const r = await app.request("/docs");
      expect(r.status).toBe(200);
      const html = await r.text();
      const csp = r.headers.get("content-security-policy")!;
      const { SWAGGER_UI } = await import("./openapi.js");
      expect(SWAGGER_UI.js).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js$/);
      expect(html).toContain(`<script src="${SWAGGER_UI.js}" integrity="${SWAGGER_UI.jsIntegrity}" crossorigin="anonymous">`);
      expect(html).toContain(`integrity="${SWAGGER_UI.cssIntegrity}"`);
      expect(html).not.toMatch(/swagger-ui-dist@5\//);
      const nonce = html.match(/<script nonce="([^"]+)">/)![1];
      expect(csp).toContain(`script-src ${SWAGGER_UI.js} 'nonce-${nonce}'`);
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(csp).not.toContain("unsafe-eval");
      // A new nonce every time.
      expect((await (await app.request("/docs")).text()).match(/<script nonce="([^"]+)">/)![1]).not.toBe(nonce);
    });

    it("the unsubscribe page allows inline styles and a same-origin form, nothing more, and sends no referrer", async () => {
      const r = await app.request("/t/u/some-token-value");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    });
  });
});

// ── 7. Stored-credential encryption (no database needed) ──
describe("security: credential encryption", () => {
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let C: typeof import("./lib/crypto.js");
  let env: any;
  let saved: { encryptionKey: string; encryptionKeysOld: string[]; jwtSecret: string };

  /** Exactly what encrypt() produced before the v2 format: sha256(key), iv.tag.ct in base64. */
  const legacyEncrypt = (plain: string, rawKey: string) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", createHash("sha256").update(rawKey).digest(), iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
  };
  const flip = (b64: string) => {
    const b = Buffer.from(b64, "base64");
    b[0] ^= 1;
    return b.toString("base64");
  };

  beforeAll(async () => {
    C = await import("./lib/crypto.js");
    env = (await import("./env.js")).env;
    saved = { encryptionKey: env.encryptionKey, encryptionKeysOld: env.encryptionKeysOld, jwtSecret: env.jwtSecret };
  });
  afterAll(() => Object.assign(env, saved));
  const withKeys = <T>(k: Partial<typeof saved>, fn: () => T): T => {
    const before = { encryptionKey: env.encryptionKey, encryptionKeysOld: env.encryptionKeysOld, jwtSecret: env.jwtSecret };
    Object.assign(env, k);
    try {
      return fn();
    } finally {
      Object.assign(env, before);
    }
  };

  it("legacy blobs (production data) still decrypt, under ENCRYPTION_KEY and under the JWT_SECRET fallback", () => {
    const blob = legacyEncrypt(JSON.stringify({ pass: "smtp-pass" }), env.encryptionKey);
    expect(C.decryptJson(blob)).toEqual({ pass: "smtp-pass" });
    expect(C.decryptJsonStrict(blob)).toEqual({ pass: "smtp-pass" });
    // Written while ENCRYPTION_KEY was unset (key = JWT_SECRET), read after ENCRYPTION_KEY was added.
    const viaJwt = legacyEncrypt(JSON.stringify({ apiKey: "re_123" }), env.jwtSecret);
    expect(C.decryptJson(viaJwt)).toEqual({ apiKey: "re_123" });
    // And with ENCRYPTION_KEY unset entirely, exactly as before.
    withKeys({ encryptionKey: "" }, () => expect(C.decryptJson(viaJwt)).toEqual({ apiKey: "re_123" }));
  });

  it("new ciphertext is v2.<kid>.<iv>.<tag>.<ct> and round-trips", () => {
    const blob = C.encryptJson({ host: "smtp.example.com", pass: "pässword ✓" });
    const parts = blob.split(".");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toMatch(/^[0-9a-f]{12}$/);
    expect(Buffer.from(parts[2], "base64")).toHaveLength(12);
    expect(Buffer.from(parts[3], "base64")).toHaveLength(16);
    expect(blob).not.toContain("smtp.example.com");
    expect(C.decryptJson(blob)).toEqual({ host: "smtp.example.com", pass: "pässword ✓" });
    expect(C.decrypt(C.encrypt(""))).toBe("");
    expect(C.encrypt("same")).not.toBe(C.encrypt("same"));
  });

  it("a truncated tag is rejected (4 bytes used to be accepted), as is any tampering", () => {
    for (const blob of [legacyEncrypt('{"pass":"smtp-pass"}', env.encryptionKey), C.encrypt('{"pass":"smtp-pass"}')]) {
      const parts = blob.split(".");
      const [ivI, tagI, ctI] = parts.length === 5 ? [2, 3, 4] : [0, 1, 2];
      const swap = (i: number, v: string) => parts.map((p, j) => (j === i ? v : p)).join(".");
      for (const n of [4, 8, 12, 15]) {
        const short = Buffer.from(parts[tagI], "base64").subarray(0, n).toString("base64");
        expect(() => C.decrypt(swap(tagI, short)), `tag of ${n} bytes`).toThrow(C.CredentialUnreadableError);
        expect(C.decryptJson(swap(tagI, short))).toBeNull();
      }
      expect(() => C.decrypt(swap(tagI, flip(parts[tagI])))).toThrow(C.CredentialUnreadableError);
      expect(() => C.decrypt(swap(ctI, flip(parts[ctI])))).toThrow(C.CredentialUnreadableError);
      expect(() => C.decrypt(swap(ivI, flip(parts[ivI])))).toThrow(C.CredentialUnreadableError);
      expect(() => C.decrypt(swap(ivI, Buffer.from(parts[ivI], "base64").subarray(0, 8).toString("base64")))).toThrow(C.CredentialUnreadableError);
      expect(C.decrypt(blob)).toBe('{"pass":"smtp-pass"}');
    }
    for (const junk of ["not-a-blob", "a.b", "v2.x.y", "v2.kid.!!!.!!!.!!!", "....", ""]) expect(() => C.decrypt(junk), junk).toThrow(C.CredentialUnreadableError);
  });

  it("rotation: with the old key listed in ENCRYPTION_KEYS_OLD both formats still decrypt; without it they are unreadable, loudly", () => {
    const oldKey = env.encryptionKey;
    const v2 = C.encryptJson({ token: "crm-token" });
    const legacy = legacyEncrypt(JSON.stringify({ token: "crm-token" }), oldKey);
    const newKey = "rotated-key-".padEnd(48, "r");

    withKeys({ encryptionKey: newKey, encryptionKeysOld: [oldKey] }, () => {
      expect(C.decryptJson(v2)).toEqual({ token: "crm-token" });
      expect(C.decryptJson(legacy)).toEqual({ token: "crm-token" });
      // New writes use the new key, and carry a different key id.
      const fresh = C.encryptJson({ n: 1 });
      expect(fresh.split(".")[1]).not.toBe(v2.split(".")[1]);
      expect(C.decryptJson(fresh)).toEqual({ n: 1 });
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withKeys({ encryptionKey: newKey, encryptionKeysOld: [] }, () => {
      // The lenient reader still answers null (existing callers), but says so in the log...
      expect(C.decryptJson(v2)).toBeNull();
      // ...and the strict one tells "no config" apart from "cannot read the config".
      expect(() => C.decryptJsonStrict(v2)).toThrow(C.CredentialUnreadableError);
      expect(() => C.decryptJsonStrict(legacy)).toThrow(C.CredentialUnreadableError);
      expect(C.decryptJsonStrict(null)).toBeNull();
      expect(C.decryptJsonStrict("")).toBeNull();
      expect(C.decryptJsonStrict(undefined)).toBeNull();
    });
    warn.mockRestore();
  });

  it("AAD binds a ciphertext to its owner: a blob moved to another row does not decrypt there", () => {
    const blob = C.encryptJson({ pass: "p" }, "email_account:org-A:acct-1");
    expect(C.decryptJson(blob, "email_account:org-A:acct-1")).toEqual({ pass: "p" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(C.decryptJson(blob, "email_account:org-B:acct-9")).toBeNull();
    expect(C.decryptJson(blob)).toBeNull();
    expect(() => C.decryptJsonStrict(blob, "email_account:org-B:acct-9")).toThrow(C.CredentialUnreadableError);
    expect(() => C.decrypt(blob)).toThrow(C.CredentialUnreadableError);
    warn.mockRestore();
    // Unbound blobs (legacy, or v2 written before a call site passed an aad) open either way,
    // so a call site can start passing an aad without rewriting its rows first.
    const unbound = C.encryptJson({ pass: "p" });
    expect(C.decryptJson(unbound, "email_account:org-A:acct-1")).toEqual({ pass: "p" });
    expect(C.decryptJson(legacyEncrypt('{"pass":"p"}', env.encryptionKey), "anything")).toEqual({ pass: "p" });
  });

  it("decryptJsonStrict rejects a blob that decrypts to something that is not JSON", () => {
    expect(() => C.decryptJsonStrict(C.encrypt("not json"))).toThrow(C.CredentialUnreadableError);
  });
});

// ── 8. Startup checks ──
describe("security: startup warnings", () => {
  const boot = async (vars: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      const mod = await import("./env.js");
      return { env: mod.env, warnings: warn.mock.calls.map((c) => String(c[0])) };
    } finally {
      warn.mockRestore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  };

  it("production with a short JWT_SECRET or no ENCRYPTION_KEY starts, and says so loudly", async () => {
    const r = await boot({ NODE_ENV: "production", JWT_SECRET: "short-secret", ENCRYPTION_KEY: undefined });
    expect(r.env.jwtSecret).toBe("short-secret");
    expect(r.warnings.some((w) => /JWT_SECRET is only 12 characters/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /ENCRYPTION_KEY is not set/.test(w))).toBe(true);
    const fine = await boot({ NODE_ENV: "production", JWT_SECRET: "s".repeat(64), ENCRYPTION_KEY: "e".repeat(64) });
    expect(fine.warnings.filter((w) => /JWT_SECRET|ENCRYPTION_KEY/.test(w))).toEqual([]);
  });

  it("the built-in default JWT_SECRET is still fatal in production", async () => {
    // Set explicitly: with the variable merely absent, a developer's .env file would supply one.
    await expect(boot({ NODE_ENV: "production", JWT_SECRET: "dev-secret-change-me" })).rejects.toThrow(/built-in default/);
  });

  it("TRUSTED_PROXY: cloudflare on Render, xff on any other production host, explicit value wins", async () => {
    const base = { NODE_ENV: "production", JWT_SECRET: "s".repeat(64), ENCRYPTION_KEY: "e".repeat(64) };
    expect((await boot({ ...base, RENDER: "true", TRUSTED_PROXY: undefined })).env.trustedProxy).toBe("cloudflare");
    expect((await boot({ ...base, RENDER: undefined, TRUSTED_PROXY: undefined })).env.trustedProxy).toBe("xff");
    expect((await boot({ ...base, RENDER: "true", TRUSTED_PROXY: "none" })).env.trustedProxy).toBe("none");
    expect((await boot({ ...base, RENDER: undefined, TRUSTED_PROXY: "Cloudflare" })).env.trustedProxy).toBe("cloudflare");
  });

  it("ADMIN_JWT_SECRET, when set, signs the admin session with a different key", async () => {
    const base = { NODE_ENV: "test", JWT_SECRET: "s".repeat(64) };
    expect((await boot({ ...base, ADMIN_JWT_SECRET: undefined })).env.adminJwtSecret).toBe("s".repeat(64));
    expect((await boot({ ...base, ADMIN_JWT_SECRET: "a".repeat(64) })).env.adminJwtSecret).toBe("a".repeat(64));
  });
});
