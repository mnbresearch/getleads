import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb, PLANS, upgradeRequests } from "@prospex/db";
import { env } from "../env.js";
import { authenticate } from "../lib/auth.js";
import { badRequest } from "../lib/errors.js";
import { sendMail } from "../lib/mailer.js";
import { rateLimit, type Env } from "../middleware.js";

/** Public "I'm interested, upgrade me" lead capture from the pricing page. No Stripe: this
 * just records the lead and emails the admin so they can close the sale manually, then use
 * the admin dashboard to flip the org onto the new plan once payment is settled. */
export const leadCaptureRoutes = new Hono<Env>();

const BODY_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  mobile: z.string().min(5).max(30),
  country: z.string().min(1).max(80),
  planId: z.string().min(1),
  message: z.string().max(2000).optional(),
});

leadCaptureRoutes.post("/upgrade-requests", rateLimit({ perMinute: 5 }), zValidator("json", BODY_SCHEMA), async (c) => {
  const b = c.req.valid("json");
  if (!PLANS[b.planId]) throw badRequest(`Unknown plan "${b.planId}"`);
  const { db } = getDb();

  // If the request came from a logged-in customer, attach their org so the admin dashboard
  // can jump straight from the lead to that org's detail view.
  const auth = await authenticate(c.req.header("authorization")).catch(() => null);

  const [row] = await db
    .insert(upgradeRequests)
    .values({ orgId: auth?.org.id ?? null, name: b.name, email: b.email.toLowerCase(), mobile: b.mobile, country: b.country, planId: b.planId, message: b.message })
    .returning();

  const plan = PLANS[b.planId];
  if (env.leadNotifyEmail) {
    await sendMail(null, {
      from: env.mailFrom,
      to: env.leadNotifyEmail,
      replyTo: b.email,
      subject: `Upgrade request: ${b.name} wants ${plan.name} ($${plan.priceUsd}/mo)`,
      text: [
        `New upgrade request from the pricing page.`,
        ``,
        `Name: ${b.name}`,
        `Email: ${b.email}`,
        `Mobile: ${b.mobile}`,
        `Country: ${b.country}`,
        `Plan requested: ${plan.name} ($${plan.priceUsd}/mo)`,
        auth ? `Existing workspace: ${auth.org.name} (${auth.org.id})` : `Existing workspace: none (not signed in)`,
        b.message ? `\nMessage:\n${b.message}` : ``,
        ``,
        `Reply to this email to reach them directly, then use the admin dashboard to move their plan once payment is settled.`,
      ].join("\n"),
    }).catch((e) => console.error("[leadCapture] failed to send notification email", e));
  }

  return c.json({ ok: true, id: row.id }, 201);
});
