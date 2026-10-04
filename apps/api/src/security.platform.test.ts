/**
 * Platform, configuration and supply-chain hardening.
 *
 *  1. Database TLS: which hosts get which protection, and that the protection is real - a
 *     verified connection refuses a bad certificate, a required one refuses plaintext, and a
 *     local database still connects without TLS.
 *  2. Secrets: the only two things that stop a production start, and the credentials that
 *     are switched off instead.
 *  3. /health says nothing about the database beyond up or down.
 *  4. Cache-Control: no-store on every API answer.
 *  5. CORS_ALLOW_REGEX is matched against the whole origin.
 *  6. Graceful shutdown: requests and jobs finish; a job that cannot is handed back.
 *  7. HTTP server timeouts.
 *  8. The seed refuses production. Migration errors are logged without the statement.
 *  9. Nobody is told to run the MCP server from a package name we do not own, and the
 *     deployment files keep the properties they were given.
 * 10. The access log never writes down the address someone was looked up by.
 * 11. Private-network database names keep "TLS if offered"; a TLS failure says what to set.
 * 12. An admin sign-in switched off for a placeholder password says so, in words to act on.
 * 13. The rollback restore script, and the documentation of the rollback switches.
 *
 * The TLS stubs speak just enough of the Postgres wire protocol to see what a client sends
 * first. Certificates are made with the `openssl` command at test time (no key material in
 * the repository); those tests are skipped, loudly, where `openssl` is missing.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TLSSocket } from "node:tls";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.JOB_MODE = "inline";
  process.env.APP_URL = "https://app.scout.test";
  process.env.API_URL = "https://api.scout.test";
  process.env.RESEND_API_KEY = "";
  process.env.SMTP_HOST = "";
  delete process.env.DATABASE_SSL;
  delete process.env.DATABASE_SSL_CA;
  delete process.env.CORS_ALLOW_REGEX;
  delete process.env.SHUTDOWN_GRACE_MS;
}

const REPO = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 1. Database TLS ──

describe("database TLS: which host gets which protection", () => {
  const choose = async (url: string, opts: { mode?: string; ca?: string } = {}) => {
    const { chooseSsl } = await import("@prospex/db");
    return chooseSsl(url, { mode: opts.mode, ca: opts.ca });
  };

  it("local development is untouched: loopback connects without TLS, whatever the string says", async () => {
    for (const u of [
      "postgres://u:p@localhost:5432/d",
      "postgres://u:p@127.0.0.1/d",
      "postgres://u:p@[::1]:5432/d",
      "postgres://u:p@127.0.0.1/d?sslmode=require",
      "postgres:///d?host=/var/run/postgresql",
    ]) {
      expect((await choose(u)).ssl, u).toBe(false);
    }
  });

  it("private-network hosts keep the old behaviour (TLS when offered)", async () => {
    for (const u of ["postgres://u:p@db:5432/prospex", "postgres://u:p@dpg-abc123-a/d", "postgres://u:p@10.0.3.4/d", "postgres://u:p@192.168.1.9/d", "postgres://u:p@172.20.0.2/d"]) {
      expect((await choose(u)).ssl, u).toBe("prefer");
    }
  });

  it("a Neon host is verified - also when the string only asks for sslmode=require", async () => {
    expect((await choose("postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/d")).ssl).toBe("verify-full");
    expect((await choose("postgres://u:p@ep-cool-123-pooler.ap-southeast-1.aws.neon.tech/d?sslmode=require")).ssl).toBe("verify-full");
    // Look-alikes are not Neon.
    expect((await choose("postgres://u:p@evilneon.tech/d")).ssl).toBe("require");
    expect((await choose("postgres://u:p@neon.tech.evil.example/d")).ssl).toBe("require");
  });

  it("every other remote host must use TLS: never 'prefer', never off", async () => {
    for (const u of [
      "postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
      "postgres://u:p@db.example.com/d",
      "postgres://u:p@8.8.8.8/d",
      "postgres://u:p@db.example.com/d?sslmode=prefer",
      "postgres://u:p@h1.example.com:5432,h2.example.com:5432/d",
      // The old test was `url.includes("localhost")`: a database or password by that name switched TLS off.
      "postgres://u:p@db.example.com/localhost_db",
      "postgres://u:localhost@db.example.com/d",
    ]) {
      expect((await choose(u)).ssl, u).toBe("require");
    }
  });

  it("sslmode in the connection string is honoured (it used to be overridden by the code)", async () => {
    expect((await choose("postgres://u:p@db.x.supabase.co/postgres?sslmode=verify-full")).ssl).toBe("verify-full");
    expect((await choose("postgres://u:p@db.x.supabase.co/postgres?sslmode=verify-ca")).ssl).toBe("verify-full");
    expect((await choose("postgres://u:p@db.x.supabase.co/postgres?sslmode=require")).ssl).toBe("require");
    expect((await choose("postgres://u:p@db.example.com/d?sslmode=disable")).ssl).toBe(false);
    expect((await choose("postgres://u:p@db.example.com/d?sslrootcert=system")).ssl).toBe("verify-full");
  });

  it("DATABASE_SSL overrides the string and the host; an unknown value is ignored, not obeyed", async () => {
    expect((await choose("postgres://u:p@ep.neon.tech/d", { mode: "require" })).ssl).toBe("require");
    expect((await choose("postgres://u:p@ep.neon.tech/d", { mode: "disable" })).ssl).toBe(false);
    expect((await choose("postgres://u:p@localhost/d", { mode: "verify-full" })).ssl).toBe("verify-full");
    expect((await choose("postgres://u:p@db.example.com/d?sslmode=disable", { mode: "VERIFY-FULL" })).ssl).toBe("verify-full");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await choose("postgres://u:p@ep.neon.tech/d", { mode: "yes-please" })).ssl).toBe("verify-full");
    } finally {
      warn.mockRestore();
    }
  });

  it("a configured CA is used for verification, and the reason never contains the connection string", async () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const c = await choose("postgres://someuser:s3cr3t-pass@db.x.supabase.co/d", { mode: "verify-full", ca });
    expect(c.ssl).toEqual({ ca, rejectUnauthorized: true });
    expect(c.mode).toBe("verify-full");
    expect(c.reason).not.toMatch(/someuser|s3cr3t|supabase/);
  });
});

/**
 * A stand-in for a Postgres server (or for someone sitting between the API and one).
 * `tls: null` answers "no TLS" to the client's SSLRequest; otherwise it answers "yes" and
 * presents the given certificate. It records what the client then did.
 */
interface StubLog {
  sslRequests: number;
  /** A StartupMessage (user, database) received with no TLS around it. */
  plaintextStartups: number;
  /** A StartupMessage received inside a completed TLS session. */
  tlsStartups: number;
  /** The client started a TLS handshake. */
  tlsHellos: number;
}
function startStub(tls: { key: string; cert: string } | null): Promise<{ port: number; log: StubLog; close: () => Promise<void> }> {
  const log: StubLog = { sslRequests: 0, plaintextStartups: 0, tlsStartups: 0, tlsHellos: 0 };
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    let upgraded = false;
    s.on("data", (d: Buffer) => {
      if (upgraded) return;
      if (d.length >= 8 && d.readInt32BE(4) === 80877103) {
        log.sslRequests++;
        if (!tls) {
          s.write("N");
          return;
        }
        upgraded = true;
        s.write("S");
        const t = new TLSSocket(s, { isServer: true, key: tls.key, cert: tls.cert });
        t.on("error", () => {});
        t.on("data", (x: Buffer) => {
          if (x.length >= 8 && x.readInt32BE(4) === 196608) {
            log.tlsStartups++;
            t.destroy();
          }
        });
        return;
      }
      if (d.length >= 8 && d.readInt32BE(4) === 196608) {
        log.plaintextStartups++;
        s.destroy();
        return;
      }
      if (d[0] === 0x16) {
        // A TLS ClientHello sent at a server that said "no TLS": the client did not fall back.
        log.tlsHellos++;
        s.destroy();
      }
    });
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      res({
        port,
        log,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    }),
  );
}

/**
 * One query through createDb against a stub, bounded. Resolves with the error message,
 * "connected", or "observed" as soon as `until()` is true (the stub saw what the test is
 * about; the driver would otherwise keep retrying a stub that hangs up on it).
 */
async function tryConnect(url: string, envVars: Record<string, string | undefined>, until: () => boolean = () => false): Promise<string> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(envVars)) {
    saved[k] = process.env[k];
    if (envVars[k] === undefined) delete process.env[k];
    else process.env[k] = envVars[k];
  }
  const { createDb } = await import("@prospex/db");
  const { sql } = createDb(url);
  try {
    const outcome = await Promise.race([
      sql`select 1`.then(
        () => "connected",
        (e: { code?: string; message?: string }) => `${e.code ?? ""} ${e.message ?? ""}`.trim(),
      ),
      (async () => {
        for (let i = 0; i < 100; i++) {
          if (until()) return "observed";
          await sleep(25);
        }
        return "no answer within 2.5 s";
      })(),
    ]);
    return outcome;
  } finally {
    void sql.end({ timeout: 0 }).catch(() => {});
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** A throwaway CA, a certificate it signed for "localhost", and an unrelated self-signed certificate. */
function makeCerts(): { dir: string; ca: string; good: { key: string; cert: string }; selfSigned: { key: string; cert: string }; wrongName: { key: string; cert: string } } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), "scout-tls-"));
    const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Scout Test CA"]);
    const leaf = (name: string, san: string) => {
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
      writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`);
      run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`]);
      return { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.pem`), "utf8") };
    };
    const good = leaf("good", "DNS:localhost");
    const wrongName = leaf("wrong", "DNS:db.somewhere-else.example");
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "self.key", "-out", "self.pem", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
    return {
      dir,
      ca: readFileSync(join(dir, "ca.pem"), "utf8"),
      good,
      wrongName,
      selfSigned: { key: readFileSync(join(dir, "self.key"), "utf8"), cert: readFileSync(join(dir, "self.pem"), "utf8") },
    };
  } catch {
    return null;
  }
}

describe("database TLS: the protection is real", { timeout: 20_000 }, () => {
  const certs = makeCerts();
  if (!certs) {
    console.warn("\n[!] the certificate tests in security.platform.test.ts did NOT run: the `openssl` command is not available.\n");
  }
  afterAll(() => {
    if (certs) rmSync(certs.dir, { recursive: true, force: true });
  });

  it("a connection that requires TLS does not fall back to plaintext when the other end says 'no TLS'", async () => {
    const stub = await startStub(null);
    try {
      const out = await tryConnect(`postgres://appuser:pw-must-not-leak@localhost:${stub.port}/appdb`, { DATABASE_SSL: "require", DATABASE_SSL_CA: undefined }, () => stub.log.tlsHellos > 0);
      expect(out).not.toBe("connected");
      expect(stub.log.sslRequests).toBeGreaterThan(0);
      // The whole point: no user name, database name or password in the clear.
      expect(stub.log.plaintextStartups).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("the old setting did fall back: 'prefer' (still used for private-network hosts) sends the startup in the clear", async () => {
    // Documents the behaviour remote hosts no longer get. Reached here through the driver
    // directly, because createDb never chooses "prefer" for a loopback address.
    const stub = await startStub(null);
    const postgres = (await import("postgres")).default;
    const sql = postgres(`postgres://appuser:pw@127.0.0.1:${stub.port}/appdb`, { ssl: "prefer", max: 1, connect_timeout: 2 });
    try {
      await Promise.race([sql`select 1`.catch(() => {}), sleep(1500)]);
      expect(stub.log.plaintextStartups).toBeGreaterThan(0);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => {});
      await stub.close();
    }
  });

  it.skipIf(!certs)("a verified connection rejects a certificate that no trusted CA signed", async () => {
    const stub = await startStub(certs!.selfSigned);
    try {
      const out = await tryConnect(`postgres://appuser:pw-must-not-leak@localhost:${stub.port}/appdb`, { DATABASE_SSL: "verify-full", DATABASE_SSL_CA: undefined });
      expect(out).toMatch(/self[- ]signed|SELF_SIGNED|unable to verify|certificate/i);
      expect(stub.log.tlsStartups).toBe(0);
      expect(stub.log.plaintextStartups).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it.skipIf(!certs)("a verified connection rejects a certificate from a trusted CA that names a different host", async () => {
    const stub = await startStub(certs!.wrongName);
    try {
      const out = await tryConnect(`postgres://appuser:pw-must-not-leak@localhost:${stub.port}/appdb`, { DATABASE_SSL: "verify-full", DATABASE_SSL_CA: certs!.ca });
      expect(out).toMatch(/altname|does not match|hostname|certificate/i);
      expect(stub.log.tlsStartups).toBe(0);
      expect(stub.log.plaintextStartups).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it.skipIf(!certs)("a verified connection accepts the right certificate, checked against DATABASE_SSL_CA (PEM text or a file)", async () => {
    for (const caSetting of [certs!.ca, certs!.ca.replace(/\n/g, "\\n"), join(certs!.dir, "ca.pem")]) {
      const stub = await startStub(certs!.good);
      try {
        await tryConnect(`postgres://appuser:pw@localhost:${stub.port}/appdb`, { DATABASE_SSL: "verify-full", DATABASE_SSL_CA: caSetting }, () => stub.log.tlsStartups > 0);
        // The stub hangs up after the startup message; what matters is that it arrived, inside TLS.
        expect(stub.log.tlsStartups).toBeGreaterThan(0);
        expect(stub.log.plaintextStartups).toBe(0);
      } finally {
        await stub.close();
      }
    }
  });

  it.skipIf(!certs)("'require' encrypts without checking the certificate - the documented difference from 'verify-full'", async () => {
    const stub = await startStub(certs!.selfSigned);
    try {
      await tryConnect(`postgres://appuser:pw@localhost:${stub.port}/appdb`, { DATABASE_SSL: "require", DATABASE_SSL_CA: undefined }, () => stub.log.tlsStartups > 0);
      expect(stub.log.tlsStartups).toBeGreaterThan(0);
      expect(stub.log.plaintextStartups).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("with nothing configured, a loopback database is spoken to in plaintext, as in local development", async () => {
    const stub = await startStub(null);
    try {
      await tryConnect(`postgres://appuser:pw@127.0.0.1:${stub.port}/appdb`, { DATABASE_SSL: undefined, DATABASE_SSL_CA: undefined }, () => stub.log.plaintextStartups > 0);
      // No SSLRequest at all: the driver was told not to use TLS, exactly as before.
      expect(stub.log.sslRequests).toBe(0);
      expect(stub.log.plaintextStartups).toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  });

  it.skipIf(!TEST_DB)("the real local database still connects and migrates through the same rules", async () => {
    const { createDb, chooseSsl } = await import("@prospex/db");
    const choice = chooseSsl(TEST_DB!, { mode: undefined, ca: undefined });
    const { sql } = createDb(TEST_DB!);
    try {
      const rows = await sql`select 1 as one`;
      expect(rows[0]!.one).toBe(1);
      // A local test database is loopback (no TLS) or a private-network service name (TLS if offered).
      expect(["off", "prefer"]).toContain(choice.mode);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

// ── 2. Secrets ──

describe("secrets: what stops a production start, and what is switched off instead", () => {
  const good = { JWT_SECRET: "j".repeat(48), ENCRYPTION_KEY: "e".repeat(48) };
  const assess = async (vars: Record<string, string | undefined>, nodeEnv = "production") => (await import("./env.js")).assessSecrets(vars, nodeEnv);

  it("a healthy production configuration has nothing to say", async () => {
    expect(await assess(good)).toEqual({ fatal: [], warnings: [], disabled: [] });
  });

  it("JWT_SECRET: every published placeholder, the built-in default, an empty value, an unexpanded template and anything under 16 characters is fatal", async () => {
    for (const v of ["change-me-to-a-long-random-string", "dev-secret-change-me", "", undefined, "ci", "$(openssl rand -hex 32)", "<JWT_SECRET>", "changeme", "short-secret", "Change-Me-To-A-Long-Random-String", "x".repeat(15)]) {
      const a = await assess({ ...good, JWT_SECRET: v });
      expect(a.fatal.length, String(v)).toBe(1);
      expect(a.fatal[0]).toMatch(/JWT_SECRET/);
      expect(a.fatal[0]).toMatch(/Refusing to start in production/);
      // The message must never repeat the secret it is complaining about.
      if (v && v.length > 8) expect(a.fatal[0]).not.toContain(v);
    }
    expect((await assess({ ...good, JWT_SECRET: "k".repeat(16) })).fatal).toEqual([]);
    // A randomly generated value must never be mistaken for a placeholder, whatever it starts with.
    for (const random of ["xxxQ7f0aZk3-9dLmPw2R", "todoK91sPq77vBnM4xZa", "exampleZ8Qw1Lk0PmN3vT", "yourK2m9Xq0Lp4Vt8Zb1"]) {
      expect((await assess({ ...good, JWT_SECRET: random })).fatal, random).toEqual([]);
    }
  });

  it("JWT_SECRET of 16 to 31 characters starts, with the warning it always had", async () => {
    const a = await assess({ ...good, JWT_SECRET: "k".repeat(20) });
    expect(a.fatal).toEqual([]);
    expect(a.warnings.some((w) => /JWT_SECRET is only 20 characters/.test(w))).toBe(true);
  });

  it("ENCRYPTION_KEY: a placeholder or a short value is fatal and says how to keep saved credentials readable; unset only warns", async () => {
    for (const v of ["change-me-32-bytes-base64-or-hex", "secret", "x".repeat(15)]) {
      const a = await assess({ ...good, ENCRYPTION_KEY: v });
      expect(a.fatal.length, v).toBe(1);
      expect(a.fatal[0]).toMatch(/ENCRYPTION_KEY/);
      expect(a.fatal[0]).toMatch(/ENCRYPTION_KEYS_OLD/);
    }
    const unset = await assess({ JWT_SECRET: good.JWT_SECRET });
    expect(unset.fatal).toEqual([]);
    expect(unset.warnings.some((w) => /ENCRYPTION_KEY is not set/.test(w))).toBe(true);
  });

  it("nothing else is ever fatal: placeholder operator credentials are switched off, each with its own line", async () => {
    const a = await assess({
      ...good,
      ADMIN_API_TOKEN: "changeme",
      ADMIN_PASSWORD: "password",
      INTERNAL_TOKEN: "$(openssl rand -hex 24)",
      STRIPE_WEBHOOK_SECRET: "whsec_...",
      RESEND_WEBHOOK_SECRET: "<your webhook secret>",
      ADMIN_JWT_SECRET: "short",
    });
    expect(a.fatal).toEqual([]);
    expect(a.disabled.map((d) => d.name).sort()).toEqual(["ADMIN_API_TOKEN", "ADMIN_JWT_SECRET", "ADMIN_PASSWORD", "INTERNAL_TOKEN", "RESEND_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"]);
    for (const d of a.disabled) expect(d.line).toMatch(/^\[env\] SECURITY: /);
  });

  it("real-looking operator credentials are left alone", async () => {
    const a = await assess({ ...good, ADMIN_API_TOKEN: "a".repeat(48), ADMIN_PASSWORD: "correct-horse-battery-staple-91", INTERNAL_TOKEN: "f3".repeat(24), STRIPE_WEBHOOK_SECRET: `whsec_${"A1b2".repeat(8)}`, RESEND_WEBHOOK_SECRET: `whsec_${"Zz09".repeat(8)}` });
    expect(a).toEqual({ fatal: [], warnings: [], disabled: [] });
  });

  it("outside production everything is a warning: nothing fatal, nothing switched off", async () => {
    for (const nodeEnv of ["development", "test"]) {
      const a = await assess({ JWT_SECRET: "ci", ENCRYPTION_KEY: "change-me-32-bytes-base64-or-hex", ADMIN_PASSWORD: "password", INTERNAL_TOKEN: "changeme" }, nodeEnv);
      expect(a.fatal).toEqual([]);
      expect(a.disabled).toEqual([]);
      expect(a.warnings.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("a database password printed in the example files is called out in production, without printing it", async () => {
    const a = await assess({ ...good, DATABASE_URL: "postgres://prospex:prospex@db.example.com:5432/prospex" });
    expect(a.fatal).toEqual([]);
    expect(a.warnings.some((w) => /DATABASE_URL uses a database password that is published/.test(w))).toBe(true);
    expect(a.warnings.join(" ")).not.toMatch(/prospex:prospex/);
  });

  /** Import env.ts fresh under the given variables; hand back the module (or the rejection) and what was logged. */
  const boot = async (vars: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      const mod = await import("./env.js");
      return { env: mod.env, resendSecret: process.env.RESEND_WEBHOOK_SECRET, warnings: warn.mock.calls.map((c) => String(c[0])), errors: error.mock.calls.map((c) => String(c[0])) };
    } finally {
      warn.mockRestore();
      error.mockRestore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  };
  const prod = { NODE_ENV: "production", JWT_SECRET: "j".repeat(48), ENCRYPTION_KEY: "e".repeat(48), ADMIN_JWT_SECRET: undefined, ADMIN_API_TOKEN: undefined, ADMIN_PASSWORD: undefined, INTERNAL_TOKEN: undefined, STRIPE_WEBHOOK_SECRET: undefined, RESEND_WEBHOOK_SECRET: undefined };

  it("the server module refuses to load in production on the .env.example secrets", async () => {
    await expect(boot({ ...prod, JWT_SECRET: "change-me-to-a-long-random-string" })).rejects.toThrow(/JWT_SECRET is a placeholder value/);
    await expect(boot({ ...prod, ENCRYPTION_KEY: "change-me-32-bytes-base64-or-hex" })).rejects.toThrow(/ENCRYPTION_KEY is a placeholder value/);
    await expect(boot({ ...prod, JWT_SECRET: "" })).rejects.toThrow(/built-in default/);
    await expect(boot({ ...prod, JWT_SECRET: "only-15-chars!!" })).rejects.toThrow(/only 15 characters/);
  });

  it("the same values load outside production", async () => {
    const r = await boot({ ...prod, NODE_ENV: "development", JWT_SECRET: "change-me-to-a-long-random-string", ENCRYPTION_KEY: "change-me-32-bytes-base64-or-hex" });
    expect(r.env.jwtSecret).toBe("change-me-to-a-long-random-string");
    expect(r.warnings.some((w) => /This would stop the server in production/.test(w))).toBe(true);
  });

  it("an empty JWT_SECRET never becomes an empty signing key", async () => {
    const r = await boot({ ...prod, NODE_ENV: "development", JWT_SECRET: "" });
    expect(r.env.jwtSecret).toBe("dev-secret-change-me");
  });

  it("in production a placeholder operator credential is blanked, so its door answers 'not configured', and the process still loads", async () => {
    const r = await boot({
      ...prod,
      ADMIN_API_TOKEN: "changeme",
      ADMIN_PASSWORD: "password",
      INTERNAL_TOKEN: "secret",
      STRIPE_WEBHOOK_SECRET: "whsec_...",
      RESEND_WEBHOOK_SECRET: "change-me",
      ADMIN_JWT_SECRET: "admin",
    });
    expect(r.env.adminApiToken).toBe("");
    expect(r.env.adminPassword).toBe("");
    expect(r.env.internalToken).toBe("");
    expect(r.env.stripe.webhookSecret).toBeUndefined();
    expect(r.resendSecret).toBeUndefined();
    // The weak admin-session key is not used; the (validated) JWT_SECRET is.
    expect(r.env.adminJwtSecret).toBe(prod.JWT_SECRET);
    expect(r.errors.filter((l) => l.startsWith("[env] SECURITY: ")).length).toBe(6);
    // The lines name the variable, never its value.
    expect(r.errors.join("\n")).not.toMatch(/changeme|whsec_/);
  });

  it("in production real operator credentials pass through untouched", async () => {
    const r = await boot({ ...prod, ADMIN_API_TOKEN: "t".repeat(48), ADMIN_PASSWORD: "a-long-admin-password-4471", INTERNAL_TOKEN: "i".repeat(48), ADMIN_JWT_SECRET: "a".repeat(64) });
    expect(r.env.adminApiToken).toBe("t".repeat(48));
    expect(r.env.adminPassword).toBe("a-long-admin-password-4471");
    expect(r.env.internalToken).toBe("i".repeat(48));
    expect(r.env.adminJwtSecret).toBe("a".repeat(64));
    expect(r.errors).toEqual([]);
  });

  it.skipIf(!TEST_DB)("the job runner endpoint is shut when its token was a placeholder (503, not open and not a crash)", async () => {
    const saved = { ...process.env };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "production", JWT_SECRET: "j".repeat(48), ENCRYPTION_KEY: "e".repeat(48), INTERNAL_TOKEN: "changeme" });
    try {
      const { createApp } = await import("./app.js");
      const app = createApp({ accessLog: false });
      const res = await app.request("/internal/jobs/run", { method: "POST", headers: { "x-internal-token": "changeme" } });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_configured");
    } finally {
      error.mockRestore();
      warn.mockRestore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  });
});

// ── 3 + 4. /health and Cache-Control ──

describe.skipIf(!TEST_DB)("the API's own answers", () => {
  afterEach(() => {
    vi.doUnmock("@prospex/db");
    vi.resetModules();
  });

  it("/health with the database down: 503, a fixed reason, and the driver's message only in the log", async () => {
    const driverMessages = [
      Object.assign(new Error("getaddrinfo ENOTFOUND ep-secret-name-123456.ap-southeast-1.aws.neon.tech"), { code: "ENOTFOUND" }),
      Object.assign(new Error("connect ECONNREFUSED 10.11.12.13:5432"), { code: "ECONNREFUSED" }),
      Object.assign(new Error('password authentication failed for user "scout_app_role"'), { code: "28P01" }),
    ];
    for (const failure of driverMessages) {
      vi.resetModules();
      vi.doMock("@prospex/db", async (importOriginal) => {
        const orig = await importOriginal<typeof import("@prospex/db")>();
        return { ...orig, getDb: () => ({ db: {} as never, sql: (() => Promise.reject(failure)) as never }) };
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { createApp } = await import("./app.js");
        const res = await createApp({ accessLog: false }).request("/health");
        expect(res.status).toBe(503);
        const body = await res.text();
        expect(JSON.parse(body)).toEqual({ ok: false, db: "down", error: "database unavailable" });
        expect(body).not.toMatch(/neon|ENOTFOUND|ECONNREFUSED|10\.11\.12\.13|scout_app_role|password/i);
        // The operator still gets the reason.
        expect(logged.mock.calls.map((c) => String(c[0])).join("\n")).toContain(failure.code);
      } finally {
        logged.mockRestore();
      }
    }
  });

  it("/health with the database up is unchanged", async () => {
    const { createApp } = await import("./app.js");
    const res = await createApp({ accessLog: false }).request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.db).toBe("up");
    expect(Object.keys(body).sort()).toEqual(["db", "jobMode", "ok", "time"]);
  });

  it("every /v1 and /internal answer is no-store - errors, 404s and the token-in-URL public report included", async () => {
    const { createApp } = await import("./app.js");
    const app = createApp({ accessLog: false });
    for (const [method, path] of [
      ["GET", "/v1/leads"], // 401
      ["GET", "/v1/does-not-exist"], // 404
      ["GET", "/v1/public/clients/report/not-a-real-token"], // public, token in the URL
      ["POST", "/v1/auth/login"], // 400
      ["GET", "/v1/agent/capabilities"], // 401
      ["POST", "/internal/jobs/run"], // 403 / 503
    ] as const) {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(res.headers.get("cache-control") ?? "", `${method} ${path}`).toContain("no-store");
    }
  });

  it("a route that sets its own caching keeps it, and pages outside the API are not given one", async () => {
    const { createApp } = await import("./app.js");
    const app = createApp({ accessLog: false });
    // The visitor pixel script is cacheable by design.
    const px = await app.request(`/px/${"a".repeat(32)}.js`);
    if (px.status === 200) expect(px.headers.get("cache-control")).toBe("public, max-age=3600");
    expect((await app.request("/health")).headers.get("cache-control")).toBeNull();
    expect((await app.request("/openapi.json")).headers.get("cache-control")).toBeNull();
  });
});

// ── 5. CORS_ALLOW_REGEX ──

describe("CORS_ALLOW_REGEX is matched against the whole origin", () => {
  const compile = async (src: string | undefined) => {
    const warnings: string[] = [];
    const { compileOriginRegex } = await import("./env.js");
    return { re: compileOriginRegex(src, (l) => warnings.push(l)), warnings };
  };

  it("unset keeps the default: any https *.vercel.app origin, and nothing that only looks like one", async () => {
    const { re, warnings } = await compile(undefined);
    expect(warnings).toEqual([]);
    expect(re!.test("https://my-preview-abc123.vercel.app")).toBe(true);
    for (const o of ["http://x.vercel.app", "https://evilvercel.app", "https://x.vercel.app.evil.example", "https://vercel.app", "https://x.vercel.app/", "https://x.vercel.app:8443"]) {
      expect(re!.test(o), o).toBe(false);
    }
  });

  it("'none', 'off' and an empty value turn the pattern off", async () => {
    for (const v of ["none", "off", "", "  "]) expect((await compile(v)).re).toBeNull();
  });

  it("an unanchored pattern no longer matches an origin that merely contains it, and says so", async () => {
    const { re, warnings } = await compile("example\\.com");
    expect(warnings.some((w) => /not anchored/.test(w))).toBe(true);
    for (const o of ["https://example.com.evil.test", "https://evil.test/?example.com", "https://notexample.com", "https://example.com"]) {
      expect(re!.test(o), o).toBe(false);
    }
    // Half-anchored alternations are the classic mistake: ^a|b$ means "starts with a OR ends with b".
    const alt = (await compile("^https://app\\.example\\.com|https://staging\\.example\\.com$")).re!;
    expect(alt.test("https://app.example.com")).toBe(true);
    expect(alt.test("https://staging.example.com")).toBe(true);
    expect(alt.test("https://app.example.com.evil.test")).toBe(false);
    expect(alt.test("https://evil.test/https://staging.example.com")).toBe(false);
  });

  it("a properly anchored pattern behaves exactly as written", async () => {
    const { re, warnings } = await compile("^https://[a-z0-9-]+\\.example\\.com$");
    expect(warnings).toEqual([]);
    expect(re!.test("https://app.example.com")).toBe(true);
    expect(re!.test("https://APP.example.com")).toBe(true);
    expect(re!.test("https://app.example.com.evil.test")).toBe(false);
  });

  it("an invalid or absurdly long pattern is ignored with a warning - never 'allow everything', never a crash", async () => {
    const bad = await compile("^https://(unclosed$");
    expect(bad.re).toBeNull();
    expect(bad.warnings.some((w) => /not a valid regular expression/.test(w))).toBe(true);
    const long = await compile(`^${"a".repeat(600)}$`);
    expect(long.re).toBeNull();
    expect(long.warnings.length).toBe(1);
  });
});

// ── 6. Graceful shutdown ──

describe("graceful shutdown", () => {
  it("stops listening, lets a request in flight finish, and closes idle keep-alive connections", async () => {
    const { gracefulShutdown } = await import("./shutdown.js");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = createHttpServer(async (req, res) => {
      if (req.url === "/slow") await gate;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("done");
    });
    server.keepAliveTimeout = 60_000;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    // An idle keep-alive connection (one finished request, socket left open).
    const idle = netConnect(port, "127.0.0.1");
    let idleClosed = false;
    idle.on("close", () => (idleClosed = true));
    idle.on("error", () => {});
    idle.write("GET /fast HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise<void>((r) => idle.once("data", () => r()));

    // A request still being served.
    const slow = new Promise<{ status: number; body: string }>((res, rej) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "/slow" }, (resp) => {
        let body = "";
        resp.on("data", (c) => (body += c));
        resp.on("end", () => res({ status: resp.statusCode ?? 0, body }));
      });
      r.on("error", rej);
      r.end();
    });
    await sleep(100);

    const lines: string[] = [];
    const shutdown = gracefulShutdown({ server, graceMs: 5_000, closePool: async () => {}, log: (l) => lines.push(l) });
    await sleep(150);
    // No new connections...
    await expect(
      new Promise((res, rej) => {
        const s = netConnect(port, "127.0.0.1");
        s.on("connect", () => {
          s.destroy();
          res("accepted");
        });
        s.on("error", rej);
      }),
    ).rejects.toThrow();
    // ...the idle one is gone, and the slow one is still being served.
    expect(idleClosed).toBe(true);
    release();
    expect(await slow).toEqual({ status: 200, body: "done" });
    const result = await shutdown;
    expect(result.httpDrained).toBe(true);
    expect(result.jobsDrained).toBe(true);
    expect(result.jobsReleased).toBe(0);
    expect(result.ms).toBeLessThan(4_000);
  });

  it("does not wait for ever: a request that never finishes is cut at the deadline", async () => {
    const { gracefulShutdown } = await import("./shutdown.js");
    const server = createHttpServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const hung = new Promise<string>((res) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "/" }, () => res("answered"));
      r.on("error", () => res("connection closed"));
      r.end();
    });
    await sleep(100);
    const lines: string[] = [];
    const t0 = Date.now();
    const result = await gracefulShutdown({ server, graceMs: 400, closePool: async () => {}, log: (l) => lines.push(l) });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(result.httpDrained).toBe(false);
    expect(await hung).toBe("connection closed");
    expect(lines.some((l) => /still in flight/.test(l))).toBe(true);
  });

  it("the grace period comes from SHUTDOWN_GRACE_MS, within sane bounds", async () => {
    const { shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS } = await import("./shutdown.js");
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(25_000);
    expect(shutdownGraceMs(undefined)).toBe(25_000);
    expect(shutdownGraceMs("")).toBe(25_000);
    expect(shutdownGraceMs("nonsense")).toBe(25_000);
    expect(shutdownGraceMs("-5")).toBe(25_000);
    expect(shutdownGraceMs("10000")).toBe(10_000);
    expect(shutdownGraceMs("5")).toBe(1_000);
    expect(shutdownGraceMs("999999999")).toBe(600_000);
  });

  it("a failing step never stops the rest: the pool is still closed and the result still returned", async () => {
    const { gracefulShutdown } = await import("./shutdown.js");
    const lines: string[] = [];
    let poolClosed = false;
    const result = await gracefulShutdown({
      stopKeeper: () => {
        throw new Error("keeper exploded");
      },
      stopWorker: () => Promise.reject(new Error("worker exploded")),
      releaseLocks: async () => {
        throw Object.assign(new Error("Failed query: update jobs set ... params: secret-param-value"), { code: "57P01" });
      },
      closePool: async () => {
        poolClosed = true;
      },
      graceMs: 300,
      log: (l) => lines.push(l),
    });
    expect(poolClosed).toBe(true);
    expect(result.jobsDrained).toBe(false);
    expect(result.jobsReleased).toBe(0);
    // Logged as class + code + redacted message - never the statement or its parameters.
    expect(lines.join("\n")).not.toMatch(/secret-param-value/);
    expect(lines.join("\n")).toMatch(/keeper exploded/);
  });
});

describe.skipIf(!TEST_DB)("graceful shutdown and the job queue", () => {
  // Job types only this run of this file handles, so no other worker - another test file, or
  // the same file running in someone else's terminal against the same database - claims them.
  const RUN = randomUUID().slice(0, 8);
  const FAST = `g1.platform.fast.${RUN}`;
  const SLOW = `g1.platform.slow.${RUN}`;
  let D: typeof import("@prospex/db");
  let db: import("@prospex/db").Db;

  beforeAll(async () => {
    D = await import("@prospex/db");
    await D.runMigrations(TEST_DB);
    db = D.getDb().db;
    await db.delete(D.jobs).where(D.inArray(D.jobs.type, [FAST, SLOW]));
  });
  afterAll(async () => {
    await db.delete(D.jobs).where(D.inArray(D.jobs.type, [FAST, SLOW]));
  });

  const waitFor = async (id: string, status: string, ms = 8_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const j = await D.getJob(db, id);
      if (j?.status === status) return j;
      if (Date.now() > end) throw new Error(`job ${id} never became ${status} (it is ${j?.status})`);
      await sleep(50);
    }
  };

  it("a running job is allowed to finish, and nothing new is claimed after the signal", async () => {
    const { gracefulShutdown } = await import("./shutdown.js");
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const stop = D.startWorker(
      db,
      {
        [FAST]: async () => {
          await gate;
          return { ok: true };
        },
      },
      { pollMs: 50, concurrency: 1, log: () => {} },
    );
    const first = await D.enqueue(db, FAST, { n: 1 });
    await waitFor(first!.id, "running");

    const shutdown = gracefulShutdown({ stopWorker: stop, graceMs: 5_000, closePool: async () => {}, log: () => {} });
    // Enqueued after the signal: must be left for the next process.
    const second = await D.enqueue(db, FAST, { n: 2 });
    await sleep(300);
    finish();
    const result = await shutdown;
    expect(result.jobsDrained).toBe(true);
    expect(result.jobsReleased).toBe(0);
    expect((await D.getJob(db, first!.id))!.status).toBe("done");
    const left = await D.getJob(db, second!.id);
    expect(left!.status).toBe("queued");
    expect(left!.attempts).toBe(0);
  });

  it("a job still running at the deadline is handed back at once: queued, unlocked, its attempt returned", async () => {
    const { gracefulShutdown, localWorkerId } = await import("./shutdown.js");
    let abandon!: () => void;
    const never = new Promise<void>((r) => (abandon = r));
    const stop = D.startWorker(
      db,
      {
        [SLOW]: async () => {
          await never;
        },
      },
      { pollMs: 50, concurrency: 1, log: () => {} },
    );
    const job = await D.enqueue(db, SLOW, { n: 1 });
    const running = await waitFor(job!.id, "running");
    // The lock owner the worker loop wrote is the one shutdown releases. If this fails, the
    // worker's id format changed and localWorkerId() must follow it.
    expect(running.lockedBy).toBe(localWorkerId());
    expect(running.attempts).toBe(1);

    const lines: string[] = [];
    const t0 = Date.now();
    const result = await gracefulShutdown({ stopWorker: stop, graceMs: 400, closePool: async () => {}, log: (l) => lines.push(l) });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(result.jobsDrained).toBe(false);
    expect(result.jobsReleased).toBe(1);
    const back = await D.getJob(db, job!.id);
    expect(back!.status).toBe("queued");
    expect(back!.lockedBy).toBeNull();
    expect(back!.lockedAt).toBeNull();
    // The process was told to stop; the job did not fail. It keeps all its attempts.
    expect(back!.attempts).toBe(0);
    expect(lines.some((l) => /1 job\(s\) were still running/.test(l))).toBe(true);

    // The abandoned handler finishing late must not mark the job done behind the queue's back.
    abandon();
    await sleep(300);
    expect((await D.getJob(db, job!.id))!.status).toBe("queued");
    await db.delete(D.jobs).where(D.eq(D.jobs.id, job!.id));
  });

  it("releasing touches only this process's running jobs", async () => {
    const { releaseJobLocks } = await import("./shutdown.js");
    const other = await D.enqueue(db, SLOW, { n: "someone-else" });
    await db.update(D.jobs).set({ status: "running", lockedBy: "another-host:4242", lockedAt: new Date(), attempts: 1 }).where(D.eq(D.jobs.id, other!.id));
    const queued = await D.enqueue(db, SLOW, { n: "queued" }, { runAt: new Date(Date.now() + 3_600_000) });
    expect(await releaseJobLocks(db, "this-host:1")).toBe(0);
    expect((await D.getJob(db, other!.id))!.status).toBe("running");
    expect((await D.getJob(db, other!.id))!.lockedBy).toBe("another-host:4242");
    expect((await D.getJob(db, queued!.id))!.status).toBe("queued");
    expect(await releaseJobLocks(db, "another-host:4242")).toBe(1);
    expect((await D.getJob(db, other!.id))!.status).toBe("queued");
  });
});

// ── 7. HTTP server timeouts ──

describe("HTTP server timeouts", () => {
  const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
  const none = { HTTP_KEEPALIVE_TIMEOUT_MS: undefined, HTTP_REQUEST_TIMEOUT_MS: undefined, HTTP_HEADERS_TIMEOUT_MS: undefined };

  it("defaults suit a server behind a proxy: keep-alive above 60 s, a request may not trickle in for 5 minutes", async () => {
    const t = await withEnv(none, async () => (await import("./shutdown.js")).httpTimeouts());
    expect(t.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(t.requestTimeout).toBeLessThanOrEqual(120_000);
    expect(t.headersTimeout).toBeLessThanOrEqual(30_000);
    expect(t.headersTimeout).toBeLessThanOrEqual(t.requestTimeout);
    expect(t.connectionsCheckingInterval).toBeLessThanOrEqual(10_000);
  });

  it("can be overridden, stays within bounds, and ignores nonsense", async () => {
    const t = await withEnv({ HTTP_KEEPALIVE_TIMEOUT_MS: "620000", HTTP_REQUEST_TIMEOUT_MS: "60000", HTTP_HEADERS_TIMEOUT_MS: "90000" }, async () => (await import("./shutdown.js")).httpTimeouts());
    expect(t.keepAliveTimeout).toBe(600_000);
    expect(t.requestTimeout).toBe(60_000);
    // Node refuses headersTimeout above requestTimeout.
    expect(t.headersTimeout).toBe(60_000);
    const junk = await withEnv({ HTTP_KEEPALIVE_TIMEOUT_MS: "soon", HTTP_REQUEST_TIMEOUT_MS: "-1", HTTP_HEADERS_TIMEOUT_MS: "0" }, async () => (await import("./shutdown.js")).httpTimeouts());
    expect(junk).toMatchObject({ keepAliveTimeout: 75_000, requestTimeout: 120_000, headersTimeout: 30_000 });
  });

  it("Node accepts the values, and a real server enforces them: a request that never completes its headers is closed", async () => {
    const server = createHttpServer({ headersTimeout: 300, requestTimeout: 600, keepAliveTimeout: 5_000, connectionsCheckingInterval: 100 }, (_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const closedAfter = await new Promise<number>((res) => {
        const t0 = Date.now();
        const s = netConnect(port, "127.0.0.1");
        s.on("error", () => {});
        // The server answers 408 and hangs up; either is the timeout being enforced.
        s.on("data", () => res(Date.now() - t0));
        s.on("close", () => res(Date.now() - t0));
        s.write("GET / HTTP/1.1\r\nHost: x\r\nX-Partial: ");
      });
      expect(closedAfter).toBeLessThan(3_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ── 8. Seed and migration logging ──

describe("seed and migrations", () => {
  it("the seed refuses a production database unless forced", async () => {
    const { seedRefusal } = await import("../../../packages/db/src/seed.js");
    expect(seedRefusal({ NODE_ENV: "production" }, ["node", "seed.ts"])).toMatch(/refusing to run with NODE_ENV=production/);
    expect(seedRefusal({ NODE_ENV: "Production" }, ["node", "seed.ts"])).not.toBeNull();
    expect(seedRefusal({ NODE_ENV: "production" }, ["node", "seed.ts", "--force"])).toBeNull();
    expect(seedRefusal({ NODE_ENV: "production", SEED_FORCE: "true" }, ["node", "seed.ts"])).toBeNull();
    expect(seedRefusal({ NODE_ENV: "development" }, ["node", "seed.ts"])).toBeNull();
    expect(seedRefusal({}, ["node", "seed.ts"])).toBeNull();
  });

  it("a migration failure is described without the statement, its parameters or a connection string", async () => {
    const { describeMigrationError } = await import("../../../packages/db/src/migrate.js");
    const orm = Object.assign(new Error('Failed query: insert into "users" ("email","password_hash") values ($1,$2)\nparams: a@b.co,$2a$10$abcdefghijklmnopqrstuv'), { name: "DrizzleQueryError" });
    const line = describeMigrationError(orm);
    expect(line).not.toMatch(/a@b\.co|\$2a\$10|insert into/);
    expect(line).toMatch(/query omitted/);
    const conn = Object.assign(new Error("could not connect to postgres://appuser:hunter2hunter2@db.internal:5432/app"), { code: "ECONNREFUSED" });
    const l2 = describeMigrationError(conn);
    expect(l2).not.toMatch(/hunter2/);
    expect(l2).toMatch(/\[ECONNREFUSED\]/);
    const pg = Object.assign(new Error('relation "leads" already exists'), { name: "PostgresError", code: "42P07" });
    expect(describeMigrationError(pg)).toBe('PostgresError [42P07]: relation "leads" already exists');
  });

  it.skipIf(!TEST_DB)("migrations still apply cleanly and are idempotent through the new connection rules", async () => {
    const { runMigrations } = await import("@prospex/db");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMigrations(TEST_DB);
      await runMigrations(TEST_DB);
      expect(log.mock.calls.some((c) => /\[migrate\] up to date/.test(String(c[0])))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

// ── 9. Supply chain and deployment files ──

describe("supply chain and deployment files", () => {
  it("nothing we own tells anyone to run the MCP server from the npm scope that is not ours", () => {
    for (const f of ["README.md", "DEPLOY.md", "docs/DEPLOY.md", "docs/PILOT.md", "docs/ARCHITECTURE.md", "apps/api/src/routes/agent.ts"]) {
      const text = read(f);
      // The instruction itself: npx (with or without -y, as a shell line or a JSON "command") followed by the package.
      expect(/npx[^\n]{0,40}@prospex\/mcp/.test(text), f).toBe(false);
      expect(/"command":\s*"npx"/.test(text), f).toBe(false);
    }
    expect(read("README.md")).toMatch(/packages\/mcp\/dist\/server\.js/);
  });

  it("the capabilities endpoint describes the MCP server without a package to install", () => {
    const text = read("apps/api/src/routes/agent.ts");
    const m = text.match(/mcp:\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/not published to a public package registry/);
    expect(m![1]).not.toMatch(/npx|@prospex|PROSPEX_API_KEY/);
  });

  it("the @prospex scope cannot be fetched from the public registry by a stray install", () => {
    for (const f of [".npmrc", "apps/api/.npmrc"]) {
      const lines = read(f).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      expect(lines, f).toEqual(["@prospex:registry=https://registry.invalid/"]);
    }
    // No token, no auth line, nothing else - this file is committed.
    expect(read(".npmrc")).not.toMatch(/_authToken|_auth|password/i);
  });

  it("every workspace package is private (none can be published by accident), and none runs code on install", () => {
    for (const p of ["package.json", "apps/api/package.json", "apps/web/package.json", "packages/core/package.json", "packages/db/package.json", "packages/sdk/package.json", "packages/mcp/package.json"]) {
      const pkg = JSON.parse(read(p)) as { private?: boolean; scripts?: Record<string, string> };
      expect(pkg.private, p).toBe(true);
      for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) expect(pkg.scripts?.[hook], `${p} ${hook}`).toBeUndefined();
    }
  });

  it("Node is pinned to one major version everywhere it is named", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(">=22.12.0 <23");
    expect(read("Dockerfile").match(/^FROM node:(\S+)/gm)).toEqual(["FROM node:22-alpine", "FROM node:22-alpine"]);
    expect(read(".github/workflows/ci.yml")).toMatch(/node-version: 22/);
  });

  it("the image runs as a non-root user, without dev dependencies, and the build context excludes secrets", () => {
    const dockerfile = read("Dockerfile");
    const lines = dockerfile.split("\n").map((l) => l.trim());
    const user = lines.indexOf("USER node");
    const cmd = lines.findIndex((l) => l.startsWith("CMD "));
    expect(user).toBeGreaterThan(-1);
    expect(user).toBeLessThan(cmd);
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
    // Every workspace tsconfig extends this file; without it the build stage cannot compile.
    expect(dockerfile).toMatch(/COPY [^\n]*tsconfig\.base\.json/);
    expect(dockerfile).not.toMatch(/^(ENV|ARG)\s+\S*(SECRET|TOKEN|PASSWORD|KEY)\S*[= ]/m);
    const ignore = read(".dockerignore").split("\n").map((l) => l.trim());
    for (const entry of [".git", "**/.env", "**/.env.*", "**/node_modules", "**/*.zip", "**/*.pem"]) expect(ignore, entry).toContain(entry);
  });

  it("docker-compose publishes the database on loopback only and takes its password from the environment", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/- "127\.0\.0\.1:5432:5432"/);
    expect(compose).not.toMatch(/^\s*- "5432:5432"/m);
    expect(compose).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:-prospex\}/);
    expect(compose).not.toMatch(/prospex:prospex@/);
    // No application secret is ever given a value in this file.
    expect(compose).not.toMatch(/^\s*(JWT_SECRET|ENCRYPTION_KEY|ADMIN_PASSWORD|ADMIN_API_TOKEN|INTERNAL_TOKEN)\s*[:=]/m);
  });

  it("render.yaml carries no secret values, generates the two that can stop a start, and names the variables the code reads", () => {
    const y = read("render.yaml");
    // A `key:` followed by `value:` is only ever one of the non-secret switches.
    const literal = [...y.matchAll(/- key: (\S+)\n\s+value: (\S+)/g)].map((m) => m[1]);
    expect(literal.sort()).toEqual(["DEFAULT_PLAN", "EMBED_WORKER", "JOB_MODE", "NODE_ENV", "PILOT_MODE", "SMTP_PROBE_ENABLED", "TRUSTED_PROXY", "WORKER_CONCURRENCY"]);
    for (const k of ["JWT_SECRET", "ENCRYPTION_KEY"]) expect(y).toMatch(new RegExp(`- key: ${k}\\n\\s+generateValue: true`));
    for (const k of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_TOTP_SECRET", "RESEND_WEBHOOK_SECRET", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "DATABASE_URL"]) expect(y, k).toMatch(new RegExp(`- key: ${k}\\n\\s+sync: false`));
    // DATABASE_SSL is documented, not set: unset is the safe default.
    expect(y).toMatch(/#\s+DATABASE_SSL\s/);
    expect(y).not.toMatch(/- key: DATABASE_SSL\b/);
    const keys = [...y.matchAll(/- key: (\S+)/g)].map((m) => m[1]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the workflows run with least privilege, and CI runs the API suites against a database", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(ci).toMatch(/TEST_DATABASE_URL: postgres:\/\//);
    expect(ci).toMatch(/npm test -w apps\/api/);
    expect(ci).toMatch(/npm test -w packages\/core/);
    expect(ci).toMatch(/npm audit --omit=dev/);
    expect(ci).not.toMatch(/pull_request_target/);
    const daily = read(".github/workflows/discovery-daily.yml");
    expect(daily).toMatch(/^permissions: \{\}$/m);
    for (const wf of [ci, daily]) {
      // Third-party code runs with our token: every action is pinned to a version, none floats on a branch.
      for (const m of wf.matchAll(/uses:\s*(\S+)/g)) expect(m[1]).toMatch(/@(v\d+(\.\d+)*|[0-9a-f]{40})$/);
      // Untrusted event text must never be pasted into a shell line: `${{ github.event... }}`
      // may appear under `env:` (it arrives as a variable), never inside a `run:` script.
      const lines = wf.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(/^(\s*)(?:- )?run:(.*)$/);
        if (!m) continue;
        const indent = m[1]!.length;
        const script = [m[2]!];
        for (let j = i + 1; j < lines.length && (lines[j]!.trim() === "" || lines[j]!.search(/\S/) > indent); j++) script.push(lines[j]!);
        expect(script.join("\n")).not.toMatch(/\$\{\{\s*(github\.event|inputs)\./);
      }
    }
  });

  it(".env.example documents the database TLS switch and says its secrets are examples", () => {
    const ex = read(".env.example");
    expect(ex).toMatch(/^DATABASE_SSL=$/m);
    expect(ex).toMatch(/refuses to start/);
    expect(read("DEPLOY.md")).toMatch(/DATABASE_SSL=disable \| require \| verify-full/);
  });
});

// ── 10. The access log and personal data ──

describe("access log: no address, name or search text is written down", () => {
  const line = async (path: string, query = "") => (await import("./app.js")).redactRequestLine(path, query);

  it("the admin look-ups that used to log the address they were given", async () => {
    expect(await line("/v1/admin/data-subject", "email=sara.khan%40acme.example")).toBe("/v1/admin/data-subject?email=[redacted]");
    expect(await line("/v1/admin/orgs", "q=sara%40acme.example")).toBe("/v1/admin/orgs?q=[redacted]");
    expect(await line("/v1/admin/suppressions", "q=sara&limit=50")).toBe("/v1/admin/suppressions?q=[redacted]&limit=50");
  });

  it("search boxes and message addressing: q, search, query, name, to, from, cc, bcc, recipient, phone", async () => {
    for (const k of ["q", "search", "query", "name", "to", "from", "cc", "bcc", "recipient", "address", "phone", "Email", "Q"]) {
      const out = await line("/v1/leads", `${k}=Priya+Sharma&limit=20`);
      expect(out, k).not.toMatch(/Priya|Sharma/);
      expect(out, k).toContain("limit=20");
    }
  });

  it("an address is redacted whatever the parameter is called, encoded or not, and in a path", async () => {
    for (const q of ["contact=sara.khan%40acme.example", "x=sara.khan@acme.example", "filter=owner%3Asara.khan%40acme.example", "next=%2Fleads%3Femail%3Dsara.khan%40acme.example"]) {
      expect(await line("/v1/anything", q), q).not.toMatch(/sara|acme/);
    }
    expect(await line("/v1/leads/suppressions/sara.khan@acme.example")).toBe("/v1/leads/suppressions/[redacted]");
    expect(await line("/v1/leads/suppressions/sara.khan%40acme.example")).not.toMatch(/sara/);
  });

  it("what is not personal stays readable: ids, limits, filters, a company domain", async () => {
    expect(await line("/v1/leads", "limit=50&offset=0&sort=created&order=desc&status=new&seniority=c_level")).toBe("/v1/leads?limit=50&offset=0&sort=created&order=desc&status=new&seniority=c_level");
    expect(await line("/v1/signals", "days=30&type=funding&matched=true")).toBe("/v1/signals?days=30&type=funding&matched=true");
    expect(await line("/v1/companies/acme.example/visits", "companyDomain=acme.example&domain=acme.example")).toBe("/v1/companies/acme.example/visits?companyDomain=acme.example&domain=acme.example");
    expect(await line("/v1/leads/3f0c2a1e-9d54-4c1b-8a55-2f1d6f0b7c11")).toBe("/v1/leads/3f0c2a1e-9d54-4c1b-8a55-2f1d6f0b7c11");
  });

  it("credentials in a query are still redacted", async () => {
    expect(await line("/internal/jobs/run", "token=abc123&maxMs=1000")).toBe("/internal/jobs/run?token=[redacted]&maxMs=1000");
  });

  it.skipIf(!TEST_DB)("through the real app: the three admin look-ups leave no address in either log line", async () => {
    const { createApp } = await import("./app.js");
    const lines: string[] = [];
    const app = createApp({ accessLog: (l) => lines.push(l) });
    for (const path of ["/v1/admin/data-subject?email=sara.khan%40acme.example", "/v1/admin/orgs?q=sara.khan%40acme.example", "/v1/admin/suppressions?q=sara.khan%40acme.example", "/v1/leads?q=Sara+Khan"]) {
      await app.request(path);
    }
    expect(lines.length).toBe(8);
    expect(lines.join("\n")).not.toMatch(/sara|khan|acme|%40/i);
    expect(lines.filter((l) => l.includes("[redacted]")).length).toBe(8);
  });
});

// ── 11. Private-network database names, and what a TLS failure says ──

describe("database TLS: private-network names and the hint on failure", { timeout: 20_000 }, () => {
  const choose = async (url: string) => (await import("@prospex/db")).chooseSsl(url, { mode: undefined, ca: undefined });

  it("platform-internal and local-network names keep 'TLS when offered' (they often have no TLS at all)", async () => {
    for (const host of ["myapp-db.internal", "myapp-db.flycast", "postgres.railway.internal", "ip-10-0-3-4.ec2.internal", "pg.default.svc.cluster.local", "nas.local", "db.lan", "db.home.arpa", "db.corp", "top1.nearest.of.myapp-db.internal"]) {
      const c = await choose(`postgres://u:p@${host}:5432/d`);
      expect(c.ssl, host).toBe("prefer");
      expect(c.reason, host).toBe("private-network host");
    }
  });

  it("'<name>.localhost' is loopback", async () => {
    expect((await choose("postgres://u:p@db.localhost:5432/d")).ssl).toBe(false);
  });

  it("a public name that merely contains one of those words still requires TLS", async () => {
    for (const host of ["internal.example.com", "db.internal.example.com", "local.example.com", "mylan.example.com", "flycast.example.org", "db.internal-tools.io", "internal", "x.locals.example"]) {
      const c = await choose(`postgres://u:p@${host}:5432/d`);
      // "internal" on its own is a single-label name: private, as before.
      expect(c.ssl, host).toBe(host === "internal" ? "prefer" : "require");
    }
  });

  it("an explicit setting still wins for a private-network name", async () => {
    const { chooseSsl } = await import("@prospex/db");
    expect(chooseSsl("postgres://u:p@myapp-db.internal/d", { mode: "verify-full", ca: undefined }).ssl).toBe("verify-full");
    expect(chooseSsl("postgres://u:p@myapp-db.internal/d?sslmode=require", { mode: undefined, ca: undefined }).ssl).toBe("require");
    expect(chooseSsl("postgres://u:p@myapp-db.internal/d?sslmode=disable", { mode: undefined, ca: undefined }).ssl).toBe(false);
  });

  /** The error a real connection attempt through createDb ends with. */
  const connectError = async (url: string, envVars: Record<string, string | undefined>, until: () => boolean): Promise<unknown> => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(envVars)) {
      saved[k] = process.env[k];
      if (envVars[k] === undefined) delete process.env[k];
      else process.env[k] = envVars[k];
    }
    const { createDb } = await import("@prospex/db");
    const { sql } = createDb(url);
    try {
      return await Promise.race([
        sql`select 1`.then(
          () => null,
          (e: unknown) => e,
        ),
        (async () => {
          for (let i = 0; i < 120 && !until(); i++) await sleep(25);
          await sleep(200);
          return new Error("no error surfaced");
        })(),
      ]);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => {});
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  const certs = makeCerts();
  afterAll(() => {
    if (certs) rmSync(certs.dir, { recursive: true, force: true });
  });

  it.skipIf(!certs)("a certificate failure produces one sentence: what to set, and where it is documented", async () => {
    const { databaseTlsHint, isCertificateError } = await import("@prospex/db");
    const stub = await startStub(certs!.selfSigned);
    try {
      const e = await connectError(`postgres://appuser:pw-must-not-leak@localhost:${stub.port}/appdb`, { DATABASE_SSL: "verify-full", DATABASE_SSL_CA: undefined }, () => false);
      expect(isCertificateError(e)).toBe(true);
      const hint = databaseTlsHint(e)!;
      expect(hint).toMatch(/^\[db\] The database's TLS certificate could not be verified/);
      expect(hint).toMatch(/DATABASE_SSL_CA/);
      expect(hint).toMatch(/DATABASE_SSL=require/);
      expect(hint).toMatch(/DEPLOY\.md, section B10/);
      expect(hint).not.toMatch(/appuser|pw-must-not-leak|localhost|appdb/);
      expect(hint.split("\n").length).toBe(1);
    } finally {
      await stub.close();
    }
    // The place the hint points at exists.
    expect(read("DEPLOY.md")).toMatch(/### B10\./);
    expect(read("DEPLOY.md")).toMatch(/\*\*1\. Database connection security\.\*\*/);
  });

  it("a server that will not speak TLS produces the other sentence (set disable for a private database)", async () => {
    const { databaseTlsHint, isCertificateError, isTlsHandshakeFailure } = await import("@prospex/db");
    const stub = await startStub(null);
    try {
      const e = await connectError(`postgres://appuser:pw@localhost:${stub.port}/appdb`, { DATABASE_SSL: "require", DATABASE_SSL_CA: undefined }, () => stub.log.tlsHellos > 0);
      expect(isCertificateError(e)).toBe(false);
      expect(isTlsHandshakeFailure(e)).toBe(true);
      expect(databaseTlsHint(e)).toMatch(/DATABASE_SSL=disable/);
    } finally {
      await stub.close();
    }
  });

  it("anything else gets no TLS hint: a wrong password or an unreachable host is not a certificate problem", async () => {
    const { databaseTlsHint } = await import("@prospex/db");
    expect(databaseTlsHint(Object.assign(new Error('password authentication failed for user "x"'), { code: "28P01" }))).toBeNull();
    expect(databaseTlsHint(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }))).toBeNull();
    expect(databaseTlsHint(Object.assign(new Error("getaddrinfo ENOTFOUND db.example.com"), { code: "ENOTFOUND" }))).toBeNull();
    expect(databaseTlsHint(null)).toBeNull();
    // Wrapped by the ORM: still recognised.
    const wrapped = Object.assign(new Error("Failed query: select 1"), { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });
    expect(databaseTlsHint(wrapped)).toMatch(/DATABASE_SSL_CA/);
  });
});

// ── 12. Admin sign-in switched off for a placeholder password ──

describe.skipIf(!TEST_DB)("admin sign-in switched off by a placeholder password", () => {
  const withProduction = async <T>(vars: Record<string, string | undefined>, fn: (logged: { errors: string[] }) => Promise<T>): Promise<T> => {
    const saved = { ...process.env };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    Object.assign(process.env, { NODE_ENV: "production", JWT_SECRET: "j".repeat(48), ENCRYPTION_KEY: "e".repeat(48), ADMIN_EMAIL: "root@scout.test", ADMIN_TOTP_SECRET: "" });
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn({
        get errors() {
          return error.mock.calls.map((c) => String(c[0]));
        },
      });
    } finally {
      error.mockRestore();
      warn.mockRestore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  };
  const login = async (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, password: string) => {
    const res = await app.request("/v1/admin/login", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.77" }, body: JSON.stringify({ email: "root@scout.test", password }) });
    return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string }; token?: string } };
  };

  it("the sign-in page is told what is wrong and what to do - not 'not configured', and no setting names", async () => {
    await withProduction({ ADMIN_PASSWORD: "password" }, async (logged) => {
      const { createApp } = await import("./app.js");
      const { env, ADMIN_SIGN_IN_OFF_MESSAGE } = await import("./env.js");
      expect(env.adminPassword).toBe("");
      const app = createApp({ accessLog: false });
      // Even the "right" placeholder password does not get in.
      for (const pw of ["password", "anything-else"]) {
        const r = await login(app, pw);
        expect(r.status).toBe(400);
        expect(r.body.token).toBeUndefined();
        expect(r.body.error!.message).toBe(ADMIN_SIGN_IN_OFF_MESSAGE);
      }
      expect(ADMIN_SIGN_IN_OFF_MESSAGE).toBe("Admin sign-in is switched off because the admin password set on the server is a published example value. Set a new one in your hosting dashboard and redeploy.");
      expect(ADMIN_SIGN_IN_OFF_MESSAGE).not.toMatch(/ADMIN_|[A-Z]{3,}_[A-Z]{3,}|not configured|—/);
      // The boot log says the same, and names the setting (the log is for the operator).
      const line = logged.errors.find((l) => l.includes("ADMIN_PASSWORD"))!;
      expect(line).toMatch(/^\[env\] SECURITY: ADMIN_PASSWORD is a placeholder value/);
      expect(line).toMatch(/Admin sign-in is switched off/);
      expect(line).toMatch(/Set a new, long ADMIN_PASSWORD in your hosting dashboard and redeploy/);
      expect(line).not.toContain('"password"');
    });
  });

  it("a real admin password is left to the sign-in route (which is tested with its lock in security.auth.test.ts)", async () => {
    await withProduction({ ADMIN_PASSWORD: "a-long-admin-password-4471" }, async () => {
      const { createApp } = await import("./app.js");
      const { env } = await import("./env.js");
      expect(env.adminSignInOff).toBe("");
      expect(env.adminPassword).toBe("a-long-admin-password-4471");
      // A request the route refuses before it counts an attempt (no password at all): the
      // answer is the route's own validation message, so the request did reach the route.
      // (No real sign-in here: the admin form has one lock for the whole platform, and this
      // file must not add attempts to the counts security.auth.test.ts asserts on.)
      const res = await createApp({ accessLog: false }).request("/v1/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "root@scout.test" }) });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("validation_error");
      expect(body.error.message).not.toMatch(/switched off/);
    });
  });

  it("an admin password that was never set keeps the route's own answer", async () => {
    await withProduction({ ADMIN_PASSWORD: undefined }, async () => {
      const { createApp } = await import("./app.js");
      const { env } = await import("./env.js");
      // (A developer's .env may supply one; then this deployment simply has a password.)
      if (env.adminPassword) return;
      expect(env.adminSignInOff).toBe("");
      const r = await login(createApp({ accessLog: false }), "whatever");
      expect(r.status).toBe(400);
      expect(r.body.error!.message).not.toMatch(/published example value/);
    });
  });
});

// ── 13. Rollback: the restore script and the documentation ──

describe.skipIf(!TEST_DB)("rollback restore script", () => {
  let D: typeof import("@prospex/db");
  let db: import("@prospex/db").Db;
  let orgId = "";
  let otherOrgId = "";
  const RAW_KEY = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "";

  /** Decrypt exactly as the previous release does: three base64 parts, AES-256-GCM, key = SHA-256 of the raw key. */
  const decryptAsOldRelease = (blob: string): string => {
    const parts = blob.split(".");
    if (parts.length !== 3) throw new Error("not the old format");
    const d = createDecipheriv("aes-256-gcm", createHash("sha256").update(RAW_KEY).digest(), Buffer.from(parts[0]!, "base64"));
    d.setAuthTag(Buffer.from(parts[1]!, "base64"));
    return Buffer.concat([d.update(Buffer.from(parts[2]!, "base64")), d.final()]).toString("utf8");
  };

  beforeAll(async () => {
    D = await import("@prospex/db");
    await D.runMigrations(TEST_DB);
    db = D.getDb().db;
    const mk = async (name: string) => (await db.insert(D.organizations).values({ name, slug: `h1-rollback-${randomUUID().slice(0, 12)}`, plan: "pilot", planLimits: D.limitsFor("pilot") }).returning())[0]!.id;
    orgId = await mk("Rollback Co");
    otherOrgId = await mk("Bystander Co");
  });
  afterAll(async () => {
    if (orgId) await db.delete(D.organizations).where(D.inArray(D.organizations.id, [orgId, otherOrgId]));
  });

  it("puts back what only the old release's format can express, removes nothing, and is safe to repeat", async () => {
    const L = await import("./lib/linkTokens.js");
    const C = await import("./lib/credentials.js");
    const { restore, legacyEncrypt } = (await import("../../../scripts/rollback-restore.mjs")) as {
      restore: (o: Record<string, unknown>) => Promise<{ links: number; linksAlready: number; creds: number; credsAlready: number; failed: number }>;
      legacyEncrypt: (plain: string, rawKey: string) => string;
    };

    // A link from before the upgrade (readable copy still there), one made on the new release
    // (hash + encrypted copy only), and a client that was never shared.
    const oldToken = L.newShareToken();
    const newToken = L.newShareToken();
    const [legacy] = await db.insert(D.clients).values({ orgId, name: "Shared before the upgrade", shareToken: oldToken, shareTokenHash: L.hashLinkToken(oldToken) }).returning();
    const [fresh] = await db.insert(D.clients).values({ orgId, name: "Shared on the new release" }).returning();
    const [unshared] = await db.insert(D.clients).values({ orgId, name: "Never shared" }).returning();
    await db
      .update(D.clients)
      .set({ shareToken: null, shareTokenHash: L.hashLinkToken(newToken), shareTokenEncrypted: L.shareTokenColumns(orgId, fresh!.id, newToken).shareTokenEncrypted })
      .where(D.eq(D.clients.id, fresh!.id));

    const smtpNew = { host: "smtp.new.example", port: 587, user: "new-user", pass: "new-pass-MUST-NOT-PRINT" };
    const smtpOld = { host: "smtp.old.example", port: 587, user: "old-user", pass: "old-pass-MUST-NOT-PRINT" };
    const hub = { apiKey: "crm-key-MUST-NOT-PRINT" };
    const [accNew] = await db.insert(D.emailAccounts).values({ orgId, provider: "smtp", fromName: "New", fromEmail: "new@rollback.example", configEncrypted: C.sealOrgJson(orgId, "email-account", smtpNew) }).returning();
    const [accOld] = await db.insert(D.emailAccounts).values({ orgId, provider: "smtp", fromName: "Old", fromEmail: "old@rollback.example", configEncrypted: legacyEncrypt(JSON.stringify(smtpOld), RAW_KEY) }).returning();
    const [integ] = await db.insert(D.integrations).values({ orgId, provider: "hubspot", configEncrypted: C.sealOrgJson(orgId, "integration", hub) }).returning();
    // Another workspace, to show --org leaves everyone else alone.
    const [bystander] = await db.insert(D.emailAccounts).values({ orgId: otherOrgId, provider: "smtp", fromName: "B", fromEmail: "b@bystander.example", configEncrypted: C.sealOrgJson(otherOrgId, "email-account", smtpNew) }).returning();

    // Before: the old release cannot read the new-format rows.
    expect(() => decryptAsOldRelease(accNew!.configEncrypted!)).toThrow();
    expect(() => decryptAsOldRelease(integ!.configEncrypted!)).toThrow();
    expect(JSON.parse(decryptAsOldRelease(accOld!.configEncrypted!))).toEqual(smtpOld);

    const args = { dbPkg: D, db, openShareToken: L.openShareToken, openOrgSecret: C.openOrgSecret, legacyShareColumns: L.legacyShareColumns, rawKey: RAW_KEY, orgId };

    // A dry run counts and changes nothing.
    expect(await restore({ ...args, dryRun: true })).toEqual({ links: 1, linksAlready: 1, creds: 2, credsAlready: 1, failed: 0 });
    expect((await db.select().from(D.clients).where(D.eq(D.clients.id, fresh!.id)))[0]!.shareToken).toBeNull();
    expect((await db.select().from(D.emailAccounts).where(D.eq(D.emailAccounts.id, accNew!.id)))[0]!.configEncrypted).toBe(accNew!.configEncrypted);

    // The real run.
    expect(await restore(args)).toEqual({ links: 1, linksAlready: 1, creds: 2, credsAlready: 1, failed: 0 });

    // Report links: the old release looks a link up by clients.share_token.
    for (const [id, token] of [[legacy!.id, oldToken], [fresh!.id, newToken]] as const) {
      const found = await db.select({ id: D.clients.id }).from(D.clients).where(D.eq(D.clients.shareToken, token));
      expect(found.map((f) => f.id)).toEqual([id]);
    }
    const never = (await db.select().from(D.clients).where(D.eq(D.clients.id, unshared!.id)))[0]!;
    expect([never.shareToken, never.shareTokenHash, never.shareTokenEncrypted]).toEqual([null, null, null]);

    // Credentials: readable the old way, with the same content.
    const after = async (table: typeof D.emailAccounts | typeof D.integrations, id: string) => (await db.select().from(table).where(D.eq(table.id, id)))[0]!.configEncrypted!;
    expect(JSON.parse(decryptAsOldRelease(await after(D.emailAccounts, accNew!.id)))).toEqual(smtpNew);
    expect(JSON.parse(decryptAsOldRelease(await after(D.integrations, integ!.id)))).toEqual(hub);
    // The one already in the old format was not touched (byte-identical).
    expect(await after(D.emailAccounts, accOld!.id)).toBe(accOld!.configEncrypted);

    // Nothing was removed, so rolling forward needs nothing: the new release still finds the
    // links by hash, still has the encrypted copy, and still opens every credential.
    const freshAfter = (await db.select().from(D.clients).where(D.eq(D.clients.id, fresh!.id)))[0]!;
    expect(freshAfter.shareTokenHash).toBe(L.hashLinkToken(newToken));
    expect(L.openShareCopy(orgId, fresh!.id, freshAfter.shareTokenEncrypted!)).toBe(newToken);
    // Kept in the marked form, so a link turned off on the previous release stays off after rolling forward.
    expect(L.isLiveShareCopy(freshAfter.shareTokenEncrypted)).toBe(false);
    expect(C.openOrgJson(orgId, "email-account", await after(D.emailAccounts, accNew!.id))).toEqual(smtpNew);
    expect(C.openOrgJson(orgId, "integration", await after(D.integrations, integ!.id))).toEqual(hub);

    // Another workspace was left alone.
    expect(await after(D.emailAccounts, bystander!.id)).toBe(bystander!.configEncrypted);

    // Running it again finds nothing left to do.
    expect(await restore(args)).toEqual({ links: 0, linksAlready: 2, creds: 0, credsAlready: 3, failed: 0 });
  });

  it("a row it cannot read is counted and left exactly as it was", async () => {
    const L = await import("./lib/linkTokens.js");
    const C = await import("./lib/credentials.js");
    const { restore } = (await import("../../../scripts/rollback-restore.mjs")) as { restore: (o: Record<string, unknown>) => Promise<{ links: number; creds: number; failed: number }> };
    const damaged = "v2.000000000000.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA";
    const [acc] = await db.insert(D.emailAccounts).values({ orgId: otherOrgId, provider: "smtp", fromName: "X", fromEmail: "x@bystander.example", configEncrypted: damaged }).returning();
    const r = await restore({ dbPkg: D, db, openShareToken: L.openShareToken, openOrgSecret: C.openOrgSecret, rawKey: RAW_KEY, orgId: otherOrgId });
    expect(r.failed).toBe(1);
    expect((await db.select().from(D.emailAccounts).where(D.eq(D.emailAccounts.id, acc!.id)))[0]!.configEncrypted).toBe(damaged);
  });
});

describe("rollback restore script: the command line and the documentation", () => {
  const SCRIPT = join(REPO, "scripts/rollback-restore.mjs");
  const run = (args: string[], envVars: Record<string, string>) => {
    try {
      const out = execFileSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...envVars }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: tmpdir() });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("refuses to run without the production values, and says which", () => {
    const noDb = run([], {});
    expect(noDb.status).toBe(1);
    expect(noDb.out).toMatch(/DATABASE_URL is not set/);
    const noKey = run([], { DATABASE_URL: "postgres://someuser:secret-pw-MUST-NOT-PRINT@127.0.0.1:1/none" });
    expect(noKey.status).toBe(1);
    expect(noKey.out).toMatch(/Neither ENCRYPTION_KEY nor JWT_SECRET is set/);
    expect(noKey.out).not.toMatch(/MUST-NOT-PRINT|someuser/);
    const badOrg = run(["--org", "not-a-uuid"], { DATABASE_URL: "postgres://u:p@127.0.0.1:1/none", JWT_SECRET: "x".repeat(40) });
    expect(badOrg.status).toBe(1);
    expect(badOrg.out).toMatch(/--org needs a workspace id/);
    expect(run(["--help"], {}).out).toMatch(/--dry-run/);
  });

  it("the script never prints a value it handles", () => {
    const src = read("scripts/rollback-restore.mjs");
    // Every console line is built from counts, flags and fixed text.
    for (const m of src.matchAll(/console\.(log|error)\(([\s\S]*?)\);\n/g)) {
      expect(m[2]).not.toMatch(/\b(token|plain|rawKey|configEncrypted|shareToken|DATABASE_URL\b(?! is not set))\b(?![A-Za-z ]*(back|format|"))/);
    }
    expect(src).not.toMatch(/console\.(log|error)\([^)]*process\.env\./);
  });

  it("DEPLOY.md documents the rollback from the rehearsal: checklist, order, the four switches, the script", () => {
    const d = read("DEPLOY.md");
    expect(d).toMatch(/### B11\. Before you deploy, the four switches, and rolling back/);
    for (const name of ["CREDENTIAL_REBIND_ON_READ", "LINK_TOKENS_CLEAR_PLAINTEXT", "PRIVACY_SWEEP", "IP_LOOKUP_ALLOW_PLAIN_HTTP", "IPINFO_TOKEN"]) expect(d, name).toContain(`\`${name}\``);
    // The defaults, as fixed for this release.
    expect(d).toMatch(/\| `CREDENTIAL_REBIND_ON_READ` \| off \|/);
    expect(d).toMatch(/\| `LINK_TOKENS_CLEAR_PLAINTEXT` \| off \|/);
    expect(d).toMatch(/\| `PRIVACY_SWEEP` \| on \|/);
    expect(d).toMatch(/\| `IP_LOOKUP_ALLOW_PLAIN_HTTP` \| off \|/);
    // The checklist and the order.
    expect(d).toMatch(/Make a restore point/);
    expect(d).toMatch(/at least 16 characters/);
    expect(d).toMatch(/openssl s_client -starttls postgres/);
    expect(d).toMatch(/DATABASE_SSL=require/);
    expect(d).toMatch(/\*\*API first\.\*\*/);
    expect(d).toMatch(/\*\*Web second\*\*/);
    expect(d).toMatch(/node scripts\/rollback-restore\.mjs --dry-run/);
    // Plain hyphens in the new section, as everywhere a person reads.
    const b11 = d.slice(d.indexOf("### B11."), d.indexOf("## Part C"));
    expect(b11).not.toMatch(/—|–/);
    expect(read("docs/DEPLOY.md")).toMatch(/scripts\/rollback-restore\.mjs/);
  });

  it("the switches are documented in the example files and never given a value in render.yaml", () => {
    const ex = read(".env.example");
    const y = read("render.yaml");
    for (const name of ["CREDENTIAL_REBIND_ON_READ", "LINK_TOKENS_CLEAR_PLAINTEXT", "PRIVACY_SWEEP", "IP_LOOKUP_ALLOW_PLAIN_HTTP"]) {
      // Commented out: copying the example file must leave every switch at its default.
      expect(ex, name).toMatch(new RegExp(`^# ${name}=`, "m"));
      expect(ex, name).not.toMatch(new RegExp(`^${name}=`, "m"));
      expect(y, name).toMatch(new RegExp(`#\\s+${name}\\b`));
      expect(y, name).not.toMatch(new RegExp(`- key: ${name}\\b`));
    }
    expect(y).toMatch(/- key: IPINFO_TOKEN\n\s+sync: false/);
  });
});
