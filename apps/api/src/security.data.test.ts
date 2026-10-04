/**
 * Data-protection regressions: what is stored about links and credentials, what a workspace
 * can take out (export) and how it is removed (deletion).
 *
 *  - invite links and client report links are stored as hashes, not as working links;
 *  - stored credentials only open for the workspace that saved them;
 *  - "Export all data" is owner-only, re-confirmed, streamed, and carries no secret;
 *  - "Delete workspace" is owner-only, re-confirmed, has a grace period, pauses campaigns,
 *    and the purge removes every row of that workspace and none of another's.
 *
 * Through the real app (createApp) and a real database, in its own Postgres schema
 * (`sec_data`) when the database allows one - the purge and the link migration act on
 * whole tables, and another test file draining the shared job queue must not race them.
 * `fetch` is stubbed and mail is captured: nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "sec_data";

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
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "CREDENTIAL_REBIND_ON_READ"]) delete process.env[k];
}

const mocks = vi.hoisted(() => ({
  sent: [] as { to: string; from: string; subject: string; text: string }[],
  /** When true the platform "has" a mail provider, so email verification is available. */
  platformMailer: false,
}));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    systemMailerConfig: () => (mocks.platformMailer ? { provider: "resend" as const, resendApiKey: "re_test_platform_key" } : orig.systemMailerConfig()),
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; from: string; subject: string; text: string }) => {
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}` };
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] ${JSON.stringify("data protection")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests for hashed link tokens, workspace-bound credentials, workspace export and workspace deletion.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("data protection: link tokens, credentials, export, deletion", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db
  let crypto: typeof import("./lib/crypto.js");
  let creds: typeof import("./lib/credentials.js");
  let links: typeof import("./lib/linkTokens.js");
  let rateWindow: typeof import("./lib/rateWindow.js");
  let env: any;

  const PASSWORD = "correct-horse-battery";
  type Org = { token: string; orgId: string; orgName: string; userId: string; email: string; apiKey: string };

  const u8 = () => randomUUID().slice(0, 8);
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  const rows = (r: any): any[] => (Array.isArray(r) ? [...r] : (r?.rows ?? []));
  const q = async (strings: TemplateStringsArray, ...values: unknown[]) => rows(await db.execute(S.sql(strings, ...values)));
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const realFetch = globalThis.fetch;

  async function raw(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const auth = token ? (token.startsWith("px_") ? { "x-api-key": token } : { authorization: `Bearer ${token}` }) : {};
    return app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function req(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const res = await raw(method, path, token, body, headers);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, headers: res.headers as Headers };
  }

  async function signup(name: string): Promise<Org> {
    const email = `${name}-${u8()}@example.com`;
    const orgName = `${name} ${u8()}`;
    const r = await req("POST", "/v1/auth/signup", null, { email, password: PASSWORD, orgName });
    expect(r.status).toBe(201);
    const orgId = r.body.org.id as string;
    // Roomy limits, so a quota or the seat limit never stands in for the behaviour under test.
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale") }).where(S.eq(S.organizations.id, orgId));
    return { token: r.body.token, orgId, orgName, userId: r.body.user.id, email, apiKey: r.body.apiKey };
  }
  /** A second person in the workspace, through the real invite + join flow. */
  async function addMember(o: Org, role: "member" | "admin") {
    const email = `${role}-${u8()}@example.com`;
    const inv = await req("POST", "/v1/tools/team/invite", o.token, { email, role });
    expect(inv.status).toBe(201);
    const join = await req("POST", "/v1/auth/join", null, { token: new URL(inv.body.link).searchParams.get("token"), password: "member-password-1", name: role });
    expect(join.status).toBe(200);
    return { token: join.body.token as string, id: join.body.user.id as string, email };
  }
  const auditOf = async (orgId: string, action: string) => (await db.select().from(S.auditLog).where(S.eq(S.auditLog.orgId, orgId))).filter((r: any) => r.action === action);
  const inviteRow = async (id: string) => (await db.select().from(S.invites).where(S.eq(S.invites.id, id)))[0];
  const clientRow = async (id: string) => (await db.select().from(S.clients).where(S.eq(S.clients.id, id)))[0];
  const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
  async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("condition not reached in time");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  /** A blob in the format used before v2: sha256 key, no key id, no binding. */
  function legacyBlob(plain: string): string {
    const key = createHash("sha256").update(env.encryptionKey || env.jwtSecret).digest();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
  }

  beforeAll(async () => {
    try {
      const { default: postgres } = await import("postgres");
      const admin = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
      await admin.end({ timeout: 2 });
      process.env.DATABASE_URL = `${TEST_DB}${TEST_DB!.includes("?") ? "&" : "?"}search_path=${SCHEMA}`;
    } catch {
      process.env.DATABASE_URL = TEST_DB;
    }
    vi.stubGlobal("fetch", (async () => {
      throw new Error("security.data: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    crypto = await import("./lib/crypto.js");
    creds = await import("./lib/credentials.js");
    links = await import("./lib/linkTokens.js");
    rateWindow = await import("./lib/rateWindow.js");
    ({ env } = await import("./env.js"));
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    mocks.sent.length = 0;
    mocks.platformMailer = false;
    delete process.env.CREDENTIAL_REBIND_ON_READ;
    rateWindow.resetWindows();
  });

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  // ── 1. Invite links ────────────────────────────────────────────────────────────────
  describe("invite links are stored as a hash", () => {
    it("a new invite stores only the hash of its token, and the link still joins", async () => {
      const o = await signup("inv-new");
      const email = `new-${u8()}@example.com`;
      const inv = await req("POST", "/v1/tools/team/invite", o.token, { email, role: "member" });
      expect(inv.status).toBe(201);
      const token = tokenOf(inv.body.link);
      expect(token.length).toBeGreaterThanOrEqual(24);

      const row = await inviteRow(inv.body.id);
      expect(row.token).toBeNull();
      expect(row.tokenHash).toBe(sha256(token));
      // Nothing in the stored row is the link, or can be turned back into it.
      expect(JSON.stringify(row)).not.toContain(token);
      // The creation audit row does not carry it either.
      expect(JSON.stringify(await auditOf(o.orgId, "team.invited"))).not.toContain(token);

      // The hash is not accepted in place of the token.
      expect((await req("POST", "/v1/auth/join", null, { token: row.tokenHash, password: "member-password-1" })).status).toBe(400);
      const join = await req("POST", "/v1/auth/join", null, { token, password: "member-password-1", name: "New" });
      expect(join.status).toBe(200);
      expect(join.body.user.email).toBe(email);
      // Single use.
      expect((await req("POST", "/v1/auth/join", null, { token, password: "member-password-1" })).body.error.code).toBe("invalid_invite");
    });

    it("an invite from before hashing (plaintext token) still joins - with its backfilled hash, and without one", async () => {
      const o = await signup("inv-old");
      for (const backfilled of [true, false]) {
        const token = randomBytes(24).toString("base64url");
        const email = `legacy-${u8()}@example.com`;
        // What the previous release wrote; the migration backfills token_hash for rows that
        // exist when it runs, and a row written after it (old code still running) has none.
        await db.insert(S.invites).values({ orgId: o.orgId, email, role: "member", token, tokenHash: backfilled ? sha256(token) : null, invitedBy: o.userId, expiresAt: new Date(Date.now() + 86_400_000) });
        const join = await req("POST", "/v1/auth/join", null, { token, password: "member-password-1", name: "Legacy" });
        expect({ backfilled, status: join.status }).toEqual({ backfilled, status: 200 });
        expect(join.body.user.email).toBe(email);
      }
    });

    it("re-sending issues a new link and the old one stops working", async () => {
      const o = await signup("inv-resend");
      const email = `again-${u8()}@example.com`;
      const inv = await req("POST", "/v1/tools/team/invite", o.token, { email, role: "member" });
      const first = tokenOf(inv.body.link);
      const again = await req("POST", `/v1/tools/team/invites/${inv.body.id}/resend`, o.token, {});
      expect(again.status).toBe(200);
      const second = tokenOf(again.body.link);
      expect(second).not.toBe(first);
      const row = await inviteRow(inv.body.id);
      expect([row.token, row.tokenHash]).toEqual([null, sha256(second)]);
      // The emailed link is the new one.
      expect(mocks.sent.filter((m) => m.to === email).at(-1)!.text).toContain(second);

      expect((await req("POST", "/v1/auth/join", null, { token: first, password: "member-password-1" })).body.error.code).toBe("invalid_invite");
      expect((await req("POST", "/v1/auth/join", null, { token: second, password: "member-password-1" })).status).toBe(200);

      // A legacy plaintext invite that is re-sent loses its plaintext token too.
      const legacy = randomBytes(24).toString("base64url");
      const [old] = await db.insert(S.invites).values({ orgId: o.orgId, email: `old-${u8()}@example.com`, role: "member", token: legacy, tokenHash: sha256(legacy), invitedBy: o.userId, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
      const re = await req("POST", `/v1/tools/invites/${old.id}/resend`, o.token, {});
      expect(re.status).toBe(200);
      expect((await inviteRow(old.id)).token).toBeNull();
      expect((await req("POST", "/v1/auth/join", null, { token: legacy, password: "member-password-1" })).status).toBe(400);
    });

    it("the pending-invite list carries no link, token or hash", async () => {
      const o = await signup("inv-list");
      const inv = await req("POST", "/v1/tools/team/invite", o.token, { email: `p-${u8()}@example.com`, role: "admin" });
      const legacy = randomBytes(24).toString("base64url");
      await db.insert(S.invites).values({ orgId: o.orgId, email: `q-${u8()}@example.com`, role: "member", token: legacy, tokenHash: sha256(legacy), invitedBy: o.userId, expiresAt: new Date(Date.now() + 86_400_000) });
      const team = await req("GET", "/v1/tools/team", o.token);
      expect(team.status).toBe(200);
      expect(team.body.invites).toHaveLength(2);
      for (const i of team.body.invites) expect(Object.keys(i).sort()).toEqual(["createdAt", "email", "expired", "expiresAt", "id", "invitedBy", "role"]);
      for (const secret of [tokenOf(inv.body.link), sha256(tokenOf(inv.body.link)), legacy, sha256(legacy), "/join?token="]) expect(team.text).not.toContain(secret);
    });
  });

  // ── 2. Client report links ─────────────────────────────────────────────────────────
  describe("client report links are stored hashed and encrypted", () => {
    const newClient = async (o: Org, name = `Client ${u8()}`) => (await req("POST", "/v1/clients", o.token, { name })).body;
    const report = (token: string) => req("GET", `/v1/public/clients/report/${token}`);

    it("turning sharing on stores a hash and an encrypted copy, never the token; rotating replaces both", async () => {
      const o = await signup("share-new");
      const c = await newClient(o);
      const on = await req("POST", `/v1/clients/${c.id}/share`, o.token, {});
      expect(on.status).toBe(200);
      const token = on.body.shareToken as string;
      expect(Buffer.from(token, "base64url")).toHaveLength(32);

      const row = await clientRow(c.id);
      expect(row.shareToken).toBeNull();
      expect(row.shareTokenHash).toBe(sha256(token));
      expect(row.shareTokenEncrypted).toMatch(/^v2\./);
      // A dump of the row holds no usable link: a hash, and a ciphertext that needs the server's key.
      expect(JSON.stringify(row)).not.toContain(token);
      expect(links.openShareToken(o.orgId, c.id, row.shareTokenEncrypted)).toBe(token);
      expect(() => crypto.decrypt(row.shareTokenEncrypted)).toThrow();

      const pub = await report(token);
      expect(pub.status).toBe(200);
      expect(pub.body.client.name).toBe(c.name);
      // The hash is not the credential.
      expect((await report(row.shareTokenHash)).status).toBe(404);

      const rotated = await req("POST", `/v1/clients/${c.id}/share`, o.token, {});
      expect(rotated.body.shareToken).not.toBe(token);
      expect((await report(token)).status).toBe(404);
      expect((await report(rotated.body.shareToken)).status).toBe(200);
      expect((await auditOf(o.orgId, "client.share_rotated")).length).toBe(1);
      expect(JSON.stringify(await db.select().from(S.auditLog).where(S.eq(S.auditLog.orgId, o.orgId)))).not.toContain(rotated.body.shareToken);
    });

    it("owners and admins get the link back; a member is told sharing is on and gets no link; no list carries it", async () => {
      const o = await signup("share-roles");
      const member = await addMember(o, "member");
      const admin = await addMember(o, "admin");
      const c = await newClient(o);
      const token = (await req("POST", `/v1/clients/${c.id}/share`, o.token, {})).body.shareToken as string;
      const hash = sha256(token);
      const enc = (await clientRow(c.id)).shareTokenEncrypted as string;

      for (const who of [o.token, admin.token, o.apiKey]) {
        const d = await req("GET", `/v1/clients/${c.id}`, who);
        expect(d.status).toBe(200);
        expect(d.body.client).toMatchObject({ sharing: true, shareToken: token, shareLinkVisible: true });
        expect(d.text).not.toContain(hash);
        expect(d.text).not.toContain(enc);
      }
      const m = await req("GET", `/v1/clients/${c.id}`, member.token);
      expect(m.status).toBe(200);
      expect(m.body.client).toMatchObject({ sharing: true, shareToken: null, shareLinkVisible: false });
      for (const secret of [token, hash, enc]) expect(m.text).not.toContain(secret);

      // The overview, and every other response that returns a client, for anyone.
      for (const who of [o.token, admin.token, member.token, o.apiKey]) {
        const list = await req("GET", "/v1/clients?includeArchived=true", who);
        expect(list.status).toBe(200);
        expect(list.body.clients.find((x: any) => x.id === c.id).sharing).toBe(true);
        for (const secret of [token, hash, enc, "shareToken"]) expect(list.text).not.toContain(secret);
      }
      const patched = await req("PATCH", `/v1/clients/${c.id}`, o.token, { notes: "x" });
      expect(patched.status).toBe(200);
      for (const secret of [token, hash, enc, "shareToken"]) expect(patched.text).not.toContain(secret);
    });

    it("a legacy plaintext link keeps resolving, is moved out of plaintext when an owner reads it, and by the boot-time task", async () => {
      const o = await signup("share-legacy");
      const member = await addMember(o, "member");
      // (a) backfilled by the migration, (b) written by the previous release after it (no hash).
      const tA = randomBytes(32).toString("base64url");
      const tB = randomBytes(32).toString("base64url");
      const tC = randomBytes(32).toString("base64url");
      const [a] = await db.insert(S.clients).values({ orgId: o.orgId, name: `Legacy A ${u8()}`, shareToken: tA, shareTokenHash: sha256(tA) }).returning();
      const [b] = await db.insert(S.clients).values({ orgId: o.orgId, name: `Legacy B ${u8()}`, shareToken: tB }).returning();
      const [c] = await db.insert(S.clients).values({ orgId: o.orgId, name: `Legacy C ${u8()}`, shareToken: tC, shareTokenHash: sha256(tC) }).returning();
      for (const t of [tA, tB, tC]) expect((await report(t)).status).toBe(200);

      // A member reading the client changes nothing and learns nothing.
      const m = await req("GET", `/v1/clients/${a.id}`, member.token);
      expect(m.body.client).toMatchObject({ sharing: true, shareToken: null });
      expect((await clientRow(a.id)).shareToken).toBe(tA);

      // An owner gets the same link as before, and the row is re-encrypted on the way.
      const d = await req("GET", `/v1/clients/${a.id}`, o.token);
      expect(d.body.client.shareToken).toBe(tA);
      const moved = await clientRow(a.id);
      expect([moved.shareToken, moved.shareTokenHash]).toEqual([null, sha256(tA)]);
      expect(links.openShareToken(o.orgId, a.id, moved.shareTokenEncrypted)).toBe(tA);
      expect((await req("GET", `/v1/clients/${a.id}`, o.token)).body.client.shareToken).toBe(tA);

      // The boot-time task finishes the rest - twice at once, as two instances starting together would.
      const [r1, r2] = await Promise.all([links.migrateLegacyLinkTokens({ batchSize: 1 }), links.migrateLegacyLinkTokens()]);
      expect(r1.clientLinks + r2.clientLinks).toBeGreaterThanOrEqual(2);
      for (const [row, t] of [[b, tB], [c, tC]] as const) {
        const after = await clientRow(row.id);
        expect([after.shareToken, after.shareTokenHash]).toEqual([null, sha256(t)]);
        expect(links.openShareToken(o.orgId, row.id, after.shareTokenEncrypted)).toBe(t);
        expect(JSON.stringify(after)).not.toContain(t);
        expect((await report(t)).status).toBe(200);
      }
      // Nothing left in plaintext anywhere, and running it again changes nothing.
      expect(await q`SELECT count(*)::int AS n FROM clients WHERE share_token IS NOT NULL`).toEqual([{ n: 0 }]);
      expect(await links.migrateLegacyLinkTokens()).toEqual({ clientLinks: 0, inviteHashes: 0 });
      expect((await req("GET", `/v1/clients/${b.id}`, o.token)).body.client.shareToken).toBe(tB);
    });

    it("the boot-time task gives a hash to an invite that has only a plaintext token", async () => {
      const o = await signup("share-invhash");
      const token = randomBytes(24).toString("base64url");
      const [inv] = await db.insert(S.invites).values({ orgId: o.orgId, email: `nohash-${u8()}@example.com`, role: "member", token, invitedBy: o.userId, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
      expect((await links.migrateLegacyLinkTokens()).inviteHashes).toBeGreaterThanOrEqual(1);
      expect((await inviteRow(inv.id)).tokenHash).toBe(sha256(token));
    });

    it("turning sharing off clears all three columns, and the link is dead", async () => {
      const o = await signup("share-off");
      const c = await newClient(o);
      const token = (await req("POST", `/v1/clients/${c.id}/share`, o.token, {})).body.shareToken as string;
      // A row that somehow still has the legacy column as well.
      await db.update(S.clients).set({ shareToken: token }).where(S.eq(S.clients.id, c.id));
      expect((await req("DELETE", `/v1/clients/${c.id}/share`, o.token)).status).toBe(200);
      const row = await clientRow(c.id);
      expect([row.shareToken, row.shareTokenHash, row.shareTokenEncrypted]).toEqual([null, null, null]);
      expect((await report(token)).status).toBe(404);
      expect((await req("GET", `/v1/clients/${c.id}`, o.token)).body.client).toMatchObject({ sharing: false, shareToken: null });
    });

    it("an encrypted link copied onto another client's row does not open there, and says so instead of showing nothing", async () => {
      const a = await signup("share-copy-a");
      const b = await signup("share-copy-b");
      const ca = await newClient(a);
      const cb = await newClient(b);
      const token = (await req("POST", `/v1/clients/${ca.id}/share`, a.token, {})).body.shareToken as string;
      await req("POST", `/v1/clients/${cb.id}/share`, b.token, {});
      const stolen = (await clientRow(ca.id)).shareTokenEncrypted;
      await db.update(S.clients).set({ shareTokenEncrypted: stolen }).where(S.eq(S.clients.id, cb.id));
      const d = await req("GET", `/v1/clients/${cb.id}`, b.token);
      expect(d.status).toBe(200);
      expect(d.body.client.shareToken).toBeNull();
      expect(d.body.client.sharing).toBe(true);
      expect(d.body.client.shareLinkError).toMatch(/can no longer be displayed/);
      expect(d.text).not.toContain(token);
    });
  });

  // ── 3. Credentials are bound to their workspace ────────────────────────────────────
  describe("stored credentials open only for the workspace that saved them", () => {
    const RESEND_KEY = "re_live_SenderKey_0123456789abcdef";
    const account = async (orgId: string, patch: Record<string, unknown> = {}) =>
      (await db.insert(S.emailAccounts).values({ orgId, provider: "resend", fromName: "Asha", fromEmail: `asha-${u8()}@tenantco.example`, ...patch }).returning())[0];
    const accountRow = async (id: string) => (await db.select().from(S.emailAccounts).where(S.eq(S.emailAccounts.id, id)))[0];

    it("sealOrgSecret / openOrgSecret: bound to workspace and kind; legacy and unbound blobs still open", () => {
      const orgA = randomUUID();
      const orgB = randomUUID();
      const blob = creds.sealOrgSecret(orgA, "email-account", "s3cret");
      expect(creds.openOrgSecret(orgA, "email-account", blob)).toBe("s3cret");
      expect(() => creds.openOrgSecret(orgB, "email-account", blob)).toThrow(crypto.CredentialUnreadableError);
      expect(() => creds.openOrgSecret(orgA, "integration", blob)).toThrow(crypto.CredentialUnreadableError);
      expect(() => creds.openOrgSecret(orgA, "webhook-secret", blob)).toThrow(crypto.CredentialUnreadableError);
      // No binding at all does not open it either.
      expect(() => crypto.decrypt(blob)).toThrow(crypto.CredentialUnreadableError);
      expect(creds.isUnboundSecret(blob)).toBe(false);
      expect(() => creds.sealOrgSecret("", "email-account", "x")).toThrow();

      // Written before credentials were bound: the 3-part legacy format and an unbound v2 blob.
      for (const old of [legacyBlob("old-secret"), crypto.encrypt("old-secret")]) {
        expect(creds.openOrgSecret(orgA, "email-account", old)).toBe("old-secret");
        expect(creds.openOrgSecret(orgB, "integration", old)).toBe("old-secret");
        expect(creds.isUnboundSecret(old)).toBe(true);
      }
      expect(creds.openOrgJson(orgA, "integration", legacyBlob('{"accessToken":"t"}'))).toEqual({ accessToken: "t" });
      expect(creds.openOrgJson(orgA, "integration", null)).toBeNull();
      expect(() => creds.openOrgJson(orgA, "integration", creds.sealOrgSecret(orgA, "integration", "not json"))).toThrow(crypto.CredentialUnreadableError);
      expect(() => creds.openOrgJson(orgA, "integration", "not-a-ciphertext")).toThrow(crypto.CredentialUnreadableError);
    });

    it("a sender saved through the API is bound: copied onto another workspace's sender it is unreadable there", async () => {
      const a = await signup("cred-a");
      const b = await signup("cred-b");
      const made = await req("POST", "/v1/campaigns/email-accounts", a.token, { provider: "resend", fromName: "Asha", fromEmail: `asha@${u8()}.example`, config: { apiKey: RESEND_KEY } });
      expect(made.status).toBe(201);
      expect(made.text).not.toContain(RESEND_KEY);
      const rowA = await accountRow(made.body.emailAccount.id);
      expect(rowA.configEncrypted).not.toContain(RESEND_KEY);
      expect(creds.isUnboundSecret(rowA.configEncrypted)).toBe(false);
      expect(creds.openOrgJson(a.orgId, "email-account", rowA.configEncrypted)).toEqual({ apiKey: RESEND_KEY });

      const { resolveMailer } = await import("./services/campaigns.js");
      expect(resolveMailer(rowA)).toEqual({ ok: true, mailer: { provider: "resend", resendApiKey: RESEND_KEY } });

      // The same bytes on workspace B's row.
      const rowB = await account(b.orgId, { configEncrypted: rowA.configEncrypted });
      expect(resolveMailer(rowB)).toEqual({ ok: false, reason: "unreadable" });
      const retest = await req("POST", `/v1/campaigns/email-accounts/${rowB.id}/retest`, b.token, {});
      expect(retest.status).toBe(409);
      expect(retest.body.error.code).toBe("credential_unreadable");
      expect(retest.text).not.toContain(RESEND_KEY);
      // ... and it was not "upgraded" into B's name on the way.
      expect((await accountRow(rowB.id)).configEncrypted).toBe(rowA.configEncrypted);
    });

    it("credentials saved before the binding still work, and are rewritten bound the first time they are read", async () => {
      const a = await signup("cred-lazy");
      const { resolveMailer } = await import("./services/campaigns.js");
      for (const old of [legacyBlob(JSON.stringify({ apiKey: RESEND_KEY })), crypto.encryptJson({ apiKey: RESEND_KEY })]) {
        const row = await account(a.orgId, { configEncrypted: old });
        expect(resolveMailer(row)).toEqual({ ok: true, mailer: { provider: "resend", resendApiKey: RESEND_KEY } });
        const after = await until(async () => {
          const r = await accountRow(row.id);
          return r.configEncrypted !== old ? r : null;
        });
        expect(creds.isUnboundSecret(after.configEncrypted)).toBe(false);
        expect(creds.openOrgJson(a.orgId, "email-account", after.configEncrypted)).toEqual({ apiKey: RESEND_KEY });
        expect(() => creds.openOrgJson(randomUUID(), "email-account", after.configEncrypted)).toThrow(crypto.CredentialUnreadableError);
        expect(resolveMailer(after)).toEqual({ ok: true, mailer: { provider: "resend", resendApiKey: RESEND_KEY } });
        // Already bound: nothing more to do.
        expect(await creds.rebindOnRead(a.orgId, "email-account", after.id, after.configEncrypted, JSON.stringify({ apiKey: RESEND_KEY }))).toBe(false);
      }
    });

    it("the lazy upgrade only writes while the row still holds what was read, and can be switched off", async () => {
      const a = await signup("cred-guard");
      const old = crypto.encryptJson({ apiKey: RESEND_KEY });
      const row = await account(a.orgId, { configEncrypted: old });
      // The customer saved a new credential in between: the stale read must not overwrite it.
      const newer = creds.sealOrgJson(a.orgId, "email-account", { apiKey: "re_newer" });
      await db.update(S.emailAccounts).set({ configEncrypted: newer }).where(S.eq(S.emailAccounts.id, row.id));
      expect(await creds.rebindOnRead(a.orgId, "email-account", row.id, old, JSON.stringify({ apiKey: RESEND_KEY }))).toBe(false);
      expect((await accountRow(row.id)).configEncrypted).toBe(newer);
      // Another workspace's id never matches the row.
      const other = await account(a.orgId, { configEncrypted: old });
      expect(await creds.rebindOnRead(randomUUID(), "email-account", other.id, old, "{}")).toBe(false);

      process.env.CREDENTIAL_REBIND_ON_READ = "false";
      expect(await creds.rebindOnRead(a.orgId, "email-account", other.id, old, JSON.stringify({ apiKey: RESEND_KEY }))).toBe(false);
      expect((await accountRow(other.id)).configEncrypted).toBe(old);
      delete process.env.CREDENTIAL_REBIND_ON_READ;
      expect(await creds.rebindOnRead(a.orgId, "email-account", other.id, old, JSON.stringify({ apiKey: RESEND_KEY }))).toBe(true);
      expect(creds.isUnboundSecret((await accountRow(other.id)).configEncrypted)).toBe(false);
    });

    it("an integration's credentials are bound: copied to another workspace's connection, the sync refuses in words", async () => {
      const a = await signup("cred-int-a");
      const b = await signup("cred-int-b");
      const TOKEN = `crm-secret-token-${u8()}${u8()}`;
      const put = await req("PUT", "/v1/integrations/hubspot", a.token, { config: { accessToken: TOKEN } });
      expect(put.status).toBe(200);
      expect(put.text).not.toContain(TOKEN);
      const [ia] = await db.select().from(S.integrations).where(S.eq(S.integrations.orgId, a.orgId));
      expect(creds.isUnboundSecret(ia.configEncrypted)).toBe(false);
      expect(creds.openOrgJson(a.orgId, "integration", ia.configEncrypted)).toEqual({ accessToken: TOKEN });
      // Saving again (the upsert path) stays bound.
      await req("PUT", "/v1/integrations/hubspot", a.token, { config: { accessToken: TOKEN } });
      const [ia2] = await db.select().from(S.integrations).where(S.eq(S.integrations.orgId, a.orgId));
      expect(creds.isUnboundSecret(ia2.configEncrypted)).toBe(false);
      expect(JSON.stringify((await req("GET", "/v1/integrations", a.token)).body)).not.toContain("configEncrypted");

      const [ib] = await db.insert(S.integrations).values({ orgId: b.orgId, provider: "hubspot", configEncrypted: ia2.configEncrypted, status: "active" }).returning();
      const [leadB] = await db.insert(S.leads).values({ orgId: b.orgId, fullName: "B Lead", email: `b-${u8()}@example.com` }).returning();
      const { syncLead } = await import("./services/integrations.js");
      const r = await syncLead(ib, leadB.id);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/saved credentials could not be read/);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      // The email-account kind does not open an integration's blob, even in the same workspace.
      expect(() => creds.openOrgJson(a.orgId, "email-account", ia2.configEncrypted)).toThrow(crypto.CredentialUnreadableError);
    });

    it("a webhook signing secret is bound; an older unbound one still signs and is upgraded by a delivery", async () => {
      const a = await signup("cred-hook-a");
      const b = await signup("cred-hook-b");
      const { webhookSecret, secretPreview } = await import("./lib/webhookSecret.js");
      const made = await req("POST", "/v1/webhooks", a.token, { url: "https://hooks.customer-site.com/in", events: ["*"] });
      expect(made.status).toBe(201);
      const [ha] = await db.select().from(S.webhooks).where(S.eq(S.webhooks.id, made.body.id));
      expect(ha.secret).toBeNull();
      expect(creds.isUnboundSecret(ha.secretEncrypted)).toBe(false);
      expect(webhookSecret(ha)).toBe(made.body.secret);

      const [hb] = await db.insert(S.webhooks).values({ orgId: b.orgId, url: "https://hooks.other-site.com/in", events: ["*"], secret: null, secretEncrypted: ha.secretEncrypted, signatureVersion: 2 }).returning();
      expect(() => webhookSecret(hb)).toThrow(/no usable signing secret/);
      expect(secretPreview(hb)).toBe("");

      // Rotation re-seals for the hook's own workspace.
      const rot = await req("POST", `/v1/webhooks/${made.body.id}/rotate-secret`, a.token, {});
      const [ha2] = await db.select().from(S.webhooks).where(S.eq(S.webhooks.id, made.body.id));
      expect(webhookSecret(ha2)).toBe(rot.body.secret);
      expect(creds.isUnboundSecret(ha2.secretEncrypted)).toBe(false);

      // A secret encrypted before the binding: still usable, upgraded when the delivery job reads it.
      const old = crypto.encrypt("whsec_old_unbound_secret_0123456789");
      const [legacy] = await db.insert(S.webhooks).values({ orgId: a.orgId, url: "https://hooks.customer-site.com/legacy", events: ["*"], secret: null, secretEncrypted: old, signatureVersion: 2 }).returning();
      expect(webhookSecret(legacy)).toBe("whsec_old_unbound_secret_0123456789");
      expect((await db.select().from(S.webhooks).where(S.eq(S.webhooks.id, legacy.id)))[0].secretEncrypted).toBe(old);
      expect(webhookSecret(legacy, { upgrade: true })).toBe("whsec_old_unbound_secret_0123456789");
      const up = await until(async () => {
        const [r] = await db.select().from(S.webhooks).where(S.eq(S.webhooks.id, legacy.id));
        return r.secretEncrypted !== old ? r : null;
      });
      expect(creds.isUnboundSecret(up.secretEncrypted)).toBe(false);
      expect(webhookSecret(up)).toBe("whsec_old_unbound_secret_0123456789");
    });
  });

  // ── 4. Things a list or an event must not carry ────────────────────────────────────
  describe("no token in a list or an event", () => {
    it("a campaign's message list has no tracking token", async () => {
      const o = await signup("lists");
      const [cp] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "C" }).returning();
      const tracking = `trk_${u8()}${u8()}${u8()}`;
      await db.insert(S.messages).values({ orgId: o.orgId, campaignId: cp.id, toEmail: "p@example.com", subject: "Hi", bodyText: "Hello", trackingToken: tracking, status: "sent" });
      const r = await req("GET", `/v1/campaigns/${cp.id}/messages`, o.token);
      expect(r.status).toBe(200);
      expect(r.body.messages).toHaveLength(1);
      expect(r.text).not.toContain(tracking);
      expect(r.text).not.toContain("trackingToken");
    });

    it("the webhook.disabled event names the hook's origin, not an address that may itself be a credential", async () => {
      const o = await signup("hook-ev");
      const SECRET_PATH = `T0${u8()}/B0${u8()}/${u8()}${u8()}`;
      const [hook] = await db.insert(S.webhooks).values({ orgId: o.orgId, url: `https://user:pa55w0rd@hooks.customer-site.com/services/${SECRET_PATH}?token=qs-${u8()}`, events: ["*"], secret: "legacy-secret", failures: 9 }).returning();
      const [ev] = await db.insert(S.events).values({ orgId: o.orgId, type: "lead.created", data: {} }).returning();
      vi.stubGlobal("fetch", (async () => new Response("no", { status: 500 })) as typeof fetch);
      try {
        const { handlers } = await import("./jobs.js");
        const job = { id: randomUUID(), orgId: o.orgId, type: "webhook.deliver", payload: { webhookId: hook.id, eventId: ev.id }, status: "running", priority: 0, attempts: 1, maxAttempts: 1, runAt: new Date(), lockedAt: new Date(), lockedBy: "t", progress: 0, result: null, error: null, createdAt: new Date(), updatedAt: new Date() };
        await expect(handlers["webhook.deliver"](job as any, { db, progress: async () => {}, log: () => {} } as any)).rejects.toThrow();
      } finally {
        vi.stubGlobal("fetch", (async () => {
          throw new Error("security.data: outbound fetch is blocked in this test");
        }) as typeof fetch);
      }
      const [disabled] = (await db.select().from(S.events).where(S.eq(S.events.orgId, o.orgId))).filter((e: any) => e.type === "webhook.disabled");
      expect(disabled).toBeTruthy();
      expect(disabled.data).toMatchObject({ webhookId: hook.id, url: "https://hooks.customer-site.com" });
      for (const secret of [SECRET_PATH, "pa55w0rd", "qs-"]) expect(JSON.stringify(disabled.data)).not.toContain(secret);
    });
  });

  // ── 5. Unverified email ────────────────────────────────────────────────────────────
  describe("an account that has not confirmed its email", () => {
    const unverify = (userId: string) => db.update(S.users).set({ emailVerifiedAt: null }).where(S.eq(S.users.id, userId));
    const verify = (userId: string) => db.update(S.users).set({ emailVerifiedAt: new Date() }).where(S.eq(S.users.id, userId));

    it("cannot send or re-send invites, or add the platform sender, while verification is available", async () => {
      const o = await signup("unv");
      // An invite made while nothing was restricted, to re-send later.
      const earlier = await req("POST", "/v1/tools/team/invite", o.token, { email: `early-${u8()}@example.com`, role: "member" });
      expect(earlier.status).toBe(201);
      await unverify(o.userId);
      mocks.platformMailer = true;

      const inv = await req("POST", "/v1/tools/team/invite", o.token, { email: `x-${u8()}@example.com`, role: "member" });
      expect(inv.status).toBe(403);
      expect(inv.body.error.code).toBe("email_unverified");
      expect(inv.body.error.message).not.toMatch(/RESEND|SMTP|env/);
      const resend = await req("POST", `/v1/tools/team/invites/${earlier.body.id}/resend`, o.token, {});
      expect([resend.status, resend.body.error.code]).toEqual([403, "email_unverified"]);
      const sender = await req("POST", "/v1/campaigns/email-accounts", o.token, { provider: "system", fromName: "Asha", fromEmail: o.email });
      expect([sender.status, sender.body.error.code]).toEqual([403, "email_unverified"]);
      // Its own sender is not restricted.
      const own = await req("POST", "/v1/campaigns/email-accounts", o.token, { provider: "resend", fromName: "Asha", fromEmail: o.email, config: { apiKey: "re_own_key_0123456789" } });
      expect(own.status).toBe(201);
      expect(mocks.sent.filter((m) => /invited you/.test(m.subject))).toHaveLength(1); // only the earlier one

      await verify(o.userId);
      expect((await req("POST", "/v1/tools/team/invite", o.token, { email: `y-${u8()}@example.com`, role: "member" })).status).toBe(201);
      expect((await req("POST", `/v1/tools/team/invites/${earlier.body.id}/resend`, o.token, {})).status).toBe(200);
      expect((await req("POST", "/v1/campaigns/email-accounts", o.token, { provider: "system", fromName: "Asha", fromEmail: o.email })).status).toBe(201);
    });

    it("someone who joins through an invite is sent the verification email too (the invite link alone proves nothing)", async () => {
      const o = await signup("unv-join");
      await verify(o.userId);
      mocks.platformMailer = true;
      const email = `joiner-${u8()}@example.com`;
      const inv = await req("POST", "/v1/tools/team/invite", o.token, { email, role: "admin" });
      expect(inv.status).toBe(201);
      mocks.sent.length = 0;
      const join = await req("POST", "/v1/auth/join", null, { token: tokenOf(inv.body.link), password: "member-password-1", name: "Joiner" });
      expect(join.status).toBe(200);
      const [joined] = await db.select().from(S.users).where(S.eq(S.users.id, join.body.user.id));
      expect(joined.emailVerifiedAt).toBeNull();
      const mails = mocks.sent.filter((m) => m.to === email);
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toMatch(/\/verify-email\?token=/);
      // Until they confirm, this admin cannot send invitations either.
      const blocked = await req("POST", "/v1/tools/team/invite", join.body.token, { email: `n-${u8()}@example.com`, role: "member" });
      expect([blocked.status, blocked.body.error.code]).toEqual([403, "email_unverified"]);
    });

    it("is not restricted at all when the platform cannot send a verification email", async () => {
      const o = await signup("unv-off");
      await unverify(o.userId);
      mocks.platformMailer = false;
      expect((await req("POST", "/v1/tools/team/invite", o.token, { email: `z-${u8()}@example.com`, role: "member" })).status).toBe(201);
    });

    it("a queued send through the platform sender waits until the workspace owner has confirmed", async () => {
      const o = await signup("unv-send");
      const ALL_DAY = { timezone: "UTC", sendWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, dailyLimit: 500 };
      const [acct] = await db.insert(S.emailAccounts).values({ orgId: o.orgId, provider: "system", fromName: "Asha", fromEmail: "no-reply@platform.test", dailyLimit: 500 }).returning();
      const [cp] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "C", emailAccountId: acct.id, status: "active", settings: ALL_DAY }).returning();
      const [st] = await db.insert(S.sequenceSteps).values({ campaignId: cp.id, stepNo: 1, channel: "email", subjectTemplate: "Hi", bodyTemplate: "Hello", aiPersonalize: false }).returning();
      const [lead] = await db.insert(S.leads).values({ orgId: o.orgId, email: `p-${u8()}@example.com`, fullName: "Pat", emailStatus: "valid" }).returning();
      const [cc] = await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: lead.id, status: "active" }).returning();
      const { sendStep } = await import("./services/campaigns.js");
      await unverify(o.userId);
      mocks.platformMailer = true;
      const r = await sendStep(cp.id, cc.id, st.id);
      expect(r).toEqual({ skipped: "email unverified" });
      const [after] = await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.id, cc.id));
      expect(after.status).toBe("queued");
      expect(after.lastError).toMatch(/Confirm your email address/);
      expect(mocks.sent.filter((m) => m.to === lead.email)).toHaveLength(0);
    });
  });

  // ── 6. Export ──────────────────────────────────────────────────────────────────────
  describe("workspace export", () => {
    const LEADS = 2100;
    type Seeded = { o: Org; member: { token: string }; admin: { token: string }; secrets: Record<string, string>; marker: string };
    let seeded: Seeded;
    let other: { o: Org; marker: string };

    async function seed(): Promise<Seeded> {
      const o = await signup("exp");
      const member = await addMember(o, "member");
      const admin = await addMember(o, "admin");
      const marker = `zqexport${u8()}`;
      const secrets: Record<string, string> = {};
      const oid = o.orgId;
      const [company] = await db.insert(S.companies).values({ orgId: oid, domain: `${marker}.example`, name: `${marker} Co` }).returning();
      const [icp] = await db.insert(S.icps).values({ orgId: oid, name: `${marker} ICP` }).returning();
      const client = (await req("POST", "/v1/clients", o.token, { name: `${marker} Client` })).body;
      secrets.shareToken = (await req("POST", `/v1/clients/${client.id}/share`, o.token, {})).body.shareToken;
      const cRow = await clientRow(client.id);
      secrets.shareTokenHash = cRow.shareTokenHash;
      secrets.shareTokenEncrypted = cRow.shareTokenEncrypted;
      // More than two pages of leads.
      for (let i = 0; i < LEADS; i += 700) {
        await db.insert(S.leads).values(Array.from({ length: Math.min(700, LEADS - i) }, (_, j) => ({ orgId: oid, companyId: company.id, fullName: `${marker} Lead ${i + j}`, email: `lead${i + j}@${marker}.example` })));
      }
      const [lead] = await db.select().from(S.leads).where(S.eq(S.leads.orgId, oid)).limit(1);
      const [list] = await db.insert(S.lists).values({ orgId: oid, name: `${marker} List` }).returning();
      await db.insert(S.listLeads).values({ listId: list.id, leadId: lead.id });
      await db.insert(S.clientLeadDeliveries).values({ clientId: client.id, leadId: lead.id });
      secrets.smtpPass = `smtp-pass-${u8()}${u8()}`;
      const [acct] = await db.insert(S.emailAccounts).values({ orgId: oid, provider: "smtp", fromName: "Asha", fromEmail: `asha@${marker}.example`, configEncrypted: creds.sealOrgJson(oid, "email-account", { host: "smtp.example.com", port: 587, user: "u", pass: secrets.smtpPass }) }).returning();
      secrets.senderBlob = acct.configEncrypted;
      const [cp] = await db.insert(S.campaigns).values({ orgId: oid, name: `${marker} Campaign`, emailAccountId: acct.id, clientId: client.id }).returning();
      const [st] = await db.insert(S.sequenceSteps).values({ campaignId: cp.id, stepNo: 1, subjectTemplate: "Hi", bodyTemplate: `${marker} body` }).returning();
      await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: lead.id });
      secrets.trackingToken = `trk${u8()}${u8()}${u8()}`;
      await db.insert(S.messages).values({ orgId: oid, campaignId: cp.id, stepId: st.id, leadId: lead.id, toEmail: lead.email, subject: `${marker} subject`, bodyText: "Hello", trackingToken: secrets.trackingToken, status: "sent" });
      await db.insert(S.suppressions).values({ orgId: oid, email: `gone@${marker}.example` });
      await db.insert(S.savedSearches).values({ orgId: oid, name: `${marker} Saved`, query: { titles: ["CEO"] } });
      await db.insert(S.autopilots).values({ orgId: oid, name: `${marker} Autopilot`, query: { titles: ["CEO"] } });
      await db.insert(S.signals).values({ orgId: oid, type: "funding", title: `${marker} signal`, url: `https://news.example/${marker}` });
      await db.insert(S.tasks).values({ orgId: oid, leadId: lead.id, type: "call", title: `${marker} task` });
      const hook = await req("POST", "/v1/webhooks", o.token, { url: `https://hooks.customer-site.com/${marker}`, events: ["*"] });
      secrets.webhookSecret = hook.body.secret;
      secrets.webhookBlob = (await db.select().from(S.webhooks).where(S.eq(S.webhooks.id, hook.body.id)))[0].secretEncrypted;
      await db.insert(S.webhooks).values({ orgId: oid, url: "https://hooks.customer-site.com/legacy", events: ["*"], secret: (secrets.legacyWebhookSecret = `legacy-hook-secret-${u8()}`) });
      secrets.crmToken = `crm-token-${u8()}${u8()}`;
      await req("PUT", "/v1/integrations/hubspot", o.token, { config: { accessToken: secrets.crmToken } });
      secrets.integrationBlob = (await db.select().from(S.integrations).where(S.eq(S.integrations.orgId, oid)))[0].configEncrypted;
      const inv = await req("POST", "/v1/tools/team/invite", o.token, { email: `pending@${marker}.example`, role: "member" });
      secrets.inviteToken = tokenOf(inv.body.link);
      secrets.inviteTokenHash = sha256(secrets.inviteToken);
      secrets.apiKey = o.apiKey;
      secrets.apiKeyHash = sha256(o.apiKey);
      const [owner] = await db.select().from(S.users).where(S.eq(S.users.id, o.userId));
      secrets.passwordHash = owner.passwordHash;
      // A two-factor secret and a recovery code on ANOTHER member (the owner confirms with a password here).
      secrets.totpBlob = crypto.encrypt(`totp-secret-${u8()}`);
      await db.update(S.users).set({ totpSecretEncrypted: secrets.totpBlob }).where(S.eq(S.users.id, admin.id));
      secrets.recoveryHash = sha256(`recovery-${u8()}`);
      await db.insert(S.userRecoveryCodes).values({ userId: admin.id, codeHash: secrets.recoveryHash });
      secrets.jwt = o.token;
      return { o, member, admin, secrets, marker };
    }

    beforeAll(async () => {
      seeded = await seed();
      const o = await signup("exp-other");
      const marker = `zqother${u8()}`;
      await db.insert(S.leads).values({ orgId: o.orgId, fullName: `${marker} Lead`, email: `lead@${marker}.example` });
      await db.insert(S.companies).values({ orgId: o.orgId, domain: `${marker}.example`, name: `${marker} Co` });
      // A global (no-workspace) signal belongs to nobody's export.
      await db.insert(S.signals).values({ orgId: null, type: "funding", title: `${marker} global signal`, url: `https://news.example/global-${marker}` });
      other = { o, marker };
    }, 120_000);

    it("is for an owner's own session: a member, an admin, an API key and a stranger are refused", async () => {
      const { o, member, admin } = seeded;
      for (const [who, token] of [["member", member.token], ["admin", admin.token]] as const) {
        const r = await req("POST", "/v1/account/export", token, { password: "member-password-1" });
        expect({ who, status: r.status, code: r.body?.error?.code }).toEqual({ who, status: 403, code: "forbidden_role" });
        expect(r.text).not.toContain(seeded.marker);
      }
      const key = await req("POST", "/v1/account/export", o.apiKey, { password: PASSWORD });
      expect(key.status).toBe(403);
      expect(key.text).not.toContain(seeded.marker);
      expect((await req("GET", "/v1/account/export", o.apiKey, undefined, { "x-confirm-password": PASSWORD })).status).toBe(403);
      expect((await req("POST", "/v1/account/export", null, { password: PASSWORD })).status).toBe(401);
      expect((await req("GET", "/v1/account/export", null)).status).toBe(401);
      // The refusals are on the audit trail.
      const denied = (await auditOf(o.orgId, "account.exported")).filter((r: any) => r.result === "denied");
      expect(denied.length).toBeGreaterThanOrEqual(2);
    });

    it("asks for the password again, and a wrong one is refused (and limited)", async () => {
      const { o } = seeded;
      const none = await req("POST", "/v1/account/export", o.token, {});
      expect([none.status, none.body.error.code]).toEqual([400, "confirmation_required"]);
      const noneGet = await req("GET", "/v1/account/export", o.token);
      expect([noneGet.status, noneGet.body.error.code]).toEqual([400, "confirmation_required"]);
      for (let i = 0; i < 5; i++) {
        const wrong = await req("POST", "/v1/account/export", o.token, { password: `wrong-${i}` });
        expect([wrong.status, wrong.body.error.code]).toEqual([401, "invalid_password"]);
        expect(wrong.text).not.toContain(seeded.marker);
      }
      // After five wrong answers even the right one waits.
      const locked = await req("POST", "/v1/account/export", o.token, { password: PASSWORD });
      expect([locked.status, locked.body.error.code]).toEqual([429, "rate_limited"]);
      // None of that started an export.
      expect(await auditOf(o.orgId, "account.export_started")).toHaveLength(0);
    });

    it("an account with two-factor sign-in on confirms with a code - the password alone is not enough, and a code works once", async () => {
      const o = await signup("exp-2fa");
      const totp = await import("./lib/totp.js");
      const secret = totp.generateTotpSecret();
      // As the two-factor setup stores it: encrypted, bound to the user.
      await db.update(S.users).set({ totpEnabledAt: new Date(), totpSecretEncrypted: crypto.encrypt(secret, `totp:${o.userId}`) }).where(S.eq(S.users.id, o.userId));

      const pw = await req("POST", "/v1/account/export", o.token, { password: PASSWORD });
      expect([pw.status, pw.body.error.code]).toEqual([400, "confirmation_required"]);
      expect(pw.body.error.message).toMatch(/code/);
      const bad = await req("POST", "/v1/account/export", o.token, { code: "000000", password: PASSWORD });
      expect([bad.status, bad.body.error.code]).toEqual([401, "invalid_2fa_code"]);
      expect(await auditOf(o.orgId, "account.export_started")).toHaveLength(0);

      const code = totp.totpCode(secret)!;
      const del = await req("POST", "/v1/account/delete", o.token, { confirmName: o.orgName, code });
      expect(del.status).toBe(200);
      expect((await auditOf(o.orgId, "account.deletion_requested")).filter((r: any) => r.result === "ok")[0].data).toMatchObject({ confirmedWith: "code" });
      // The same code again is refused: it has been spent.
      const replay = await req("POST", "/v1/account/export", o.token, { code });
      expect([replay.status, replay.body.error.code]).toEqual([401, "invalid_2fa_code"]);
      // The next code (the header form, as GET sends it) works.
      const next = totp.totpCode(secret, Date.now() + 30_000)!;
      const ok = await req("GET", "/v1/account/export", o.token, undefined, { "x-confirm-code": next });
      expect(ok.status).toBe(200);
      expect(ok.body.summary.complete).toBe(true);
      // The export shows that two-factor is on, never the secret.
      expect(ok.body.users[0]).toMatchObject({ twoFactorEnabled: true });
      expect(ok.text).not.toContain(secret);
    });

    it("streams every table of the workspace, in pages, with no secret and nothing of another workspace", async () => {
      const { o, secrets, marker } = seeded;
      const res = await raw("POST", "/v1/account/export", o.token, { password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="scout-export-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.json"$/);
      expect(res.headers.get("cache-control")).toBe("no-store");

      // Read as it arrives: more than one chunk, i.e. not built in memory and sent at once.
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      let chunks = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks++;
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
      expect(chunks).toBeGreaterThan(10);

      const doc = JSON.parse(text);
      const { EXPORT_TABLES, EXPORT_FORMAT } = await import("./services/accountExport.js");
      expect(doc.export).toMatchObject({ format: EXPORT_FORMAT, version: 1, workspaceId: o.orgId });
      expect(doc.organization).toMatchObject({ id: o.orgId, name: o.orgName });
      expect(doc.summary.complete).toBe(true);
      expect(doc.error).toBeUndefined();
      // Every table has its array, and the summary's counts are the arrays' lengths.
      for (const t of EXPORT_TABLES) {
        expect(Array.isArray(doc[t.key]), t.key).toBe(true);
        expect(doc.summary.counts[t.key], t.key).toBe(doc[t.key].length);
      }
      // What the contract lists is there, with the seeded content.
      expect(doc.leads).toHaveLength(LEADS);
      expect(new Set(doc.leads.map((l: any) => l.id)).size).toBe(LEADS);
      expect(doc.users.map((u: any) => u.role).sort()).toEqual(["admin", "member", "owner"]);
      for (const key of ["companies", "icps", "clients", "lists", "listLeads", "clientLeadDeliveries", "emailAccounts", "campaigns", "sequenceSteps", "campaignContacts", "messages", "suppressions", "savedSearches", "autopilots", "signals", "tasks", "integrations", "apiKeys", "invites"]) {
        expect(doc[key].length, key).toBeGreaterThanOrEqual(1);
      }
      expect(doc.webhooks).toHaveLength(2);
      expect(doc.auditLog.length).toBeGreaterThan(3);
      expect(doc.clients[0]).toMatchObject({ name: `${marker} Client`, sharing: true });
      expect(doc.apiKeys[0]).toMatchObject({ name: expect.any(String), prefix: o.apiKey.slice(0, 12) });
      expect(doc.users.find((u: any) => u.role === "owner")).toMatchObject({ email: o.email, twoFactorEnabled: false });
      expect(doc.integrations[0]).toMatchObject({ provider: "hubspot" });
      expect(doc.messages[0].subject).toBe(`${marker} subject`);

      // No secret, in any form it is stored or shown.
      for (const [name, secret] of Object.entries(secrets)) expect(text.includes(secret), `export contains ${name}`).toBe(false);
      for (const field of ["passwordHash", "password_hash", "totpSecretEncrypted", "keyHash", "configEncrypted", "secretEncrypted", "shareToken", "tokenHash", "trackingToken", "codeHash", "tokenVersion"]) expect(text.includes(`"${field}"`), `export has a ${field} field`).toBe(false);
      expect(doc.webhooks.every((w: any) => !("secret" in w))).toBe(true);
      expect(doc.invites.every((i: any) => !("token" in i))).toBe(true);
      // Nothing of the other workspace, and no global row.
      expect(text).not.toContain(other.marker);
      expect(text).not.toContain(other.o.orgId);
      expect(text).not.toContain(other.o.email);

      // Audited, with counts and not content.
      const started = await auditOf(o.orgId, "account.export_started");
      expect(started).toHaveLength(1);
      const [done] = (await auditOf(o.orgId, "account.exported")).filter((r: any) => r.result === "ok");
      expect(done.data).toMatchObject({ complete: true, counts: expect.objectContaining({ leads: LEADS, users: 3 }) });
      expect(done.data.bytes).toBe(Buffer.byteLength(text));
      expect(JSON.stringify(done)).not.toContain(marker);
    }, 60_000);

    it("at most one export per workspace every 10 minutes", async () => {
      const { o } = seeded;
      // The previous test started one. A second is refused - by the audit trail even when the
      // in-process counter is gone (another instance, a restart).
      rateWindow.resetWindows();
      const again = await req("POST", "/v1/account/export", o.token, { password: PASSWORD });
      expect([again.status, again.body.error.code]).toEqual([429, "rate_limited"]);
      expect(again.text).not.toContain(seeded.marker);
      expect(await auditOf(o.orgId, "account.export_started")).toHaveLength(1);
      // ... and by the in-process counter when the audit row is not there yet.
      const p = await signup("exp-rate");
      const [first, second] = await Promise.all([req("POST", "/v1/account/export", p.token, { password: PASSWORD }), req("POST", "/v1/account/export", p.token, { password: PASSWORD })]);
      expect([first.status, second.status].sort()).toEqual([200, 429]);
      // Once the window has passed, it works again.
      await q`UPDATE audit_log SET created_at = now() - interval '11 minutes' WHERE org_id = ${p.orgId} AND action = 'account.export_started'`;
      rateWindow.resetWindows();
      expect((await req("POST", "/v1/account/export", p.token, { password: PASSWORD })).status).toBe(200);
    });

    it("GET works with the confirmation in a header (percent-encoded), never in the URL", async () => {
      const p = await signup("exp-get");
      const inUrl = await req("GET", `/v1/account/export?password=${encodeURIComponent(PASSWORD)}`, p.token);
      expect([inUrl.status, inUrl.body.error.code]).toEqual([400, "confirmation_required"]);
      const r = await req("GET", "/v1/account/export", p.token, undefined, { "x-confirm-password": encodeURIComponent(PASSWORD) });
      expect(r.status).toBe(200);
      expect(r.body.summary.complete).toBe(true);
      expect(r.body.organization.id).toBe(p.orgId);
    });

    it("reads one page at a time, and only as fast as the client takes it", async () => {
      const { o } = seeded;
      const { exportWorkspaceFragments, exportWorkspaceStream, EXPORT_PAGE_SIZE } = await import("./services/accountExport.js");
      const [org] = await db.select().from(S.organizations).where(S.eq(S.organizations.id, o.orgId));
      const fragments: string[] = [];
      for await (const f of exportWorkspaceFragments(org)) fragments.push(f);
      const start = fragments.indexOf(',"leads":[');
      const end = fragments.indexOf("]", start);
      // 2,100 leads in pages of 1,000: three fragments, none larger than a page.
      expect(end - start - 1).toBe(Math.ceil(LEADS / EXPORT_PAGE_SIZE));
      for (const f of fragments.slice(start + 1, end)) expect(JSON.parse(`[${f.replace(/^,/, "")}]`).length).toBeLessThanOrEqual(EXPORT_PAGE_SIZE);
      expect(JSON.parse(fragments.join("")).leads).toHaveLength(LEADS);

      // A client that stops reading stops the export: nothing is produced ahead of demand,
      // and the outcome is reported as aborted.
      const outcomes: any[] = [];
      const stream = exportWorkspaceStream(org, { onDone: (r) => void outcomes.push(r) });
      const reader = stream.getReader();
      await reader.read();
      await reader.read();
      await reader.cancel();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ complete: false, aborted: true });
      expect(outcomes[0].counts.leads).toBeUndefined();
    });

    it("an export that fails part-way is closed as valid JSON that says it is incomplete", async () => {
      const { o } = seeded;
      const mod = await import("./services/accountExport.js");
      const [org] = await db.select().from(S.organizations).where(S.eq(S.organizations.id, o.orgId));
      // A table that cannot be read, in the middle of the list.
      const broken = { key: "broken", table: S.leads, scope: () => S.sql`no_such_column = 1` };
      const at = mod.EXPORT_TABLES.findIndex((t: any) => t.key === "lists");
      mod.EXPORT_TABLES.splice(at, 0, broken as any);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result: any = { complete: false, counts: {}, bytes: 0 };
        let text = "";
        for await (const f of mod.exportWorkspaceFragments(org, { result })) text += f;
        const doc = JSON.parse(text);
        expect(doc.summary.complete).toBe(false);
        expect(doc.error).toMatchObject({ code: "export_incomplete" });
        expect(doc.error.message).not.toMatch(/column|sql|select/i);
        expect(doc.leads).toHaveLength(LEADS);
        expect(doc.lists).toBeUndefined();
        expect(result.complete).toBe(false);
      } finally {
        mod.EXPORT_TABLES.splice(at, 1);
        errors.mockRestore();
      }
    });

    it("every table that holds workspace data is in the export, or is listed as deliberately left out", async () => {
      const { EXPORT_TABLES, NOT_EXPORTED, exportedColumns } = await import("./services/accountExport.js");
      const nameOf = (t: any) => t[Symbol.for("drizzle:Name")] as string;
      const exported = new Set(EXPORT_TABLES.map((t: any) => nameOf(t.table)));
      const scoped = (await q`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'org_id'`).map((r: any) => r.table_name as string);
      expect(scoped.length).toBeGreaterThan(30);
      const undecided = scoped.filter((t: string) => !exported.has(t) && !(t in NOT_EXPORTED) && t !== "organizations");
      expect(undecided).toEqual([]);
      // No exported column has a name that says it holds a credential.
      for (const spec of EXPORT_TABLES) {
        const cols = Object.keys(exportedColumns(spec as any));
        expect(cols.filter((c) => /hash|secret|password|encrypted/i.test(c)), (spec as any).key).toEqual([]);
        expect(cols.filter((c) => /token/i.test(c) && c !== "tokensUsed"), (spec as any).key).toEqual([]);
      }
    });
  });

  // ── 7. Deletion ────────────────────────────────────────────────────────────────────
  describe("workspace deletion", () => {
    const DAY = 86_400_000;
    const pendingRows = (orgId: string) => db.select().from(S.workspaceDeletionRequests).where(S.eq(S.workspaceDeletionRequests.orgId, orgId));
    const campaignRow = async (id: string) => (await db.select().from(S.campaigns).where(S.eq(S.campaigns.id, id)))[0];
    const orgExists = async (id: string) => (await db.select({ id: S.organizations.id }).from(S.organizations).where(S.eq(S.organizations.id, id))).length === 1;
    const purge = async (opts: { now?: Date; onlyOrgIds: string[] }) => (await import("./services/accountDeletion.js")).purgeDueWorkspaces(opts);

    it("needs the owner, the exact workspace name and the password; anything less schedules nothing", async () => {
      const o = await signup("del-gate");
      const member = await addMember(o, "member");
      const admin = await addMember(o, "admin");
      const body = { confirmName: o.orgName, password: PASSWORD };
      for (const token of [member.token, admin.token]) {
        const r = await req("POST", "/v1/account/delete", token, { confirmName: o.orgName, password: "member-password-1" });
        expect([r.status, r.body.error.code]).toEqual([403, "forbidden_role"]);
        expect((await req("POST", "/v1/account/delete/cancel", token, {})).status).toBe(403);
      }
      expect((await req("POST", "/v1/account/delete", o.apiKey, body)).status).toBe(403);
      expect((await req("POST", "/v1/account/delete/cancel", o.apiKey, {})).status).toBe(403);
      expect((await req("POST", "/v1/account/delete", null, body)).status).toBe(401);

      for (const confirmName of [o.orgName.toUpperCase(), ` ${o.orgName}`, `${o.orgName} `, "", "DELETE"]) {
        const r = await req("POST", "/v1/account/delete", o.token, { confirmName, password: PASSWORD });
        expect({ confirmName, status: r.status, code: r.body.error.code }).toEqual({ confirmName, status: 400, code: "name_mismatch" });
      }
      expect((await req("POST", "/v1/account/delete", o.token, { password: PASSWORD })).status).toBe(400);
      const noPw = await req("POST", "/v1/account/delete", o.token, { confirmName: o.orgName });
      expect([noPw.status, noPw.body.error.code]).toEqual([400, "confirmation_required"]);
      const wrong = await req("POST", "/v1/account/delete", o.token, { confirmName: o.orgName, password: "not-the-password" });
      expect([wrong.status, wrong.body.error.code]).toEqual([401, "invalid_password"]);

      expect(await pendingRows(o.orgId)).toHaveLength(0);
      expect((await req("GET", "/v1/account/deletion", o.token)).body).toEqual({ pending: false });
      expect((await auditOf(o.orgId, "account.deletion_requested")).every((r: any) => r.result === "denied")).toBe(true);
      expect(mocks.sent.filter((m) => /scheduled for deletion/.test(m.subject))).toHaveLength(0);
    });

    it("schedules the deletion 7 days out, pauses active campaigns, tells every owner, and can be cancelled", async () => {
      const o = await signup("del-flow");
      const member = await addMember(o, "member");
      const second = await addMember(o, "admin");
      await db.update(S.users).set({ role: "owner" }).where(S.eq(S.users.id, second.id));
      const [active] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Active", status: "active" }).returning();
      const [draft] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Draft", status: "draft" }).returning();
      const [done] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Done", status: "completed" }).returning();

      const before = Date.now();
      const r = await req("POST", "/v1/account/delete", o.token, { confirmName: o.orgName, password: PASSWORD });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ pending: true, alreadyPending: false, emailed: true, pausedCampaigns: [{ id: active.id, name: "Active" }] });
      const scheduled = new Date(r.body.scheduledFor).getTime();
      expect(scheduled).toBeGreaterThanOrEqual(before + 7 * DAY - 1000);
      expect(scheduled).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000);

      // Campaigns: the active one is paused, with the reason recorded; the others are untouched.
      expect([(await campaignRow(active.id)).status, (await campaignRow(draft.id)).status, (await campaignRow(done.id)).status]).toEqual(["paused", "draft", "completed"]);
      const events = (await db.select().from(S.events).where(S.eq(S.events.orgId, o.orgId))).filter((e: any) => e.type === "campaign.paused_workspace_deletion");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ entityId: active.id });
      expect(events[0].data.reason).toMatch(/scheduled for deletion/);

      // Both owners are told; the member is not.
      const mails = mocks.sent.filter((m) => /scheduled for deletion/.test(m.subject));
      expect(mails.map((m) => m.to).sort()).toEqual([o.email, second.email].sort());
      expect(mails[0].text).toContain("https://app.scout.test/settings");
      expect(mails[0].text).not.toMatch(/RESEND|SMTP_|env/);

      // Audited, and visible to everyone in the workspace.
      const [aud] = (await auditOf(o.orgId, "account.deletion_requested")).filter((x: any) => x.result === "ok");
      expect(aud.data).toMatchObject({ scheduledFor: r.body.scheduledFor, confirmedWith: "password", pausedCampaigns: [active.id], ownersEmailed: 2 });
      const seenByOwner = await req("GET", "/v1/account/deletion", o.token);
      expect(seenByOwner.body).toMatchObject({ pending: true, scheduledFor: r.body.scheduledFor, canCancel: true, requestedBy: { email: o.email } });
      expect((await req("GET", "/v1/account/deletion", member.token)).body).toMatchObject({ pending: true, scheduledFor: r.body.scheduledFor, canCancel: false });

      // Asking again does not move the date or send more mail.
      mocks.sent.length = 0;
      const again = await req("POST", "/v1/account/delete", o.token, { confirmName: o.orgName, password: PASSWORD });
      expect(again.body).toMatchObject({ pending: true, alreadyPending: true, scheduledFor: r.body.scheduledFor });
      expect(await pendingRows(o.orgId)).toHaveLength(1);
      expect(mocks.sent).toHaveLength(0);

      // The workspace still works - but campaigns stay paused.
      expect((await req("GET", "/v1/leads", o.token)).status).toBe(200);
      const start = await req("POST", `/v1/campaigns/${active.id}/start`, o.token, {});
      expect([start.status, start.body.error.code]).toEqual([409, "workspace_deletion_pending"]);
      expect(start.body.error.message).toMatch(/scheduled for deletion/);
      // One switched back on behind the route's back is paused again by the scheduler.
      await db.update(S.campaigns).set({ status: "active" }).where(S.eq(S.campaigns.id, active.id));
      const { tickCampaign } = await import("./services/campaigns.js");
      expect((await tickCampaign(active.id)).reason).toMatch(/scheduled for deletion/);
      expect((await campaignRow(active.id)).status).toBe("paused");

      // Cancel: the other owner can do it; campaigns are listed, not restarted.
      const cancel = await req("POST", "/v1/account/delete/cancel", second.token, {});
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ ok: true, cancelled: true, pausedCampaigns: [{ id: active.id, name: "Active" }] });
      expect((await req("GET", "/v1/account/deletion", o.token)).body).toEqual({ pending: false });
      expect((await campaignRow(active.id)).status).toBe("paused");
      expect((await auditOf(o.orgId, "account.deletion_cancelled")).length).toBe(1);
      expect((await req("POST", "/v1/account/delete/cancel", o.token, {})).body).toMatchObject({ ok: true, cancelled: false });
      const restart = await req("POST", `/v1/campaigns/${active.id}/start`, o.token, {});
      expect(restart.body?.error?.code).not.toBe("workspace_deletion_pending");

      // A cancelled request is never acted on, however old.
      await q`UPDATE workspace_deletion_requests SET scheduled_for = now() - interval '3 days' WHERE org_id = ${o.orgId}`;
      expect(await purge({ onlyOrgIds: [o.orgId] })).toEqual({ reminded: [], purged: [], waiting: [], failed: [] });
      expect(await orgExists(o.orgId)).toBe(true);
    });

    it("the purge reminds a day ahead, then deletes everything of that workspace and nothing of another", async () => {
      const victim = await signup("del-purge");
      const keeper = await signup("del-keep");
      const vMember = await addMember(victim, "member");

      // A graph in each workspace: the same shape, so "nothing of the other" means something.
      async function graph(o: Org) {
        const oid = o.orgId;
        const [company] = await db.insert(S.companies).values({ orgId: oid, domain: `co-${u8()}.example`, name: "Co" }).returning();
        const [icp] = await db.insert(S.icps).values({ orgId: oid, name: "ICP" }).returning();
        const [client] = await db.insert(S.clients).values({ orgId: oid, name: `Client ${u8()}`, icpId: icp.id }).returning();
        const [lead] = await db.insert(S.leads).values({ orgId: oid, companyId: company.id, clientId: client.id, fullName: "Lead", email: `l-${u8()}@example.com` }).returning();
        const [list] = await db.insert(S.lists).values({ orgId: oid, name: "List" }).returning();
        await db.insert(S.listLeads).values({ listId: list.id, leadId: lead.id });
        await db.insert(S.clientLeadDeliveries).values({ clientId: client.id, leadId: lead.id });
        const [acct] = await db.insert(S.emailAccounts).values({ orgId: oid, provider: "system", fromName: "A", fromEmail: "a@platform.test" }).returning();
        const [cp] = await db.insert(S.campaigns).values({ orgId: oid, name: "C", emailAccountId: acct.id, status: "active" }).returning();
        const [st] = await db.insert(S.sequenceSteps).values({ campaignId: cp.id, stepNo: 1, subjectTemplate: "s", bodyTemplate: "b" }).returning();
        const [cc] = await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: lead.id }).returning();
        await db.insert(S.messages).values({ orgId: oid, campaignId: cp.id, stepId: st.id, leadId: lead.id, toEmail: lead.email, subject: "s", bodyText: "b", trackingToken: `t-${u8()}${u8()}` });
        await db.insert(S.suppressions).values({ orgId: oid, email: `s-${u8()}@example.com` });
        await db.insert(S.savedSearches).values({ orgId: oid, name: "SS", query: {} });
        await db.insert(S.autopilots).values({ orgId: oid, name: "AP", query: {} });
        await db.insert(S.signals).values({ orgId: oid, type: "funding", title: "t", url: `https://n.example/${u8()}` });
        await db.insert(S.tasks).values({ orgId: oid, leadId: lead.id, campaignId: cp.id, contactId: cc.id, type: "call", title: "t" });
        await db.insert(S.webhooks).values({ orgId: oid, url: "https://hooks.customer-site.com/x", secret: "s" });
        await db.insert(S.integrations).values({ orgId: oid, provider: "hubspot", configEncrypted: creds.sealOrgJson(oid, "integration", { accessToken: "t" }) });
        await db.insert(S.events).values({ orgId: oid, type: "lead.created", data: {} });
        await db.insert(S.jobs).values({ orgId: oid, type: "lead.enrich", payload: { leadId: lead.id }, status: "done" });
        await db.insert(S.searches).values({ orgId: oid, query: {} });
        await db.insert(S.usage).values({ orgId: oid, period: "2026-10", metric: "leads", count: 3 });
        await db.insert(S.upgradeRequests).values({ orgId: oid, name: "N", email: o.email, mobile: "1", country: "IN", planId: "pro" });
        await db.insert(S.loginAttempts).values({ subject: o.email.toLowerCase(), ip: "198.51.100.9", succeeded: true });
        const [pixel] = await db.insert(S.pixels).values({ orgId: oid, key: `px-${u8()}${u8()}`, name: "P" }).returning();
        await db.insert(S.visits).values({ orgId: oid, pixelId: pixel.id, sessionId: "s", ipHash: "h" });
        await db.insert(S.passwordResetTokens).values({ userId: o.userId, tokenHash: sha256(`r-${u8()}`), expiresAt: new Date(Date.now() + DAY) });
        return { leadId: lead.id, campaignId: cp.id, clientId: client.id, listId: list.id };
      }
      const v = await graph(victim);
      const k = await graph(keeper);

      /** Rows per table for a workspace: every table with an org_id, plus the ones that hang off a parent. */
      const scopedTables = (await q`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'org_id' ORDER BY 1`).map((r: any) => r.table_name as string);
      async function census(o: Org, ids: { campaignId: string; clientId: string; listId: string }) {
        const out: Record<string, number> = {};
        for (const t of scopedTables) out[t] = Number(rows(await db.execute(S.sql.raw(`SELECT count(*)::int AS n FROM "${t}" WHERE org_id = '${o.orgId}'`)))[0].n);
        out.organizations = (await orgExists(o.orgId)) ? 1 : 0;
        out.sequence_steps = (await q`SELECT count(*)::int AS n FROM sequence_steps WHERE campaign_id = ${ids.campaignId}`)[0].n;
        out.campaign_contacts = (await q`SELECT count(*)::int AS n FROM campaign_contacts WHERE campaign_id = ${ids.campaignId}`)[0].n;
        out.list_leads = (await q`SELECT count(*)::int AS n FROM list_leads WHERE list_id = ${ids.listId}`)[0].n;
        out.client_lead_deliveries = (await q`SELECT count(*)::int AS n FROM client_lead_deliveries WHERE client_id = ${ids.clientId}`)[0].n;
        out.password_reset_tokens = (await q`SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = ${o.userId}`)[0].n;
        out.login_attempts = (await q`SELECT count(*)::int AS n FROM login_attempts WHERE subject = ${o.email.toLowerCase()}`)[0].n;
        return out;
      }

      const r = await req("POST", "/v1/account/delete", victim.token, { confirmName: victim.orgName, password: PASSWORD });
      expect(r.status).toBe(200);
      const scheduled = new Date(r.body.scheduledFor);
      const keeperBefore = await census(keeper, k);
      const victimBefore = await census(victim, v);
      for (const t of ["users", "leads", "companies", "campaigns", "messages", "jobs", "events", "audit_log", "upgrade_requests", "workspace_deletion_requests", "sequence_steps", "campaign_contacts", "list_leads", "client_lead_deliveries", "password_reset_tokens", "login_attempts"]) expect(victimBefore[t], t).toBeGreaterThanOrEqual(1);
      mocks.sent.length = 0;

      // Day 1: nothing to do yet.
      const only = [victim.orgId, keeper.orgId];
      expect(await purge({ onlyOrgIds: only })).toEqual({ reminded: [], purged: [], waiting: [], failed: [] });
      expect(mocks.sent).toHaveLength(0);

      // A day and a half before the date: the owner is reminded, nothing is deleted.
      expect(await purge({ onlyOrgIds: only, now: new Date(scheduled.getTime() - 1.5 * DAY) })).toMatchObject({ reminded: [victim.orgId], purged: [] });
      expect(mocks.sent.map((m) => [m.to, /^Reminder: .* will be deleted soon$/.test(m.subject)])).toEqual([[victim.email, true]]);
      expect(await orgExists(victim.orgId)).toBe(true);
      // The same pass again does not remind twice; before the date it only waits.
      expect(await purge({ onlyOrgIds: only, now: new Date(scheduled.getTime() - 1 * DAY) })).toMatchObject({ reminded: [], purged: [], waiting: [victim.orgId] });
      expect(mocks.sent).toHaveLength(1);

      // Past the date: gone.
      mocks.sent.length = 0;
      const out = await purge({ onlyOrgIds: only, now: new Date(scheduled.getTime() + 3600_000) });
      expect(out).toEqual({ reminded: [], purged: [victim.orgId], waiting: [], failed: [] });

      const victimAfter = await census(victim, v);
      expect(Object.entries(victimAfter).filter(([, n]) => n !== 0)).toEqual([]);
      // The other workspace is exactly as it was.
      expect(await census(keeper, k)).toEqual(keeperBefore);
      expect((await req("GET", "/v1/leads", keeper.token)).status).toBe(200);

      // The sessions and the key of the deleted workspace are dead.
      for (const cred of [victim.token, vMember.token, victim.apiKey]) expect((await req("GET", "/v1/auth/me", cred)).status).toBe(401);

      // One audit row survives, with no workspace on it: what was deleted, and how much.
      const kept = await q`SELECT org_id, actor_type, action, target_id, data FROM audit_log WHERE action = 'account.purged' AND target_id = ${victim.orgId}`;
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ org_id: null, actor_type: "system", target_id: victim.orgId });
      expect(kept[0].data).toMatchObject({ orgId: victim.orgId, name: victim.orgName, requestedBy: victim.userId, counts: { users: 2, leads: 1, campaigns: 1, messages: 1 } });
      // It names the workspace, not its people.
      expect(JSON.stringify(kept[0])).not.toContain(victim.email);

      // The owner is told, after the fact.
      expect(mocks.sent.map((m) => [m.to, /was deleted$/.test(m.subject)])).toEqual([[victim.email, true]]);
      // Running again finds nothing.
      expect(await purge({ onlyOrgIds: only, now: new Date(scheduled.getTime() + 2 * DAY) })).toEqual({ reminded: [], purged: [], waiting: [], failed: [] });
    }, 60_000);

    it("never deletes without a reminder a day before, even when the job has not run for a while", async () => {
      const o = await signup("del-late");
      await req("POST", "/v1/account/delete", o.token, { confirmName: o.orgName, password: PASSWORD });
      // The job was down all week: the request is already past its date and nobody was reminded.
      await q`UPDATE workspace_deletion_requests SET scheduled_for = now() - interval '2 hours' WHERE org_id = ${o.orgId}`;
      mocks.sent.length = 0;
      expect(await purge({ onlyOrgIds: [o.orgId] })).toMatchObject({ reminded: [o.orgId], purged: [] });
      expect(mocks.sent).toHaveLength(1);
      expect(await orgExists(o.orgId)).toBe(true);
      // Straight away again: still inside the notice period.
      expect(await purge({ onlyOrgIds: [o.orgId] })).toMatchObject({ reminded: [], purged: [], waiting: [o.orgId] });
      expect(await orgExists(o.orgId)).toBe(true);
      // The owner cancels in that window: the workspace is kept.
      const kept = await signup("del-late-kept");
      await req("POST", "/v1/account/delete", kept.token, { confirmName: kept.orgName, password: PASSWORD });
      await q`UPDATE workspace_deletion_requests SET scheduled_for = now() - interval '2 hours' WHERE org_id = ${kept.orgId}`;
      await purge({ onlyOrgIds: [kept.orgId] });
      expect((await req("POST", "/v1/account/delete/cancel", kept.token, {})).body.cancelled).toBe(true);

      // A day later the daily job (the real handler, not a narrowed pass) deletes the first and leaves the second.
      await q`UPDATE audit_log SET created_at = now() - interval '25 hours' WHERE action = 'account.deletion_reminder' AND org_id IN (${o.orgId}, ${kept.orgId})`;
      const { handlers } = await import("./jobs.js");
      const job = { id: randomUUID(), orgId: null, type: "org.purge", payload: {}, status: "running", priority: 100, attempts: 1, maxAttempts: 1, runAt: new Date(), lockedAt: new Date(), lockedBy: "t", progress: 0, result: null, error: null, createdAt: new Date(), updatedAt: new Date() };
      const result = await handlers["org.purge"](job as any, { db, progress: async () => {}, log: () => {} } as any);
      expect(result).toMatchObject({ failed: 0 });
      expect((result as any).purged).toBeGreaterThanOrEqual(1);
      expect(await orgExists(o.orgId)).toBe(false);
      expect(await orgExists(kept.orgId)).toBe(true);
      expect((await req("GET", "/v1/auth/me", kept.token)).status).toBe(200);
    });

    it("org.purge is a daily recurring job with a handler", async () => {
      const { RECURRING_JOBS, handlers } = await import("./jobs.js");
      expect(RECURRING_JOBS["org.purge"]).toBe(24 * 3600_000);
      expect(typeof handlers["org.purge"]).toBe("function");
    });

    it("every table is reachable from the organization by ON DELETE CASCADE, or is named here with the reason it is not", async () => {
      // Platform tables that hold no workspace data, and the two that are deleted explicitly by the purge.
      const NOT_CASCADING: Record<string, string> = {
        organizations: "the root",
        _migrations: "platform: applied migrations",
        admin_revoked_tokens: "platform: admin sign-outs",
        tool_registry: "platform: provider registry",
        tool_usage: "platform: provider usage counters",
        global_suppressions: "platform: the platform-wide do-not-contact list belongs to no workspace and must outlive every one of them",
        login_attempts: "keyed by email, no foreign key: deleted explicitly by the purge",
        upgrade_requests: "org_id is ON DELETE SET NULL (a sales lead may have no workspace): deleted explicitly by the purge",
      };
      const tables = (await q`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`).map((r: any) => r.table_name as string);
      const fks = await q`
        SELECT cl.relname AS tbl, ref.relname AS ref, c.confdeltype AS rule, a.attname AS col, a.attnotnull AS required
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_class ref ON ref.oid = c.confrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND n.nspname = current_schema()`;
      expect(tables.length).toBeGreaterThan(50);
      expect(fks.length).toBeGreaterThan(60);

      // 1. Every org_id column is a cascading foreign key to organizations.
      const orgCols = (await q`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'org_id'`).map((r: any) => r.table_name as string);
      const notCascading = orgCols.filter((t: string) => !fks.some((f: any) => f.tbl === t && f.col === "org_id" && f.ref === "organizations" && f.rule === "c") && !(t in NOT_CASCADING));
      expect(notCascading).toEqual([]);

      // 2. Every other table hangs off a cascading parent through a cascading key.
      const reachable = new Set<string>(["organizations"]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const f of fks) {
          if (f.rule === "c" && reachable.has(f.ref) && !reachable.has(f.tbl)) {
            reachable.add(f.tbl);
            grew = true;
          }
        }
      }
      expect(tables.filter((t: string) => !reachable.has(t) && !(t in NOT_CASCADING))).toEqual([]);
      // The exceptions are real: nothing listed above is in fact cascading from the organization
      // (so the list cannot quietly go stale), apart from the root itself.
      expect(Object.keys(NOT_CASCADING).filter((t) => t !== "organizations" && reachable.has(t))).toEqual([]);

      // 3. No foreign key can BLOCK the delete: none into a workspace table is RESTRICT / NO ACTION.
      const blocking = fks.filter((f: any) => reachable.has(f.ref) && (f.rule === "a" || f.rule === "r"));
      expect(blocking).toEqual([]);
    });
  });
});
