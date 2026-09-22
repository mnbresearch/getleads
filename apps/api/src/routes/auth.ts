import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, apiKeys, desc, eq, getDb, limitsFor, organizations, users } from "@prospex/db";
import { env } from "../env.js";
import { checkPassword, generateApiKey, hashPassword, issueJwt } from "../lib/auth.js";
import { exchangeCode, findUserForGoogle, googleAuthConfigured, googleAuthUrl, makeState, readState, safeNext, type GoogleIdentity } from "../lib/googleAuth.js";
import { ApiError, badRequest } from "../lib/errors.js";
import { rateLimit, requireAuth, requireUser, type Env } from "../middleware.js";
import { randomToken } from "../lib/crypto.js";
import { emitEvent } from "../lib/events.js";

export const authRoutes = new Hono<Env>();

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

authRoutes.post(
  "/signup",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(1).max(80).optional(), orgName: z.string().min(1).max(80).optional(), inviteCode: z.string().optional() })),
  async (c) => {
    const body = c.req.valid("json");
    if (env.pilotInviteCode && body.inviteCode !== env.pilotInviteCode) throw new ApiError(403, "Invalid invite code", "invalid_invite");
    const { db } = getDb();
    const exists = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) });
    if (exists) throw badRequest("Email already registered");
    const orgName = body.orgName ?? `${body.name ?? body.email.split("@")[0]}'s workspace`;
    let slug = slugify(orgName);
    if (await db.query.organizations.findFirst({ where: eq(organizations.slug, slug) })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const plan = env.defaultPlan;
    const [org] = await db.insert(organizations).values({ name: orgName, slug, plan, planLimits: limitsFor(plan) }).returning();
    const [user] = await db.insert(users).values({ orgId: org.id, email: body.email.toLowerCase(), passwordHash: await hashPassword(body.password), name: body.name ?? "", role: "owner", lastLoginAt: new Date() }).returning();
    const key = generateApiKey();
    await db.insert(apiKeys).values({ orgId: org.id, name: "Default", prefix: key.prefix, keyHash: key.hash });
    await emitEvent(org.id, "org.created", { orgId: org.id, email: user.email });
    return c.json({ token: await issueJwt(user), user: publicUser(user), org: publicOrg(org), apiKey: key.raw }, 201);
  },
);

authRoutes.post("/login", rateLimit({ perMinute: 20 }), zValidator("json", z.object({ email: z.string().email(), password: z.string() })), async (c) => {
  const { email, password } = c.req.valid("json");
  const { db } = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  if (!user || !(await checkPassword(password, user.passwordHash))) throw new ApiError(401, "Invalid email or password", "invalid_credentials");
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, user.orgId) });
  return c.json({ token: await issueJwt(user), user: publicUser(user), org: publicOrg(org!) });
});


// ── Sign in with Google ──
//
// Two endpoints and a redirect. /start signs a state and bounces to Google; /callback
// exchanges the code, resolves the account, and hands the session back to the web app.
// The security reasoning lives in lib/googleAuth.ts, which is where the risky decisions are.

/** Whether the web app should show the Google button at all. */
authRoutes.get("/google/status", (c) => c.json({ enabled: googleAuthConfigured() }));

authRoutes.get("/google/start", rateLimit({ perMinute: 30 }), async (c) => {
  if (!googleAuthConfigured()) throw badRequest("Google sign-in is not configured");
  const state = await makeState(c.req.query("next") ?? "/");
  return c.redirect(googleAuthUrl(state));
});

/**
 * Google sends the browser here.
 *
 * Every failure path redirects back to the app with a short reason rather than rendering an
 * API error page: the person is in a browser mid-sign-in, and a raw JSON 400 is a dead end
 * for them. The token leaves via the URL fragment, not the query string, because a fragment
 * is never sent to a server and never lands in access logs or a Referer header.
 */
authRoutes.get("/google/callback", rateLimit({ perMinute: 30 }), async (c) => {
  const appUrl = env.appUrl.replace(/\/$/, "");
  const fail = (reason: string) => c.redirect(`${appUrl}/login?error=${encodeURIComponent(reason)}`);

  if (!googleAuthConfigured()) return fail("Google sign-in is not configured");
  // Google reports a user who cancelled as an error rather than an absent code.
  if (c.req.query("error")) return fail(c.req.query("error") === "access_denied" ? "Sign-in cancelled" : "Google could not complete the sign-in");

  const code = c.req.query("code");
  if (!code) return fail("Google did not return an authorization code");

  let next = "/";
  let identity: GoogleIdentity;
  try {
    next = (await readState(c.req.query("state"))).next;
    identity = await exchangeCode(code);
  } catch (e) {
    return fail(e instanceof ApiError ? e.message : "Sign-in failed");
  }

  const { db } = getDb();
  let user;
  try {
    user = await findUserForGoogle(identity);
  } catch (e) {
    return fail(e instanceof ApiError ? e.message : "Sign-in failed");
  }

  if (!user) {
    // First time through: same workspace bootstrap as a password signup, minus the password.
    if (env.pilotInviteCode) return fail("Signing up with Google needs an invite code. Please use the signup form.");
    const orgName = `${identity.name || identity.email.split("@")[0]}'s workspace`;
    let slug = slugify(orgName);
    if (await db.query.organizations.findFirst({ where: eq(organizations.slug, slug) })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const plan = env.defaultPlan;
    const [org] = await db.insert(organizations).values({ name: orgName, slug, plan, planLimits: limitsFor(plan) }).returning();
    // A random unusable password rather than an empty hash: the password login path compares
    // against this, and an empty or predictable value there would be a way in.
    const unusable = await hashPassword(`google:${identity.sub}:${randomToken(32)}`);
    [user] = await db
      .insert(users)
      .values({ orgId: org.id, email: identity.email, passwordHash: unusable, name: identity.name || "", role: "owner", lastLoginAt: new Date() })
      .returning();
    const key = generateApiKey();
    await db.insert(apiKeys).values({ orgId: org.id, name: "Default", prefix: key.prefix, keyHash: key.hash });
    await emitEvent(org.id, "org.created", { orgId: org.id, email: user.email, via: "google" });
  } else {
    await db.update(users).set({ lastLoginAt: new Date(), ...(user.name ? {} : { name: identity.name || "" }) }).where(eq(users.id, user.id));
  }

  const token = await issueJwt(user);
  return c.redirect(`${appUrl}/auth/google#token=${encodeURIComponent(token)}&next=${encodeURIComponent(safeNext(next))}`);
});

authRoutes.get("/me", requireAuth, async (c) => {
  const a = c.get("auth");
  return c.json({ user: a.user ? publicUser(a.user) : null, org: publicOrg(a.org), via: a.via, apiKey: a.apiKey ? { id: a.apiKey.id, name: a.apiKey.name, prefix: a.apiKey.prefix } : null });
});

authRoutes.patch("/org", requireAuth, requireUser, zValidator("json", z.object({ name: z.string().min(1).max(80).optional(), settings: z.record(z.unknown()).optional() })), async (c) => {
  const a = c.get("auth");
  const body = c.req.valid("json");
  const { db } = getDb();
  const [org] = await db
    .update(organizations)
    .set({ ...(body.name ? { name: body.name } : {}), ...(body.settings ? { settings: { ...a.org.settings, ...body.settings } } : {}) })
    .where(eq(organizations.id, a.org.id))
    .returning();
  return c.json({ org: publicOrg(org) });
});

// ── API keys ──
authRoutes.get("/api-keys", requireAuth, requireUser, async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.orgId, c.get("auth").org.id)).orderBy(desc(apiKeys.createdAt));
  return c.json({ apiKeys: rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt })) });
});

authRoutes.post("/api-keys", requireAuth, requireUser, zValidator("json", z.object({ name: z.string().min(1).max(60) })), async (c) => {
  const { db } = getDb();
  const key = generateApiKey();
  const [row] = await db.insert(apiKeys).values({ orgId: c.get("auth").org.id, name: c.req.valid("json").name, prefix: key.prefix, keyHash: key.hash }).returning();
  return c.json({ id: row.id, name: row.name, prefix: row.prefix, key: key.raw, note: "Store this key now; it is not shown again." }, 201);
});

authRoutes.delete("/api-keys/:id", requireAuth, requireUser, async (c) => {
  const { db } = getDb();
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.orgId, c.get("auth").org.id)));
  return c.json({ ok: true });
});

export function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt };
}
export function publicOrg(o: typeof organizations.$inferSelect) {
  return { id: o.id, name: o.name, slug: o.slug, plan: o.plan, limits: { ...limitsFor(o.plan), ...o.planLimits }, settings: o.settings, createdAt: o.createdAt };
}
