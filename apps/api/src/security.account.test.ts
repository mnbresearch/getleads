/**
 * Account security features: two-factor sign-in, email verification, API key scopes,
 * security notification emails, sign-up and password-reset abuse limits, and the admin
 * console's platform security view.
 *
 * Through the real app (createApp) and a real database, except the TOTP block, which is pure
 * and checks the implementation against the RFC's own test vectors.
 *
 * The admin PASSWORD FORM (its authenticator code, its notices) is tested in
 * security.auth.test.ts, not here: that form has one lock subject for the whole platform, and
 * two test files signing in to it at the same time would trip each other's counts. Here the
 * admin API is reached with the server-to-server token, which has no lock.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

const ADMIN_TOKEN = `admin-${"b".repeat(40)}`;
const ADMIN_EMAIL = "root@scout.test";

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
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = "admin-password-for-tests-0123456789";
  process.env.MAIL_FROM = "Scout <no-reply@scout.test>";
  // Set (to nothing) rather than deleted: a variable that is merely absent would be filled in
  // from a developer's .env file. The tests switch the platform mailer on and off themselves.
  process.env.RESEND_API_KEY = "";
  process.env.SMTP_HOST = "";
  process.env.ADMIN_TOTP_SECRET = "";
  delete process.env.PILOT_INVITE_CODE;
  delete process.env.ADMIN_JWT_SECRET;
  delete process.env.ENCRYPTION_KEYS_OLD;
  delete process.env.TRUSTED_PROXY;
}

/** Every email the app tries to send in this file, captured instead of sent. */
const mocks = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], mode: "ok" as "ok" | "fail" | "throw" }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string; text: string }) => {
      if (mocks.mode === "throw") throw new Error("mail provider exploded");
      if (mocks.mode === "fail") return { ok: false, provider: "test", error: "provider said no" };
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}` };
    }),
  };
});

// ── Pure: the TOTP implementation against the RFCs ──
describe("TOTP (RFC 6238 / RFC 4226) and recovery codes", () => {
  /** The RFCs' shared secret: the ASCII string "12345678901234567890". */
  const KEY = Buffer.from("12345678901234567890", "ascii");

  it("base32 matches the RFC 4648 vectors and round-trips", async () => {
    const T = await import("./lib/totp.js");
    const vectors: [string, string][] = [["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
    for (const [plain, encoded] of vectors) {
      expect(T.base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(T.base32Decode(encoded)!.toString()).toBe(plain);
    }
    // As a person pastes it: lower case, grouped, padded.
    expect(T.base32Decode("mzxw 6ytb-oi======")!.toString()).toBe("foobar");
    // Never a partial decode.
    for (const bad of ["", "MZXW1", "MZXW6YTBO!", "M", "0OIL"]) expect(T.base32Decode(bad)).toBeNull();
    const secret = T.generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(T.base32Decode(secret)!.length).toBe(20);
    expect(T.base32Encode(T.base32Decode(secret)!)).toBe(secret);
  });

  it("HOTP matches the RFC 4226 appendix D values", async () => {
    const T = await import("./lib/totp.js");
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(T.hotp(KEY, counter)).toBe(code));
  });

  it("TOTP matches every SHA-1 vector in RFC 6238 appendix B", async () => {
    const T = await import("./lib/totp.js");
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    const secret = T.base32Encode(KEY);
    for (const [seconds, code] of vectors) {
      expect(T.hotp(KEY, T.totpStep(seconds * 1000), 8)).toBe(code);
      expect(T.totpCode(secret, seconds * 1000, 8)).toBe(code);
      // The 6-digit code an authenticator shows is the same number, shortened.
      expect(T.totpCode(secret, seconds * 1000)).toBe(code.slice(2));
    }
    expect(T.TOTP_STEP_SECONDS).toBe(30);
    expect(T.TOTP_DIGITS).toBe(6);
  });

  it("accepts the current step and one either side, nothing further, and never a step that was already used", async () => {
    const T = await import("./lib/totp.js");
    const secret = T.base32Encode(KEY);
    const at = 1_700_000_000_000;
    const step = T.totpStep(at);
    const codeAt = (ms: number) => T.totpCode(secret, ms)!;
    expect(T.verifyTotp(secret, codeAt(at), { atMs: at })).toBe(step);
    expect(T.verifyTotp(secret, codeAt(at - 30_000), { atMs: at })).toBe(step - 1);
    expect(T.verifyTotp(secret, codeAt(at + 30_000), { atMs: at })).toBe(step + 1);
    expect(T.verifyTotp(secret, codeAt(at - 60_000), { atMs: at })).toBeNull();
    expect(T.verifyTotp(secret, codeAt(at + 60_000), { atMs: at })).toBeNull();
    // Typed with a space, as apps display it.
    const c = codeAt(at);
    expect(T.verifyTotp(secret, `${c.slice(0, 3)} ${c.slice(3)}`, { atMs: at })).toBe(step);
    // Replay: the step that was accepted last, or any before it, is refused.
    expect(T.verifyTotp(secret, c, { atMs: at, afterStep: step })).toBeNull();
    expect(T.verifyTotp(secret, c, { atMs: at, afterStep: step + 1 })).toBeNull();
    expect(T.verifyTotp(secret, c, { atMs: at, afterStep: step - 1 })).toBe(step);
    // Not a code at all.
    for (const bad of ["", "12345", "1234567", "abcdef", null, undefined, 123456]) expect(T.verifyTotp(secret, bad, { atMs: at })).toBeNull();
    expect(T.verifyTotp("not base32!", c, { atMs: at })).toBeNull();
  });

  it("builds the otpauth link an authenticator app reads", async () => {
    const T = await import("./lib/totp.js");
    expect(T.otpauthUrl("ada@example.com", "JBSWY3DPEHPK3PXP")).toBe("otpauth://totp/Scout:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Scout");
  });

  it("recovery codes: ten, xxxx-xxxx-xxxx, no look-alike characters, forgiving on the way back in", async () => {
    const T = await import("./lib/totp.js");
    const codes = T.generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
    expect(codes.join("")).not.toMatch(/[ilou]/);
    const one = codes[0];
    expect(T.normaliseRecoveryCode(one.toUpperCase())).toBe(one);
    expect(T.normaliseRecoveryCode(one.replace(/-/g, " "))).toBe(one);
    expect(T.normaliseRecoveryCode(one.replace(/-/g, ""))).toBe(one);
    // A zero read as the letter O, a one read as l or I.
    expect(T.normaliseRecoveryCode("O0Il-1111-aaaa")).toBe("0011-1111-aaaa");
    for (const bad of ["", "abcd-efgh", "abcd-efgh-jkmn-pqrs", "abcd-efgh-jkm!", "uuuu-uuuu-uuuu", null, 42]) expect(T.normaliseRecoveryCode(bad)).toBeNull();
    expect(T.hashRecoveryCode(one)).toBe(createHash("sha256").update(one).digest("hex"));
  });
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] ${JSON.stringify("security: account")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests for two-factor sign-in, email verification, API key scopes, security emails and the admin security view.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("security: two-factor, verification, key scopes, notices, abuse limits, admin security view", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db
  let env: any;
  let T: typeof import("./lib/totp.js");
  let A: typeof import("./lib/auth.js");
  let E: typeof import("./lib/emailVerification.js");
  let M: typeof import("./lib/securityMail.js");
  let R: typeof import("./lib/rateWindow.js");
  let jwt: typeof import("hono/jwt");

  type Acct = { token: string; orgId: string; userId: string; email: string; password: string; apiKey: string; signupIp: string };

  /** A distinct client IP per call, so the per-IP limits never couple tests. */
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const from = (addr: string) => ({ "cf-connecting-ip": addr });

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
  const admin = (method: string, path: string, body?: unknown) => req(method, `/v1/admin${path}`, null, body, { "x-admin-token": ADMIN_TOKEN });

  const PASSWORD = "correct-horse-battery";
  async function signup(name: string, password = PASSWORD): Promise<Acct> {
    const email = `${name}-${randomUUID().slice(0, 8)}@acct.example.com`;
    const signupIp = ip();
    const r = await req("POST", "/v1/auth/signup", undefined, { email, password, orgName: `${name} Co` }, from(signupIp));
    expect(r.status, r.text).toBe(201);
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id, email, password, apiKey: r.body.apiKey, signupIp };
  }
  const me = (token: string) => req("GET", "/v1/auth/me", token);
  const login = (email: string, password: string, headers: Record<string, string> = {}) => req("POST", "/v1/auth/login", null, { email, password }, headers);
  const userRow = async (id: string) => (await db.select().from(S.users).where(S.eq(S.users.id, id)))[0];
  const auditRows = (orgId: string, action: string) =>
    db
      .select()
      .from(S.auditLog)
      .where(S.and(S.eq(S.auditLog.action, action), S.eq(S.auditLog.orgId, orgId)))
      .orderBy(S.desc(S.auditLog.createdAt));
  const mailsTo = (to: string, subject?: RegExp) => mocks.sent.filter((m) => m.to === to && (!subject || subject.test(m.subject)));
  /** Security mails are sent without being waited for; give them a moment. */
  const waitForMail = (to: string, subject: RegExp) => vi.waitFor(() => expect(mailsTo(to, subject).length, `mail to ${to} matching ${subject}`).toBeGreaterThan(0), { timeout: 3000 });
  /** Long enough for a mail that is NOT expected to have been sent, had it been going to. */
  const settle = () => new Promise((r) => setTimeout(r, 150));

  const mailerOn = () => {
    env.resendApiKey = "re_test_key_not_real";
  };
  const mailerOff = () => {
    env.resendApiKey = undefined;
  };

  /** The code the user's authenticator shows now (or `shift` steps away). */
  const codeFor = (secret: string, shift = 0) => T.totpCode(secret, Date.now() + shift * 30_000)!;
  /**
   * Forget which time step was used last. A code is good once per 30-second step, so a test
   * that needs several accepted codes in a row would otherwise have to wait out the clock.
   * (The replay rule itself is tested without this.)
   */
  const freshStep = (userId: string) => db.update(S.users).set({ totpLastStep: null }).where(S.eq(S.users.id, userId));
  /** A code that is certainly wrong right now. */
  const wrongCode = (secret: string) => {
    const valid = new Set([-1, 0, 1].map((s) => codeFor(secret, s)));
    let n = 100000;
    while (valid.has(String(n))) n++;
    return String(n);
  };

  /** Sign up and turn two-factor on. Leaves no step recorded, so the next code is accepted. */
  async function enrolled(name: string): Promise<Acct & { secret: string; recoveryCodes: string[] }> {
    const u = await signup(name);
    const setup = await req("POST", "/v1/auth/2fa/setup", u.token, { currentPassword: u.password });
    expect(setup.status, setup.text).toBe(200);
    const on = await req("POST", "/v1/auth/2fa/enable", u.token, { code: codeFor(setup.body.secret) });
    expect(on.status, on.text).toBe(200);
    await freshStep(u.userId);
    return { ...u, secret: setup.body.secret, recoveryCodes: on.body.recoveryCodes };
  }
  /** The password step of a two-factor sign-in: returns the challenge. */
  async function challengeFor(u: { email: string; password: string }, headers: Record<string, string> = {}) {
    const r = await login(u.email, u.password, headers);
    expect(r.status, r.text).toBe(200);
    expect(r.body.twoFactorRequired).toBe(true);
    expect(r.body.token).toBeUndefined();
    return r.body.challenge as string;
  }
  const verify2fa = (challenge: string, code: string, headers: Record<string, string> = {}) => req("POST", "/v1/auth/2fa/verify", null, { challenge, code }, headers);

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    ({ env } = await import("./env.js"));
    T = await import("./lib/totp.js");
    A = await import("./lib/auth.js");
    E = await import("./lib/emailVerification.js");
    M = await import("./lib/securityMail.js");
    R = await import("./lib/rateWindow.js");
    jwt = await import("hono/jwt");
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 60_000);

  beforeEach(() => {
    mocks.mode = "ok";
    mailerOn();
  });

  afterAll(() => {
    mailerOff();
  });

  // ── 1. Two-factor sign-in ──
  describe("two-factor sign-in", () => {
    it("enrol -> sign-in asks for a code -> the code completes it", async () => {
      const u = await signup("tfa-flow");
      expect((await me(u.token)).body.user.twoFactorEnabled).toBe(false);

      // Setup needs the current password: an unlocked laptop is not enough to bind a phone.
      const noPw = await req("POST", "/v1/auth/2fa/setup", u.token, {});
      expect(noPw.status).toBe(400);
      expect(noPw.body.error.code).toBe("current_password_required");
      const wrongPw = await req("POST", "/v1/auth/2fa/setup", u.token, { currentPassword: "not-the-password" });
      expect(wrongPw.status).toBe(403);
      expect(wrongPw.body.error.code).toBe("invalid_credentials");
      expect((await req("POST", "/v1/auth/2fa/setup", null, { currentPassword: u.password })).status).toBe(401);

      const setup = await req("POST", "/v1/auth/2fa/setup", u.token, { currentPassword: u.password });
      expect(setup.status, setup.text).toBe(200);
      const secret: string = setup.body.secret;
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.body.otpauthUrl).toBe(`otpauth://totp/Scout:${encodeURIComponent(u.email)}?secret=${secret}&issuer=Scout`);
      expect(setup.headers.get("cache-control")).toBe("no-store");

      // Stored encrypted, bound to this user, and not on yet.
      let row = await userRow(u.userId);
      expect(row.totpSecretEncrypted).toMatch(/^v2\./);
      expect(row.totpSecretEncrypted).not.toContain(secret);
      expect(row.totpEnabledAt).toBeNull();
      const C = await import("./lib/crypto.js");
      expect(C.decrypt(row.totpSecretEncrypted, `totp:${u.userId}`)).toBe(secret);
      expect(() => C.decrypt(row.totpSecretEncrypted, `totp:${randomUUID()}`)).toThrow();
      // Half set up changes nothing about signing in.
      expect((await me(u.token)).body.user.twoFactorEnabled).toBe(false);
      expect((await login(u.email, u.password)).body.token).toBeTruthy();

      // Enabling takes a code from the authenticator. A recovery-code-shaped value is not one.
      const bad = await req("POST", "/v1/auth/2fa/enable", u.token, { code: wrongCode(secret) });
      expect(bad.status).toBe(403);
      expect(bad.body.error.code).toBe("invalid_2fa_code");
      expect((await req("POST", "/v1/auth/2fa/enable", u.token, {})).status).toBe(400);
      mocks.sent.length = 0;
      const on = await req("POST", "/v1/auth/2fa/enable", u.token, { code: codeFor(secret) });
      expect(on.status, on.text).toBe(200);
      expect(on.body.ok).toBe(true);
      const recovery: string[] = on.body.recoveryCodes;
      expect(recovery).toHaveLength(10);
      for (const c of recovery) expect(c).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
      // Only hashes are stored.
      const stored = await db.select().from(S.userRecoveryCodes).where(S.eq(S.userRecoveryCodes.userId, u.userId));
      expect(stored).toHaveLength(10);
      expect(new Set(stored.map((r: any) => r.codeHash))).toEqual(new Set(recovery.map((c) => createHash("sha256").update(c).digest("hex"))));
      expect(JSON.stringify(stored)).not.toContain(recovery[0]);
      row = await userRow(u.userId);
      expect(row.totpEnabledAt).toBeInstanceOf(Date);
      const enabledStep = Number(row.totpLastStep);
      expect(enabledStep).toBeGreaterThan(0);
      const meOn = (await me(u.token)).body.user;
      expect(meOn.twoFactorEnabled).toBe(true);
      expect(new Date(meOn.twoFactorEnabledAt).getTime()).toBe(row.totpEnabledAt.getTime());
      // Audited, and the owner is told - without the secret or the codes in the mail.
      expect((await auditRows(u.orgId, "auth.2fa_enabled"))[0]).toMatchObject({ result: "ok", actorUserId: u.userId, targetId: u.userId });
      expect((await auditRows(u.orgId, "auth.2fa_failed")).length).toBe(1);
      await waitForMail(u.email, /Two-factor sign-in was turned on/);
      const mail = mailsTo(u.email, /Two-factor sign-in was turned on/)[0];
      expect(mail.text).not.toContain(secret);
      for (const c of recovery) expect(mail.text).not.toContain(c);
      // Already on: setup and enable both say so.
      expect((await req("POST", "/v1/auth/2fa/setup", u.token, { currentPassword: u.password })).body.error.code).toBe("two_factor_already_enabled");
      expect((await req("POST", "/v1/auth/2fa/enable", u.token, { code: codeFor(secret) })).status).toBe(409);

      // Sign-in: a right password gets a challenge and NO token.
      const step1 = await login(u.email, u.password);
      expect(step1.status).toBe(200);
      expect(Object.keys(step1.body).sort()).toEqual(["challenge", "twoFactorRequired"]);
      expect(step1.body.twoFactorRequired).toBe(true);
      const challenge: string = step1.body.challenge;
      // A wrong password is still just a wrong password.
      expect((await login(u.email, "not-the-password")).status).toBe(401);

      // The challenge is not a session...
      const asSession = await me(challenge);
      expect(asSession.status).toBe(401);
      expect((await req("GET", "/v1/leads", challenge)).status).toBe(401);
      expect(await A.authenticate(`Bearer ${challenge}`)).toBeNull();
      // ...and a session is not a challenge.
      const sessionAsChallenge = await verify2fa(u.token, codeFor(secret, 1));
      expect(sessionAsChallenge.status).toBe(401);
      expect(sessionAsChallenge.body.error.code).toBe("invalid_2fa_challenge");
      expect((await verify2fa("not.a.token", codeFor(secret, 1))).body.error.code).toBe("invalid_2fa_challenge");

      // A wrong code.
      const wrong = await verify2fa(challenge, wrongCode(secret));
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe("invalid_2fa_code");
      // The code that turned two-factor on was used for that: it does not also sign in.
      const replayOfEnable = await verify2fa(challenge, T.hotp(T.base32Decode(secret)!, enabledStep));
      expect(replayOfEnable.status).toBe(401);
      expect(replayOfEnable.body.error.code).toBe("invalid_2fa_code");

      // The next code completes the sign-in, with the same body as a plain login.
      const next = T.hotp(T.base32Decode(secret)!, enabledStep + 1);
      const done = await verify2fa(challenge, next);
      expect(done.status, done.text).toBe(200);
      expect(done.body.token).toBeTruthy();
      expect(done.body.user).toMatchObject({ id: u.userId, email: u.email, twoFactorEnabled: true });
      expect(done.body.org.id).toBe(u.orgId);
      expect((await me(done.body.token)).status).toBe(200);
      expect((await auditRows(u.orgId, "auth.login"))[0]).toMatchObject({ result: "ok", data: expect.objectContaining({ via: "password+2fa", secondFactor: "totp" }) });
      expect((await auditRows(u.orgId, "auth.2fa_challenge")).length).toBeGreaterThan(0);

      // Replay: the same code again, with the same challenge or a new one, is refused.
      const replay = await verify2fa(challenge, next);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe("invalid_2fa_code");
      const replay2 = await verify2fa(await challengeFor(u), next);
      expect(replay2.status).toBe(401);
    });

    it("a challenge dies with the sessions (token version) and expires on its own", async () => {
      const u = await enrolled("tfa-chal");
      const challenge = await challengeFor(u);
      // Signed, aud "2fa", five minutes, carries the user and their token version.
      const payload = jwt.decode(challenge).payload as any;
      expect(payload.aud).toBe("2fa");
      expect(payload.sub).toBe(u.userId);
      expect(payload.tv).toBe(0);
      expect(payload.exp - payload.iat).toBe(300);
      // "Sign out everywhere" moves the version: the outstanding challenge is dead.
      expect((await req("POST", "/v1/auth/logout-all", u.token)).status).toBe(200);
      const dead = await verify2fa(challenge, codeFor(u.secret));
      expect(dead.status).toBe(401);
      expect(dead.body.error.code).toBe("invalid_2fa_challenge");
      // An expired one, and one signed with the wrong secret.
      const now = Math.floor(Date.now() / 1000);
      const expired = await jwt.sign({ sub: u.userId, tv: 1, aud: "2fa", iat: now - 400, exp: now - 100 }, process.env.JWT_SECRET!);
      expect((await verify2fa(expired, codeFor(u.secret))).body.error.code).toBe("invalid_2fa_challenge");
      const forged = await jwt.sign({ sub: u.userId, tv: 1, aud: "2fa", iat: now, exp: now + 300 }, "some-other-secret-0123456789abcdef");
      expect((await verify2fa(forged, codeFor(u.secret))).body.error.code).toBe("invalid_2fa_challenge");
      // Every other audience this API signs is refused as a challenge, and a "2fa" token is
      // refused as a session whatever else it claims.
      for (const aud of ["session", "admin", "oauth_state", undefined]) {
        const t = await jwt.sign({ sub: u.userId, org: u.orgId, tv: 1, ...(aud ? { aud } : {}), iat: now, exp: now + 300 }, process.env.JWT_SECRET!);
        expect((await verify2fa(t, codeFor(u.secret))).body.error.code, String(aud)).toBe("invalid_2fa_challenge");
      }
      const dressedUp = await jwt.sign({ sub: u.userId, org: u.orgId, tv: 1, aud: "2fa", iat: now, exp: now + 300 }, process.env.JWT_SECRET!);
      expect((await me(dressedUp)).status).toBe(401);
      // A current challenge still works.
      const ok = await verify2fa(await challengeFor(u), codeFor(u.secret));
      expect(ok.status, ok.text).toBe(200);
    });

    it("a recovery code signs in once, in any spelling, and says how many are left", async () => {
      const u = await enrolled("tfa-recovery");
      const [first, second] = u.recoveryCodes;
      const r1 = await verify2fa(await challengeFor(u), first);
      expect(r1.status, r1.text).toBe(200);
      expect(r1.body.token).toBeTruthy();
      expect(r1.body.usedRecoveryCode).toBe(true);
      expect(r1.body.recoveryCodesLeft).toBe(9);
      expect((await auditRows(u.orgId, "auth.login"))[0].data).toMatchObject({ secondFactor: "recovery" });
      // Single use.
      const again = await verify2fa(await challengeFor(u), first);
      expect(again.status).toBe(401);
      expect(again.body.error.code).toBe("invalid_2fa_code");
      // Upper case, no dashes.
      const r2 = await verify2fa(await challengeFor(u), second.replace(/-/g, "").toUpperCase());
      expect(r2.status, r2.text).toBe(200);
      expect(r2.body.recoveryCodesLeft).toBe(8);
      // Somebody else's recovery code is not this account's.
      const other = await enrolled("tfa-recovery-other");
      expect((await verify2fa(await challengeFor(u), other.recoveryCodes[0])).status).toBe(401);
      const usedRows = await db.select().from(S.userRecoveryCodes).where(S.eq(S.userRecoveryCodes.userId, u.userId));
      expect(usedRows.filter((r: any) => r.usedAt).length).toBe(2);
    });

    it("five wrong codes lock the account's sign-in, right code or not, password step included", async () => {
      const u = await enrolled("tfa-lock");
      const challenge = await challengeFor(u);
      for (let i = 0; i < 5; i++) {
        const r = await verify2fa(challenge, wrongCode(u.secret));
        expect(r.status, `attempt ${i}`).toBe(401);
        expect(r.body.error.code).toBe("invalid_2fa_code");
      }
      // Sixth: the right code, from yet another address - refused, because the account is locked.
      const locked = await verify2fa(challenge, codeFor(u.secret));
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe("too_many_attempts");
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
      // The same lock the password form uses: a right password from a new address is refused too.
      const pw = await login(u.email, u.password);
      expect(pw.status).toBe(429);
      expect(pw.body.error.code).toBe("too_many_attempts");
      expect((await auditRows(u.orgId, "auth.2fa_failed")).length).toBe(5);
      expect((await auditRows(u.orgId, "auth.login_locked")).length).toBeGreaterThan(0);
      // The right password alone never made an address "known": nothing was recorded as a success.
      const successes = await db.select().from(S.loginAttempts).where(S.and(S.eq(S.loginAttempts.subject, u.email), S.eq(S.loginAttempts.succeeded, true)));
      expect(successes.map((r: any) => r.ip)).toEqual([u.signupIp]);
      // The address the owner signed up from is judged on its own failures: still gets in.
      const home = from(u.signupIp);
      const ok = await verify2fa(await challengeFor(u, home), codeFor(u.secret), home);
      expect(ok.status, ok.text).toBe(200);
    });

    it("turning it off needs a code; then the password alone signs in again", async () => {
      const u = await enrolled("tfa-off");
      const none = await req("POST", "/v1/auth/2fa/disable", u.token, {});
      expect(none.status).toBe(400);
      const wrong = await req("POST", "/v1/auth/2fa/disable", u.token, { code: wrongCode(u.secret) });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe("invalid_2fa_code");
      // 403, not 401: the session is fine and must survive a mistyped code.
      expect((await me(u.token)).status).toBe(200);
      expect((await me(u.token)).body.user.twoFactorEnabled).toBe(true);
      // The password is not a code.
      expect((await req("POST", "/v1/auth/2fa/disable", u.token, { code: u.password })).status).toBe(403);
      expect((await req("POST", "/v1/auth/2fa/disable", null, { code: codeFor(u.secret) })).status).toBe(401);

      mocks.sent.length = 0;
      const off = await req("POST", "/v1/auth/2fa/disable", u.token, { code: codeFor(u.secret) });
      expect(off.status, off.text).toBe(200);
      expect(off.body).toEqual({ ok: true });
      const row = await userRow(u.userId);
      expect(row.totpSecretEncrypted).toBeNull();
      expect(row.totpEnabledAt).toBeNull();
      expect(row.totpLastStep).toBeNull();
      expect(await db.select().from(S.userRecoveryCodes).where(S.eq(S.userRecoveryCodes.userId, u.userId))).toHaveLength(0);
      expect((await me(u.token)).body.user.twoFactorEnabled).toBe(false);
      const plain = await login(u.email, u.password);
      expect(plain.status).toBe(200);
      expect(plain.body.token).toBeTruthy();
      expect(plain.body.twoFactorRequired).toBeUndefined();
      expect((await auditRows(u.orgId, "auth.2fa_disabled"))[0]).toMatchObject({ result: "ok", actorUserId: u.userId });
      expect((await auditRows(u.orgId, "auth.2fa_failed")).length).toBe(2);
      await waitForMail(u.email, /Two-factor sign-in was turned off/);
      // Off: nothing to turn off, and nothing to issue codes for.
      expect((await req("POST", "/v1/auth/2fa/disable", u.token, { code: "123456" })).body.error.code).toBe("two_factor_not_enabled");
      expect((await req("POST", "/v1/auth/2fa/recovery-codes", u.token, { code: "123456" })).body.error.code).toBe("two_factor_not_enabled");
    });

    it("a recovery code can turn it off too; five wrong codes from a session are locked out for a while", async () => {
      const u = await enrolled("tfa-off-recovery");
      for (let i = 0; i < 5; i++) expect((await req("POST", "/v1/auth/2fa/disable", u.token, { code: wrongCode(u.secret) })).status).toBe(403);
      const locked = await req("POST", "/v1/auth/2fa/disable", u.token, { code: codeFor(u.secret) });
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe("too_many_attempts");
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
      // That lock is the session's own: signing in is not affected by it.
      const signIn = await verify2fa(await challengeFor(u), codeFor(u.secret));
      expect(signIn.status, signIn.text).toBe(200);
      // Once the lock is gone, a recovery code is enough.
      await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, `2fa:${u.userId}`));
      const off = await req("POST", "/v1/auth/2fa/disable", u.token, { code: u.recoveryCodes[3] });
      expect(off.status, off.text).toBe(200);
      expect((await auditRows(u.orgId, "auth.2fa_disabled"))[0].data).toMatchObject({ confirmedWith: "recovery" });
    });

    it("new recovery codes need a code, and replace the old ones", async () => {
      const u = await enrolled("tfa-regen");
      expect((await req("POST", "/v1/auth/2fa/recovery-codes", u.token, {})).status).toBe(400);
      expect((await req("POST", "/v1/auth/2fa/recovery-codes", u.token, { code: wrongCode(u.secret) })).status).toBe(403);
      const r = await req("POST", "/v1/auth/2fa/recovery-codes", u.token, { code: codeFor(u.secret) });
      expect(r.status, r.text).toBe(200);
      const fresh: string[] = r.body.recoveryCodes;
      expect(fresh).toHaveLength(10);
      expect(fresh.some((c) => u.recoveryCodes.includes(c))).toBe(false);
      expect((await auditRows(u.orgId, "auth.2fa_recovery_codes_regenerated")).length).toBe(1);
      await freshStep(u.userId);
      // An old code no longer signs in; a new one does.
      expect((await verify2fa(await challengeFor(u), u.recoveryCodes[0])).status).toBe(401);
      expect((await verify2fa(await challengeFor(u), fresh[0])).status).toBe(200);
    });

    it("changing the password needs a code as well when two-factor is on", async () => {
      const u = await enrolled("tfa-pwchange");
      const body = { currentPassword: u.password, newPassword: "a-brand-new-password-1" };
      const none = await req("POST", "/v1/auth/password/change", u.token, body);
      expect(none.status).toBe(400);
      expect(none.body.error.code).toBe("two_factor_code_required");
      const wrong = await req("POST", "/v1/auth/password/change", u.token, { ...body, code: wrongCode(u.secret) });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe("invalid_2fa_code");
      // Nothing changed so far.
      expect((await login(u.email, u.password)).body.twoFactorRequired).toBe(true);
      // A weak new password is refused BEFORE the code is spent.
      const weak = await req("POST", "/v1/auth/password/change", u.token, { currentPassword: u.password, newPassword: "password123", code: codeFor(u.secret) });
      expect(weak.status).toBe(400);
      expect(weak.body.error.code).toBe("weak_password");
      expect((await userRow(u.userId)).totpLastStep).toBeNull();
      const ok = await req("POST", "/v1/auth/password/change", u.token, { ...body, code: codeFor(u.secret) });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.token).toBeTruthy();
      expect((await login(u.email, u.password)).status).toBe(401);
      expect((await login(u.email, body.newPassword)).body.twoFactorRequired).toBe(true);
      // Two-factor is still on after a password change.
      expect((await me(ok.body.token)).body.user.twoFactorEnabled).toBe(true);
    });

    it("a password reset on a two-factor account changes the password but still asks for the code", async () => {
      const u = await enrolled("tfa-reset");
      mocks.sent.length = 0;
      expect((await req("POST", "/v1/auth/password/forgot", null, { email: u.email })).status).toBe(200);
      const token = mailsTo(u.email, /Reset your Scout password/)[0].text.match(/token=([\w-]+)/)![1];
      const r = await req("POST", "/v1/auth/password/reset", null, { token, password: "after-the-reset-password-1" });
      expect(r.status, r.text).toBe(200);
      expect(r.body.twoFactorRequired).toBe(true);
      expect(r.body.challenge).toBeTruthy();
      expect(r.body.token).toBeUndefined();
      expect(r.body.user).toBeUndefined();
      // The reset itself happened: old password gone, old session gone, address proved.
      expect((await me(u.token)).status).toBe(401);
      expect((await login(u.email, u.password)).status).toBe(401);
      expect((await userRow(u.userId)).emailVerifiedAt).toBeInstanceOf(Date);
      // The mailbox alone did not make this address known for the account.
      const successes = await db.select().from(S.loginAttempts).where(S.and(S.eq(S.loginAttempts.subject, u.email), S.eq(S.loginAttempts.succeeded, true), S.isNotNull(S.loginAttempts.ip)));
      expect(successes).toHaveLength(0);
      // The challenge from the reset completes with a code, like any sign-in.
      expect((await verify2fa(r.body.challenge, wrongCode(u.secret))).status).toBe(401);
      const done = await verify2fa(r.body.challenge, codeFor(u.secret));
      expect(done.status, done.text).toBe(200);
      expect((await me(done.body.token)).body.user.email).toBe(u.email);
      await waitForMail(u.email, /Your Scout password was reset/);
      // And the link is spent.
      expect((await req("POST", "/v1/auth/password/reset", null, { token, password: "yet-another-password-1" })).status).toBe(400);
    });

    it("verifySecondFactor: a yes-or-no check for other routes, with the same single-use and lockout rules", async () => {
      const u = await enrolled("tfa-helper");
      const row = () => userRow(u.userId);
      // Off for this user: never true.
      const plain = await signup("tfa-helper-plain");
      expect(await A.verifySecondFactor(await userRow(plain.userId), "123456")).toBe(false);
      expect(await A.verifySecondFactor(await row(), "")).toBe(false);
      // Right code: yes, once.
      const code = codeFor(u.secret);
      expect(await A.verifySecondFactor(await row(), code)).toBe(true);
      expect(await A.verifySecondFactor(await row(), code)).toBe(false);
      // A recovery code: yes, once.
      expect(await A.verifySecondFactor(await row(), u.recoveryCodes[0])).toBe(true);
      expect(await A.verifySecondFactor(await row(), u.recoveryCodes[0])).toBe(false);
      // Each refusal is in the workspace's log, and the fifth locks the check for a while.
      await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, `2fa:${u.userId}`));
      for (let i = 0; i < 5; i++) expect(await A.verifySecondFactor(await row(), wrongCode(u.secret), { during: "account.deleted" })).toBe(false);
      expect((await auditRows(u.orgId, "auth.2fa_failed"))[0]).toMatchObject({ result: "failed", actorUserId: u.userId, data: { during: "account.deleted" } });
      await freshStep(u.userId);
      await expect(A.verifySecondFactor(await row(), codeFor(u.secret))).rejects.toMatchObject({ status: 429, code: "too_many_attempts" });
    });

    it("an account with no password (Google) sets two-factor up without one; Google sign-in is not asked for the code", async () => {
      const u = await signup("tfa-google");
      await db.update(S.users).set({ passwordHash: await A.unusablePasswordHash("google:test"), googleSub: `g-${randomUUID()}` }).where(S.eq(S.users.id, u.userId));
      const setup = await req("POST", "/v1/auth/2fa/setup", u.token, {});
      expect(setup.status, setup.text).toBe(200);
      expect((await req("POST", "/v1/auth/2fa/enable", u.token, { code: codeFor(setup.body.secret) })).status).toBe(200);
      expect((await me(u.token)).body.user).toMatchObject({ twoFactorEnabled: true, hasPassword: false });
    });

    it("the admin console sees who has two-factor on, and support can reset it", async () => {
      const u = await enrolled("tfa-admin");
      const other = await signup("tfa-admin-other");
      const detail = await admin("GET", `/orgs/${u.orgId}`);
      expect(detail.status).toBe(200);
      const listed = detail.body.users.find((x: any) => x.id === u.userId);
      expect(listed).toMatchObject({ email: u.email, twoFactorEnabled: true, emailVerified: false });
      // Yes or no only: nothing of the secret leaves the database.
      expect(JSON.stringify(detail.body)).not.toMatch(/totp/i);
      expect((await admin("GET", `/orgs/${other.orgId}`)).body.users[0].twoFactorEnabled).toBe(false);

      // Customers cannot call it; the user must belong to the workspace named.
      expect((await req("POST", `/v1/admin/orgs/${u.orgId}/users/${u.userId}/reset-2fa`, u.token)).status).toBe(401);
      expect((await admin("POST", `/orgs/${other.orgId}/users/${u.userId}/reset-2fa`)).status).toBe(404);
      expect((await me(u.token)).body.user.twoFactorEnabled).toBe(true);

      mocks.sent.length = 0;
      const reset = await admin("POST", `/orgs/${u.orgId}/users/${u.userId}/reset-2fa`);
      expect(reset.status, reset.text).toBe(200);
      expect(reset.body).toEqual({ userId: u.userId, twoFactorEnabled: false, changed: true });
      const row = await userRow(u.userId);
      expect(row.totpSecretEncrypted).toBeNull();
      expect(row.totpEnabledAt).toBeNull();
      expect(await db.select().from(S.userRecoveryCodes).where(S.eq(S.userRecoveryCodes.userId, u.userId))).toHaveLength(0);
      // The password alone signs in again; the session they had still works.
      expect((await login(u.email, u.password)).body.token).toBeTruthy();
      expect((await me(u.token)).body.user.twoFactorEnabled).toBe(false);
      expect((await admin("GET", `/orgs/${u.orgId}`)).body.users.find((x: any) => x.id === u.userId).twoFactorEnabled).toBe(false);
      // In the workspace's own security log, as the operator's action.
      const [logged] = await auditRows(u.orgId, "admin.2fa_reset");
      expect(logged).toMatchObject({ actorType: "admin", targetId: u.userId, result: "ok", data: expect.objectContaining({ email: u.email, wasEnabled: true }) });
      // The user is told, and the mail does not carry the operator's address.
      await waitForMail(u.email, /Two-factor sign-in was reset/);
      const mail = mailsTo(u.email, /Two-factor sign-in was reset/)[0];
      expect(mail.text).toContain("By: the Scout support team");
      expect(mail.text).not.toMatch(/IP address/);
      // Again: nothing to do, nothing logged, nobody mailed.
      mocks.sent.length = 0;
      const again = await admin("POST", `/orgs/${u.orgId}/users/${u.userId}/reset-2fa`);
      expect(again.body).toMatchObject({ changed: false, twoFactorEnabled: false });
      expect((await auditRows(u.orgId, "admin.2fa_reset")).length).toBe(1);
      await settle();
      expect(mailsTo(u.email)).toHaveLength(0);
    });
  });

  // ── 2. Sessions ──
  describe("session tokens", () => {
    it("nothing is a session for longer than a session is issued for, whatever its exp says", async () => {
      const u = await signup("sess-cap");
      const now = Math.floor(Date.now() / 1000);
      const day = 24 * 60 * 60;
      const mint = (iat: number) => jwt.sign({ sub: u.userId, org: u.orgId, tv: 0, aud: "session", iat, exp: now + 365 * day }, process.env.JWT_SECRET!);
      expect((await me(await mint(now - 13 * day))).status).toBe(200);
      expect((await me(await mint(now - 15 * day))).status).toBe(401);
      expect(A.SESSION_TTL_SECONDS).toBe(14 * day);
      expect(A.sessionTooOld(now - 15 * day)).toBe(true);
      expect(A.sessionTooOld(now - day)).toBe(false);
      expect(A.sessionTooOld(undefined)).toBe(false);
      // The token the API issues itself lives exactly that long.
      const issued = jwt.decode(u.token).payload as any;
      expect(issued.exp - issued.iat).toBe(14 * day);
      expect(issued.aud).toBe("session");
    });
  });

  // ── 3. Email verification ──
  describe("email verification", () => {
    const linkToken = (to: string) => mailsTo(to, /Confirm your email address/).at(-1)!.text.match(/verify-email\?token=([\w-]+)/)![1];

    it("signup emails a single-use link; confirming it verifies the address", async () => {
      mocks.sent.length = 0;
      const email = `verify-${randomUUID().slice(0, 8)}@acct.example.com`;
      const r = await req("POST", "/v1/auth/signup", undefined, { email, password: PASSWORD, orgName: "Verify Co" });
      expect(r.status, r.text).toBe(201);
      expect(r.body.verificationEmailSent).toBe(true);
      expect(r.body.user.emailVerified).toBe(false);
      expect(r.body.org.emailVerificationAvailable).toBe(true);
      const mail = mailsTo(email, /Confirm your email address/)[0];
      expect(mail.text).toContain("https://app.scout.test/verify-email?token=");
      const token = linkToken(email);
      // Only the hash is stored, with a 24-hour expiry.
      const rows = await db.select().from(S.emailVerificationTokens).where(S.eq(S.emailVerificationTokens.userId, r.body.user.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(JSON.stringify(rows)).not.toContain(token);
      const ttlHours = (rows[0].expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(ttlHours).toBeGreaterThan(23.9);
      expect(ttlHours).toBeLessThanOrEqual(24);

      const before = await me(r.body.token);
      expect(before.body.user.emailVerified).toBe(false);
      expect(before.body.emailVerificationAvailable).toBe(true);
      expect(before.body.org.emailVerificationAvailable).toBe(true);

      // A wrong token, then the right one - no session needed, the token is the credential.
      const bad = await req("POST", "/v1/auth/verify/confirm", null, { token: "x".repeat(43) });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_verification_token");
      const ok = await req("POST", "/v1/auth/verify/confirm", null, { token });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body).toEqual({ ok: true });
      expect((await me(r.body.token)).body.user.emailVerified).toBe(true);
      expect((await auditRows(r.body.org.id, "auth.email_verified")).length).toBe(1);
      expect((await auditRows(r.body.org.id, "auth.verification_sent"))[0]).toMatchObject({ result: "ok", data: expect.objectContaining({ on: "signup" }) });
      // Single use.
      const again = await req("POST", "/v1/auth/verify/confirm", null, { token });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe("invalid_verification_token");
    });

    it("an expired link is refused, and confirming one link kills the others", async () => {
      const u = await signup("verify-expiry");
      const expired = await E.issueVerificationToken(u.userId, -1000);
      const r = await req("POST", "/v1/auth/verify/confirm", null, { token: expired });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_verification_token");
      expect((await me(u.token)).body.user.emailVerified).toBe(false);

      const first = await E.issueVerificationToken(u.userId);
      const second = await E.issueVerificationToken(u.userId);
      expect((await req("POST", "/v1/auth/verify/confirm", null, { token: first })).status).toBe(200);
      expect((await req("POST", "/v1/auth/verify/confirm", null, { token: second })).status).toBe(400);
      const live = await db.select().from(S.emailVerificationTokens).where(S.and(S.eq(S.emailVerificationTokens.userId, u.userId), S.isNull(S.emailVerificationTokens.usedAt), S.gt(S.emailVerificationTokens.expiresAt, new Date())));
      expect(live).toHaveLength(0);
      // Two tabs with the same link: one of them wins.
      const v = await signup("verify-race");
      const token = await E.issueVerificationToken(v.userId);
      const both = await Promise.all([E.confirmVerificationToken(token), E.confirmVerificationToken(token)]);
      expect(both.filter(Boolean)).toHaveLength(1);
    });

    it("resend: three an hour, a new link each time, nothing for an address that is already verified", async () => {
      const u = await signup("verify-resend");
      mocks.sent.length = 0;
      expect((await req("POST", "/v1/auth/verify/resend")).status).toBe(401);
      const tokens = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const r = await req("POST", "/v1/auth/verify/resend", u.token);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toEqual({ ok: true, emailed: true });
        tokens.add(linkToken(u.email));
      }
      expect(tokens.size).toBe(3);
      const fourth = await req("POST", "/v1/auth/verify/resend", u.token);
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.message).toMatch(/already sent 3 confirmation emails/);
      expect(mailsTo(u.email, /Confirm your email address/)).toHaveLength(3);
      // The newest link works.
      expect((await req("POST", "/v1/auth/verify/confirm", null, { token: [...tokens].at(-1) })).status).toBe(200);
      const done = await req("POST", "/v1/auth/verify/resend", u.token);
      expect(done.body).toEqual({ ok: true, emailed: false, alreadyVerified: true });

      // A send that fails says so instead of looking like success.
      const v = await signup("verify-resend-fail");
      mocks.mode = "fail";
      const failed = await req("POST", "/v1/auth/verify/resend", v.token);
      expect(failed.status).toBe(200);
      expect(failed.body.emailed).toBe(false);
      expect(failed.body.message).toMatch(/could not be sent/);
    });

    it("signup never fails because of the verification mail, and sends nothing without a mailer", async () => {
      for (const mode of ["fail", "throw"] as const) {
        mocks.mode = mode;
        const r = await req("POST", "/v1/auth/signup", undefined, { email: `verify-${mode}-${randomUUID().slice(0, 8)}@acct.example.com`, password: PASSWORD });
        expect(r.status, r.text).toBe(201);
        expect(r.body.verificationEmailSent).toBe(false);
        expect(r.body.token).toBeTruthy();
      }
      mocks.mode = "ok";
      mailerOff();
      mocks.sent.length = 0;
      const email = `verify-nomail-${randomUUID().slice(0, 8)}@acct.example.com`;
      const r = await req("POST", "/v1/auth/signup", undefined, { email, password: PASSWORD });
      expect(r.status).toBe(201);
      expect(r.body.verificationEmailSent).toBe(false);
      expect(r.body.org.emailVerificationAvailable).toBe(false);
      expect(mailsTo(email)).toHaveLength(0);
      expect(await db.select().from(S.emailVerificationTokens).where(S.eq(S.emailVerificationTokens.userId, r.body.user.id))).toHaveLength(0);
      const m = await me(r.body.token);
      expect(m.body.emailVerificationAvailable).toBe(false);
      expect(m.body.user.emailVerified).toBe(false);
      expect((await req("POST", "/v1/auth/verify/resend", r.body.token)).body).toEqual({ ok: true, emailed: false });
    });

    it("requireVerifiedEmail: 403 email_unverified for an unverified caller, and a no-op when verification is not available", async () => {
      const { Hono } = await import("hono");
      const { errorHandler } = await import("./lib/errors.js");
      const { requireAuth } = await import("./middleware.js");
      const h = new Hono();
      h.onError(errorHandler);
      h.post("/guarded", requireAuth as any, async (c) => {
        await E.requireVerifiedEmail(c);
        return c.json({ ok: true });
      });
      const call = async (headers: Record<string, string>) => {
        const res = await h.request("/guarded", { method: "POST", headers });
        return { status: res.status, body: (await res.json()) as any };
      };

      const u = await signup("verify-guard");
      const bearer = { authorization: `Bearer ${u.token}` };
      const key = { "x-api-key": u.apiKey };

      // Available + unverified: refused, in words that name the address and what to do.
      const refused = await call(bearer);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("email_unverified");
      expect(refused.body.error.message).toBe(`Confirm your email address first - we sent a link to ${u.email}. You can send it again from the banner at the top.`);
      // An API key has no person behind it: the workspace's owner answers for it.
      const viaKey = await call(key);
      expect(viaKey.status).toBe(403);
      expect(viaKey.body.error.code).toBe("email_unverified");
      expect(await E.workspaceEmailVerified(u.orgId)).toBe(false);

      // Not available (no platform mailer): nothing is restricted.
      mailerOff();
      expect((await call(bearer)).status).toBe(200);
      expect((await call(key)).status).toBe(200);
      expect(await E.workspaceEmailVerified(u.orgId)).toBe(true);
      mailerOn();

      // An unverified member of a workspace whose owner IS verified: judged on their own address.
      await db.update(S.users).set({ emailVerifiedAt: new Date() }).where(S.eq(S.users.id, u.userId));
      expect((await call(bearer)).status).toBe(200);
      expect((await call(key)).status).toBe(200);
      expect(await E.workspaceEmailVerified(u.orgId)).toBe(true);
      const [member] = await db
        .insert(S.users)
        .values({ orgId: u.orgId, email: `member-${randomUUID().slice(0, 8)}@acct.example.com`, passwordHash: "x", role: "member" })
        .returning();
      const memberCall = await call({ authorization: `Bearer ${await A.issueJwt(member)}` });
      expect(memberCall.status).toBe(403);
      expect(memberCall.body.error.message).toContain(member.email);
      // Everything else keeps working while unverified.
      const fresh = await signup("verify-guard-rest");
      expect((await req("GET", "/v1/leads", fresh.token)).status).toBe(200);
      expect((await req("POST", "/v1/leads/lists", fresh.token, { name: "A list" })).status).toBeLessThan(300);
    });

    it("accounts that existed before, and Google sign-ups, are not asked", async () => {
      const u = await signup("verify-existing");
      // What migration 0018 did for every account that existed at release time.
      await db.update(S.users).set({ emailVerifiedAt: new Date(Date.now() - 86_400_000) }).where(S.eq(S.users.id, u.userId));
      expect((await me(u.token)).body.user.emailVerified).toBe(true);
      mocks.sent.length = 0;
      expect((await E.sendVerificationEmail(await userRow(u.userId))).emailed).toBe(false);
      expect(mailsTo(u.email)).toHaveLength(0);
    });
  });

  // ── 4. API key scopes ──
  describe("API key scopes", () => {
    const viaKey = (method: string, path: string, key: string, body?: unknown) => req(method, path, null, body, { "x-api-key": key });

    it("a read key may GET and nothing else; a full key and existing keys are unchanged", async () => {
      const u = await signup("scope");
      mocks.sent.length = 0;
      const made = await req("POST", "/v1/auth/api-keys", u.token, { name: "Dashboard", scope: "read" });
      expect(made.status, made.text).toBe(201);
      expect(made.body.scope).toBe("read");
      const readKey: string = made.body.key;
      const full = await req("POST", "/v1/auth/api-keys", u.token, { name: "CI" });
      expect(full.status).toBe(201);
      expect(full.body.scope).toBe("full");
      expect((await req("POST", "/v1/auth/api-keys", u.token, { name: "Bad", scope: "admin" })).status).toBe(400);

      const rows = await db.select().from(S.apiKeys).where(S.eq(S.apiKeys.orgId, u.orgId));
      expect(rows.find((k: any) => k.id === made.body.id).scopes).toEqual(["read"]);
      expect(rows.find((k: any) => k.id === full.body.id).scopes).toEqual(["*"]);
      // The key handed out at signup (and every key from before scopes) is full access.
      expect(rows.find((k: any) => k.name === "Default").scopes).toEqual(["*"]);

      const list = await req("GET", "/v1/auth/api-keys", u.token);
      const byName = Object.fromEntries(list.body.apiKeys.map((k: any) => [k.name, k]));
      expect(byName.Dashboard).toMatchObject({ scope: "read", scopes: ["read"] });
      expect(byName.CI).toMatchObject({ scope: "full", scopes: ["*"] });
      expect(byName.Default).toMatchObject({ scope: "full" });
      expect((await auditRows(u.orgId, "apikey.created")).map((r: any) => r.data.scope).sort()).toEqual(["full", "read"]);

      // Reading works.
      expect((await viaKey("GET", "/v1/leads", readKey)).status).toBe(200);
      expect((await viaKey("GET", "/v1/usage", readKey)).status).toBe(200);
      const who = await viaKey("GET", "/v1/auth/me", readKey);
      expect(who.status).toBe(200);
      expect(who.body.apiKey).toMatchObject({ name: "Dashboard", scope: "read" });
      const head = await app.request("/v1/leads", { method: "HEAD", headers: { "x-api-key": readKey, "cf-connecting-ip": ip() } });
      expect(head.status).toBe(200);

      // Changing anything does not, whatever the method.
      const post = await viaKey("POST", "/v1/leads/lists", readKey, { name: "Nope" });
      expect(post.status).toBe(403);
      expect(post.body.error).toEqual({ code: "insufficient_scope", message: "This API key is read-only. Create a full-access key to make changes." });
      expect((await viaKey("PATCH", `/v1/leads/${randomUUID()}`, readKey, { title: "x" })).body.error.code).toBe("insufficient_scope");
      expect((await viaKey("DELETE", `/v1/leads/${randomUUID()}`, readKey)).body.error.code).toBe("insufficient_scope");
      expect((await viaKey("PUT", "/v1/integrations/webhook", readKey, { config: {} })).body.error.code).toBe("insufficient_scope");
      // As a bearer token too.
      expect((await req("POST", "/v1/leads/lists", readKey, { name: "Nope" })).body.error.code).toBe("insufficient_scope");
      expect(await db.select().from(S.lists).where(S.eq(S.lists.orgId, u.orgId))).toHaveLength(0);
      // Logged for the workspace - once, not once per retry.
      const denied = await auditRows(u.orgId, "apikey.scope_denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({ result: "denied", actorType: "api_key", targetId: made.body.id });

      // Full keys, old and new, still write. So does the session.
      expect((await viaKey("POST", "/v1/leads/lists", full.body.key, { name: "From CI" })).status).toBeLessThan(300);
      expect((await viaKey("POST", "/v1/leads/lists", u.apiKey, { name: "From default" })).status).toBeLessThan(300);
      expect((await req("POST", "/v1/leads/lists", u.token, { name: "From session" })).status).toBeLessThan(300);

      // A stored scope this code does not know never widens a key.
      await db.update(S.apiKeys).set({ scopes: ["something-new"] }).where(S.eq(S.apiKeys.id, full.body.id));
      expect((await viaKey("POST", "/v1/leads/lists", full.body.key, { name: "x" })).status).toBe(403);
      expect((await viaKey("GET", "/v1/leads", full.body.key)).status).toBe(200);

      // The creator is told about each new key - never with the key in the mail.
      await vi.waitFor(() => expect(mailsTo(u.email, /A new API key was created/).length).toBe(2));
      const mails = mailsTo(u.email, /A new API key was created/);
      expect(mails.some((m) => m.text.includes('named "Dashboard"') && m.text.includes("read-only access"))).toBe(true);
      expect(mails.some((m) => m.text.includes('named "CI"') && m.text.includes("full access"))).toBe(true);
      for (const m of mails) {
        expect(m.text).not.toContain(readKey);
        expect(m.text).not.toContain(full.body.key);
        expect(m.text).not.toContain(readKey.slice(12));
      }
    });

    it("the admin API is a different credential altogether: a read key changes nothing there", async () => {
      const u = await signup("scope-admin");
      const made = await req("POST", "/v1/auth/api-keys", u.token, { name: "R", scope: "read" });
      expect((await viaKey("GET", "/v1/admin/orgs", made.body.key)).status).toBe(401);
      // The server-to-server admin token is not subject to key scopes.
      expect((await admin("PATCH", `/orgs/${u.orgId}/status`, { status: "active" })).status).toBe(200);
    });
  });

  // ── 5. Security notification emails ──
  describe("security notification emails", () => {
    it("says what happened, when (UTC), from where, and what to do - in plain text, with no secrets", async () => {
      const at = new Date("2026-10-03T18:22:41Z");
      const kinds = ["password_changed", "password_reset", "twofa_enabled", "twofa_disabled", "twofa_reset_by_support", "api_key_created", "new_signin", "admin_new_signin", "admin_locked"] as const;
      const subjects = new Set<string>();
      for (const kind of kinds) {
        const m = M.securityMail(kind, "ada@example.com", { ip: "203.0.113.9", at, keyName: "CI", keyPrefix: "px_live_abcd", keyScope: "read", retryAfterSeconds: 600 });
        subjects.add(m.subject);
        expect(m.subject, kind).toMatch(/Scout/);
        expect(m.text, kind).toContain("When: 2026-10-03 18:22 UTC");
        if (kind === "twofa_reset_by_support") expect(m.text).toContain("By: the Scout support team");
        else expect(m.text, kind).toContain("From: IP address 203.0.113.9 (approximate)");
        if (!kind.startsWith("admin_")) {
          expect(m.text, kind).toContain("https://app.scout.test/forgot-password");
          expect(m.text, kind).toContain("contact@mnbresearch.com");
        }
        // No em dashes, no HTML, no server setting names.
        expect(m.text, kind).not.toMatch(/[\u2013\u2014]|<\/?[a-z]|_SECRET|_KEY|ADMIN_PASSWORD/);
      }
      expect(subjects.size).toBe(kinds.length);
      expect(M.securityMail("password_changed", "ada@example.com", {}).subject).toBe("Your Scout password was changed");
      expect(M.securityMail("new_signin", "ada@example.com", { ip: "unknown" }).text).toContain("From: an address we could not determine");
      // Tenant-chosen text cannot add lines to the mail.
      expect(M.securityMail("api_key_created", "ada@example.com", { keyName: "x\r\nBcc: evil@example.com" }).text).not.toMatch(/\nBcc:/);
    });

    it("password change, password reset and sign-in from a new address each mail the owner", async () => {
      const u = await signup("notice");
      mocks.sent.length = 0;

      // Never on signup, and not for the address that signed up.
      await settle();
      expect(mailsTo(u.email, /New sign-in/)).toHaveLength(0);
      expect((await login(u.email, u.password, from(u.signupIp))).status).toBe(200);
      await settle();
      expect(mailsTo(u.email, /New sign-in/)).toHaveLength(0);

      // A new address: one mail, naming it.
      const cafe = ip();
      expect((await login(u.email, u.password, from(cafe))).status).toBe(200);
      await waitForMail(u.email, /New sign-in to your Scout account/);
      const signin = mailsTo(u.email, /New sign-in/)[0];
      expect(signin.text).toContain(`From: IP address ${cafe} (approximate)`);
      expect(signin.text).toMatch(/When: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
      expect(signin.text).toContain("https://app.scout.test/forgot-password");
      expect((await auditRows(u.orgId, "auth.login"))[0].data).toMatchObject({ newAddress: true });
      // The same address again is known now; and another new one within the hour does not
      // produce a second mail.
      expect((await login(u.email, u.password, from(cafe))).status).toBe(200);
      expect((await login(u.email, u.password, from(ip()))).status).toBe(200);
      await settle();
      expect(mailsTo(u.email, /New sign-in/)).toHaveLength(1);
      // A wrong password from a new address is not a sign-in.
      const v = await signup("notice-wrong");
      await login(v.email, "not-the-password");
      await settle();
      expect(mailsTo(v.email, /New sign-in/)).toHaveLength(0);

      // Password change.
      const changeIp = ip();
      const changed = await req("POST", "/v1/auth/password/change", u.token, { currentPassword: u.password, newPassword: "a-changed-password-1" }, from(changeIp));
      expect(changed.status, changed.text).toBe(200);
      await waitForMail(u.email, /Your Scout password was changed/);
      const pw = mailsTo(u.email, /password was changed/)[0];
      expect(pw.text).toContain(`From: IP address ${changeIp} (approximate)`);
      expect(pw.text).not.toContain("a-changed-password-1");
      // A refused change mails nobody.
      const before = mocks.sent.length;
      expect((await req("POST", "/v1/auth/password/change", changed.body.token, { currentPassword: "wrong", newPassword: "another-password-12" })).status).toBe(403);
      await settle();
      expect(mocks.sent.length).toBe(before);

      // Password reset.
      expect((await req("POST", "/v1/auth/password/forgot", null, { email: u.email })).status).toBe(200);
      const token = mailsTo(u.email, /Reset your Scout password/)[0].text.match(/token=([\w-]+)/)![1];
      const reset = await req("POST", "/v1/auth/password/reset", null, { token, password: "a-reset-password-12" });
      expect(reset.status, reset.text).toBe(200);
      expect(reset.body.token).toBeTruthy();
      await waitForMail(u.email, /Your Scout password was reset/);
      expect(mailsTo(u.email, /password was reset/)[0].text).not.toContain(token);
    });

    it("sends nothing when the platform has no mailer, and never breaks the action when the mailer does", async () => {
      const u = await signup("notice-off");
      mailerOff();
      mocks.sent.length = 0;
      expect((await req("POST", "/v1/auth/api-keys", u.token, { name: "K" })).status).toBe(201);
      expect((await login(u.email, u.password)).status).toBe(200);
      const changed = await req("POST", "/v1/auth/password/change", u.token, { currentPassword: u.password, newPassword: "quiet-new-password-1" });
      expect(changed.status).toBe(200);
      const setup = await req("POST", "/v1/auth/2fa/setup", changed.body.token, { currentPassword: "quiet-new-password-1" });
      expect((await req("POST", "/v1/auth/2fa/enable", changed.body.token, { code: codeFor(setup.body.secret) })).status).toBe(200);
      expect(await M.notifySecurity(u, "password_changed", { ip: "203.0.113.1" })).toBe(false);
      await settle();
      expect(mocks.sent).toHaveLength(0);
      expect(M.securityMailAvailable()).toBe(false);

      // A mailer that fails or throws: the action still succeeds, and notifySecurity resolves.
      mailerOn();
      for (const mode of ["fail", "throw"] as const) {
        mocks.mode = mode;
        expect((await req("POST", "/v1/auth/api-keys", changed.body.token, { name: `K-${mode}` })).status).toBe(201);
        await expect(M.notifySecurity(u, "twofa_disabled", {})).resolves.toBe(false);
      }
      mocks.mode = "ok";
      // The admin notices go to the operator's address, at most one of a kind per hour.
      mocks.sent.length = 0;
      expect(await M.notifySecurity(null, "admin_new_signin", { ip: "203.0.113.2" })).toBe(true);
      expect(await M.notifySecurity(null, "admin_new_signin", { ip: "203.0.113.3" })).toBe(false);
      expect(mailsTo(ADMIN_EMAIL, /admin console: sign-in from a new address/)).toHaveLength(1);
      // No address to write to: nothing is sent, nothing throws.
      expect(await M.notifySecurity(null, "password_changed", {})).toBe(false);
      expect(await M.notifySecurity("not an address", "password_changed", {})).toBe(false);
    });
  });

  // ── 6. Abuse limits ──
  describe("abuse limits", () => {
    it("forgot password: the answer is always the same 200, but one address is mailed at most 3 times an hour", async () => {
      const u = await signup("forgot-throttle");
      mocks.sent.length = 0;
      /** Step past the once-a-minute rule without waiting: age the links issued so far by two minutes. */
      const age = () => db.update(S.passwordResetTokens).set({ createdAt: S.sql`created_at - interval '2 minutes'` }).where(S.eq(S.passwordResetTokens.userId, u.userId));
      for (let i = 0; i < 6; i++) {
        const r = await req("POST", "/v1/auth/password/forgot", null, { email: u.email });
        expect(r.status, `request ${i}`).toBe(200);
        expect(r.body).toEqual({ ok: true });
        await age();
      }
      expect(mailsTo(u.email, /Reset your Scout password/)).toHaveLength(3);
      expect(await db.select().from(S.passwordResetTokens).where(S.eq(S.passwordResetTokens.userId, u.userId))).toHaveLength(3);
      // Every link that WAS sent still works: the owner is not shut out by someone using the allowance up.
      const token = mailsTo(u.email, /Reset your Scout password/)[0].text.match(/token=([\w-]+)/)![1];
      expect((await req("POST", "/v1/auth/password/reset", null, { token, password: "after-throttle-password-1" })).status).toBe(200);
      // Once the hour has passed, mail goes again.
      await db.update(S.passwordResetTokens).set({ createdAt: S.sql`created_at - interval '61 minutes'` }).where(S.eq(S.passwordResetTokens.userId, u.userId));
      mocks.sent.length = 0;
      expect((await req("POST", "/v1/auth/password/forgot", null, { email: u.email })).status).toBe(200);
      expect(mailsTo(u.email, /Reset your Scout password/)).toHaveLength(1);
      // Another account is not affected by the first one's count.
      const v = await signup("forgot-throttle-other");
      await req("POST", "/v1/auth/password/forgot", null, { email: v.email });
      expect(mailsTo(v.email, /Reset your Scout password/)).toHaveLength(1);
    });

    it("signup: five new workspaces an hour from one address, twenty a day, then a readable 429", async () => {
      const addr = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
      R.resetWindows();
      const make = (headers: Record<string, string>) => req("POST", "/v1/auth/signup", undefined, { email: `bulk-${randomUUID().slice(0, 10)}@acct.example.com`, password: PASSWORD }, headers);
      for (let i = 0; i < 5; i++) expect((await make(from(addr))).status, `signup ${i}`).toBe(201);
      const sixth = await make(from(addr));
      expect(sixth.status).toBe(429);
      expect(sixth.body.error.code).toBe("rate_limited");
      expect(sixth.body.error.message).toBe("Too many new workspaces were created from your network in the last hour. Try again later, or write to contact@mnbresearch.com if you need more.");
      // Nothing was created for the refused request, and other addresses are not affected.
      expect((await make(from(ip()))).status).toBe(201);
      // A refused or invalid attempt does not use the allowance up.
      const other = `203.0.114.${1 + Math.floor(Math.random() * 250)}`;
      for (let i = 0; i < 4; i++) expect((await req("POST", "/v1/auth/signup", undefined, { email: "not-an-email", password: PASSWORD }, from(other))).status).toBe(400);
      expect((await make(from(other))).status).toBe(201);

      // The daily ceiling: twenty in a day, even when no single hour had more than five.
      const slow = `203.0.115.${1 + Math.floor(Math.random() * 250)}`;
      for (let i = 0; i < 20; i++) R.windowHit(`signup:d:${slow}`, 24 * 60 * 60 * 1000);
      const daily = await make(from(slow));
      expect(daily.status).toBe(429);
      expect(daily.body.error.message).toMatch(/created from your network today/);
      // IPv6: counted by network (/64), not by the half of the address a device rotates.
      const v6 = (host: string) => from(`2001:db8:abcd:${addr.split(".")[3]}::${host}`);
      for (let i = 0; i < 5; i++) expect((await make(v6(String(i + 1)))).status).toBe(201);
      expect((await make(v6("ffff"))).status).toBe(429);
      // With no usable client address there is nothing to count on, so nobody is refused.
      const { ipKey } = await import("./lib/loginGuard.js");
      expect(ipKey("unknown")).toBeNull();
      R.resetWindows();
    });
  });

  // ── 7. Admin: platform security view ──
  describe("admin security view", () => {
    it("the API description covers every new and changed endpoint", async () => {
      const r = await req("GET", "/openapi.json");
      expect(r.status).toBe(200);
      const paths = r.body.paths;
      const expected: [string, string][] = [
        ["/v1/auth/2fa/setup", "post"], ["/v1/auth/2fa/enable", "post"], ["/v1/auth/2fa/disable", "post"], ["/v1/auth/2fa/recovery-codes", "post"], ["/v1/auth/2fa/verify", "post"],
        ["/v1/auth/verify/confirm", "post"], ["/v1/auth/verify/resend", "post"], ["/v1/auth/me", "get"], ["/v1/auth/api-keys", "post"], ["/v1/auth/api-keys", "get"],
        ["/v1/auth/login", "post"], ["/v1/auth/signup", "post"], ["/v1/auth/password/reset", "post"], ["/v1/auth/password/change", "post"], ["/v1/auth/password/forgot", "post"],
        ["/v1/admin/login", "post"], ["/v1/admin/session", "get"], ["/v1/admin/audit-log", "get"], ["/v1/admin/security/summary", "get"], ["/v1/admin/orgs/{id}/users/{userId}/reset-2fa", "post"],
      ];
      for (const [p, m] of expected) expect(paths[p]?.[m], `${m} ${p}`).toBeTruthy();
      const body = (p: string, m: string) => paths[p][m].requestBody.content["application/json"].schema;
      const ok = (p: string, m: string, status = "200") => paths[p][m].responses[status].content["application/json"].schema;
      expect(body("/v1/auth/api-keys", "post").properties.scope.enum).toEqual(["full", "read"]);
      expect(Object.keys(body("/v1/admin/login", "post").properties)).toContain("code");
      expect(Object.keys(body("/v1/auth/password/change", "post").properties)).toContain("code");
      expect(Object.keys(body("/v1/auth/2fa/verify", "post").properties)).toEqual(["challenge", "code"]);
      expect(Object.keys(ok("/v1/auth/2fa/setup", "post").properties)).toEqual(["secret", "otpauthUrl"]);
      expect(Object.keys(ok("/v1/auth/2fa/enable", "post").properties)).toEqual(["ok", "recoveryCodes"]);
      expect(Object.keys(ok("/v1/admin/session", "get").properties)).toEqual(["ok", "totpEnabled"]);
      expect(Object.keys(ok("/v1/admin/security/summary", "get").properties)).toEqual(["window", "failedLogins", "lockedAccounts", "deniedActions", "adminLogins", "newWorkspaces", "exports", "bulkDeletes", "pendingDeletions", "topFailingIps"]);
      expect(Object.keys(ok("/v1/admin/audit-log", "get").properties.entries.items.properties)).toEqual(["id", "orgId", "orgName", "action", "actorType", "actorEmail", "targetType", "targetId", "result", "ip", "createdAt", "data"]);
      expect(paths["/v1/admin/audit-log"].get.parameters.map((x: any) => x.name)).toEqual(["orgId", "action", "result", "actorType", "limit", "before"]);
      expect(JSON.stringify(ok("/v1/auth/login", "post"))).toContain("twoFactorRequired");
      expect(JSON.stringify(ok("/v1/auth/password/reset", "post"))).toContain("twoFactorRequired");
      expect(Object.keys(ok("/v1/auth/me", "get").properties)).toContain("emailVerificationAvailable");
      expect(Object.keys(ok("/v1/auth/signup", "post", "201").properties)).toContain("verificationEmailSent");
      expect(r.body.info.description).toMatch(/read-only/);
    });

    it("is for the operator only", async () => {
      const u = await signup("adm-sec-auth");
      for (const path of ["/v1/admin/audit-log", "/v1/admin/security/summary"]) {
        expect((await req("GET", path)).status).toBe(401);
        expect((await req("GET", path, u.token)).status).toBe(401);
        expect((await req("GET", path, null, undefined, { "x-api-key": u.apiKey })).status).toBe(401);
      }
      expect((await admin("GET", "/audit-log")).status).toBe(200);
      expect((await admin("GET", "/session")).body).toEqual({ ok: true, totpEnabled: false });
    });

    it("audit log: every workspace, with names and actors joined in, filterable and paged", async () => {
      const a = await signup("adm-log-a");
      const b = await signup("adm-log-b");
      // Activity in A: a key, a failed sign-in, a good one. In B: a key.
      expect((await req("POST", "/v1/auth/api-keys", a.token, { name: "CI" })).status).toBe(201);
      await login(a.email, "not-the-password");
      await login(a.email, a.password);
      expect((await req("POST", "/v1/auth/api-keys", b.token, { name: "CI" })).status).toBe(201);

      const forA = await admin("GET", `/audit-log?orgId=${a.orgId}`);
      expect(forA.status, forA.text).toBe(200);
      const entries: any[] = forA.body.entries;
      expect(entries.length).toBeGreaterThanOrEqual(4);
      for (const e of entries) {
        expect(e.orgId).toBe(a.orgId);
        expect(e.orgName).toBe("adm-log-a Co");
        expect(Object.keys(e).sort()).toEqual(["action", "actorEmail", "actorType", "createdAt", "data", "id", "ip", "orgId", "orgName", "result", "targetId", "targetType"]);
      }
      // Newest first.
      const times = entries.map((e) => new Date(e.createdAt).getTime());
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      const key = entries.find((e) => e.action === "apikey.created");
      expect(key).toMatchObject({ actorType: "user", actorEmail: a.email, result: "ok", targetType: "api_key" });
      // The operator's own record: addresses are shown.
      expect(key.ip).toMatch(/^198\.51\./);
      expect(entries.find((e) => e.action === "auth.login" && e.result === "failed")).toMatchObject({ actorType: "anonymous", actorEmail: null });

      // Filters, alone and combined.
      const failed = await admin("GET", `/audit-log?orgId=${a.orgId}&result=failed`);
      expect(failed.body.entries.map((e: any) => e.action)).toEqual(["auth.login"]);
      const byAction = await admin("GET", `/audit-log?orgId=${a.orgId}&action=auth.login`);
      expect(byAction.body.entries).toHaveLength(2);
      expect(new Set(byAction.body.entries.map((e: any) => e.action))).toEqual(new Set(["auth.login"]));
      const byPrefix = await admin("GET", `/audit-log?orgId=${a.orgId}&action=${encodeURIComponent("auth.*")}`);
      // signup, the confirmation mail, and the two sign-ins.
      expect(byPrefix.body.entries.map((e: any) => e.action).sort()).toEqual(["auth.login", "auth.login", "auth.signup", "auth.verification_sent"]);
      expect(byPrefix.body.entries.every((e: any) => e.action.startsWith("auth."))).toBe(true);
      const anon = await admin("GET", `/audit-log?orgId=${a.orgId}&actorType=anonymous`);
      expect(anon.body.entries.every((e: any) => e.actorType === "anonymous")).toBe(true);
      expect(anon.body.entries).toHaveLength(1);
      // "%" and "_" in an action filter are characters, not wildcards.
      expect((await admin("GET", `/audit-log?orgId=${a.orgId}&action=${encodeURIComponent("%")}`)).body.entries).toHaveLength(0);
      expect((await admin("GET", `/audit-log?orgId=${a.orgId}&action=${encodeURIComponent("auth_login")}`)).body.entries).toHaveLength(0);
      // Across workspaces: the same action in both, each with its own workspace's name.
      const keys = await admin("GET", "/audit-log?action=apikey.created&limit=200");
      const orgNames = new Map(keys.body.entries.map((e: any) => [e.orgId, e.orgName]));
      expect(orgNames.get(a.orgId)).toBe("adm-log-a Co");
      expect(orgNames.get(b.orgId)).toBe("adm-log-b Co");
      // Empty filter values (as a form sends them) mean "no filter".
      const blank = await admin("GET", `/audit-log?orgId=${a.orgId}&action=&result=&actorType=&limit=&before=`);
      expect(blank.status, blank.text).toBe(200);
      expect(blank.body.entries.length).toBe(entries.length);
      // Bad values are a 400 that says which.
      expect((await admin("GET", "/audit-log?orgId=not-a-uuid")).status).toBe(400);
      expect((await admin("GET", "/audit-log?result=maybe")).status).toBe(400);
      expect((await admin("GET", "/audit-log?limit=201")).status).toBe(400);
      expect((await admin("GET", "/audit-log?before=yesterday")).status).toBe(400);

      // Paging: two at a time, no row twice, none missed.
      const seen: string[] = [];
      let before: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r: any = await admin("GET", `/audit-log?orgId=${a.orgId}&limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        expect(r.status).toBe(200);
        expect(r.body.entries.length).toBeLessThanOrEqual(2);
        seen.push(...r.body.entries.map((e: any) => e.id));
        if (!r.body.hasMore) {
          expect(r.body.nextBefore).toBeNull();
          break;
        }
        expect(r.body.nextBefore).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
        before = r.body.nextBefore;
      }
      expect(seen).toEqual(entries.map((e) => e.id));
      expect(new Set(seen).size).toBe(seen.length);

      // Rows that belong to no workspace (the admin form) are in this log and nowhere else.
      const { writeAudit } = await import("./lib/audit.js");
      const marker = `marker-${randomUUID()}`;
      await writeAudit({ action: "admin.login", orgId: null, actorType: "anonymous", result: "failed", ip: "203.0.113.77", data: { marker } });
      const adminRows = await admin("GET", "/audit-log?action=admin.login&result=failed&limit=200");
      const mine = adminRows.body.entries.find((e: any) => e.data?.marker === marker);
      expect(mine).toMatchObject({ orgId: null, orgName: null, actorEmail: null, ip: "203.0.113.77" });
    });

    it("security summary: the last 24 hours in numbers", async () => {
      const before = (await admin("GET", "/security/summary")).body;
      expect(before.window).toBe("24h");
      for (const k of ["failedLogins", "lockedAccounts", "deniedActions", "adminLogins", "newWorkspaces", "exports", "bulkDeletes", "pendingDeletions"]) {
        expect(typeof before[k], k).toBe("number");
        expect(Number.isInteger(before[k]), k).toBe(true);
      }
      expect(Array.isArray(before.topFailingIps)).toBe(true);

      // One of each, from a workspace made for the purpose.
      const u = await signup("adm-summary"); // +1 new workspace
      const guesser = `100.${64 + Math.floor(Math.random() * 60)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
      // Five wrong passwords from one address lock the account; the sixth is refused by the lock.
      for (let i = 0; i < 5; i++) expect((await login(u.email, `guess-${i}`, from(guesser))).status).toBe(401); // +5 failed
      expect((await login(u.email, u.password, from(guesser))).status).toBe(429); // +1 locked account, +1 denied
      const readKey = (await req("POST", "/v1/auth/api-keys", u.token, { name: "R", scope: "read" })).body.key;
      expect((await req("POST", "/v1/leads/lists", null, { name: "x" }, { "x-api-key": readKey })).status).toBe(403); // +1 denied
      expect((await req("GET", "/v1/leads/export.csv", u.token)).status).toBe(200); // +1 export
      expect((await req("POST", "/v1/leads/bulk/delete", u.token, { ids: [randomUUID()] })).status).toBe(200); // +1 bulk delete
      const { writeAudit } = await import("./lib/audit.js");
      await writeAudit({ action: "admin.login", orgId: null, actorType: "admin", result: "ok" }); // +1 admin login
      await writeAudit({ action: "account.exported", orgId: u.orgId, actorType: "user", actorUserId: u.userId, result: "ok" }); // +1 export
      const [deletion] = await db.insert(S.workspaceDeletionRequests).values({ orgId: u.orgId, requestedBy: u.userId, scheduledFor: new Date(Date.now() + 7 * 86_400_000) }).returning(); // +1 pending
      // An address that out-fails everything else in the table, so it must lead the list.
      const loud = `100.${64 + Math.floor(Math.random() * 60)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
      const loudSubject = `summary-test-${randomUUID()}@acct.example.com`;
      const top = Math.max(0, ...before.topFailingIps.map((r: any) => r.count)) + 500;
      await db.insert(S.loginAttempts).values(Array.from({ length: top }, () => ({ subject: loudSubject, ip: loud, succeeded: false })));
      // Wrong guesses at a signed-in user's own password are not sign-in attempts.
      await db.insert(S.loginAttempts).values(Array.from({ length: 3 }, () => ({ subject: `pwchange:${u.userId}`, ip: loud, succeeded: false })));

      try {
        const r = await admin("GET", "/security/summary");
        expect(r.status, r.text).toBe(200);
        const after = r.body;
        expect(Object.keys(after).sort()).toEqual(["adminLogins", "bulkDeletes", "deniedActions", "exports", "failedLogins", "lockedAccounts", "newWorkspaces", "pendingDeletions", "topFailingIps", "window"]);
        // Other test files write to the same tables while this runs, so each number is checked
        // as "at least what this test added" - and the ones only this test can move, exactly.
        // (Failed attempts are also DELETED by other files' clean-up, so this one is checked
        // against what this test wrote rather than against the earlier reading.)
        expect(after.failedLogins).toBeGreaterThanOrEqual(5 + top);
        expect(after.lockedAccounts).toBeGreaterThanOrEqual(before.lockedAccounts + 1);
        expect(after.deniedActions).toBeGreaterThanOrEqual(before.deniedActions + 2);
        expect(after.adminLogins).toBeGreaterThanOrEqual(before.adminLogins + 1);
        expect(after.newWorkspaces).toBeGreaterThanOrEqual(before.newWorkspaces + 1);
        expect(after.exports).toBeGreaterThanOrEqual(before.exports + 2);
        expect(after.bulkDeletes).toBeGreaterThanOrEqual(before.bulkDeletes + 1);
        expect(after.pendingDeletions).toBeGreaterThanOrEqual(before.pendingDeletions + 1);
        expect(after.topFailingIps.length).toBeLessThanOrEqual(5);
        // The pwchange rows for the same address are not in its count.
        expect(after.topFailingIps[0]).toEqual({ ip: loud, count: top });
        const counts = after.topFailingIps.map((x: any) => x.count);
        expect([...counts].sort((x: number, y: number) => y - x)).toEqual(counts);

        // The same pending deletion shows on the workspace's row in the admin list, and goes
        // when the request is cancelled.
        const listed = await admin("GET", `/orgs?q=${encodeURIComponent(u.email)}`);
        const row = listed.body.orgs.find((o: any) => o.id === u.orgId);
        expect(new Date(row.pendingDeletionAt).getTime()).toBe(deletion.scheduledFor.getTime());
        expect(new Date((await admin("GET", `/orgs/${u.orgId}`)).body.org.pendingDeletionAt).getTime()).toBe(deletion.scheduledFor.getTime());
        const quiet = await signup("adm-summary-quiet");
        expect((await admin("GET", `/orgs?q=${encodeURIComponent(quiet.email)}`)).body.orgs[0].pendingDeletionAt).toBeNull();
        await db.update(S.workspaceDeletionRequests).set({ cancelledAt: new Date() }).where(S.eq(S.workspaceDeletionRequests.id, deletion.id));
        expect((await admin("GET", `/orgs?q=${encodeURIComponent(u.email)}`)).body.orgs.find((o: any) => o.id === u.orgId).pendingDeletionAt).toBeNull();
        expect((await admin("GET", `/orgs/${u.orgId}`)).body.org.pendingDeletionAt).toBeNull();
      } finally {
        await db.delete(S.loginAttempts).where(S.eq(S.loginAttempts.subject, loudSubject));
        await db.delete(S.workspaceDeletionRequests).where(S.eq(S.workspaceDeletionRequests.id, deletion.id));
      }
    });
  });
});
