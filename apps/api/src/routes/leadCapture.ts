import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { getDb, isPlanId, PLAN_IDS, PLANS, upgradeRequests } from "@prospex/db";
import { env } from "../env.js";
import { authenticate } from "../lib/auth.js";
import { badRequest, redactMessage } from "../lib/errors.js";
import { sendMail } from "../lib/mailer.js";
import { rateLimit, type Env } from "../middleware.js";
import { emailField } from "../lib/fields.js";
import { safeHeaderText } from "../lib/sanitize.js";

/** Public "I'm interested, upgrade me" lead capture from the pricing page. No Stripe: this
 * just records the lead and emails the admin so they can close the sale manually, then use
 * the admin dashboard to flip the org onto the new plan once payment is settled. */
export const leadCaptureRoutes = new Hono<Env>();

const BODY_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  // One canonical address: it is stored, and used as the Reply-To of the notification.
  email: emailField,
  mobile: z.string().min(5).max(30),
  country: z.string().min(1).max(80),
  planId: z.string().min(1).max(100),
  message: z.string().max(2000).optional(),
});

leadCaptureRoutes.post("/upgrade-requests", rateLimit({ perMinute: 5 }), zValidator("json", BODY_SCHEMA), async (c) => {
  const b = c.req.valid("json");
  // isPlanId, not `PLANS[b.planId]`: that is truthy for "constructor", "toString" and every
  // other name a plain object inherits, so a request for the plan "constructor" was stored
  // and the notification read "wants Object ($undefined/mo)".
  if (!isPlanId(b.planId)) throw badRequest(`Unknown plan "${b.planId.slice(0, 40)}". Valid plans: ${PLAN_IDS.join(", ")}`);
  const { db } = getDb();

  // If the request came from a logged-in customer, attach their org so the admin dashboard
  // can jump straight from the lead to that org's detail view.
  const auth = await authenticate(c.req.header("authorization")).catch(() => null);

  const [row] = await db
    .insert(upgradeRequests)
    .values({ orgId: auth?.org.id ?? null, name: b.name, email: b.email, mobile: b.mobile, country: b.country, planId: b.planId, message: b.message })
    .returning();

  const plan = PLANS[b.planId];
  // Built from values that are known to exist, so the subject can never read "undefined".
  const planText = `${plan.name}${typeof plan.priceUsd === "number" ? ` ($${plan.priceUsd}/mo)` : ""}`;
  if (env.leadNotifyEmail) {
    // The request is saved either way; the email is how the operator finds out about it.
    // sendMail reports failure by returning { ok: false } rather than throwing, and that
    // result used to be dropped - a broken mailer meant upgrade requests arrived in silence.
    const sent = await sendMail(null, {
      from: env.mailFrom,
      to: env.leadNotifyEmail,
      replyTo: b.email,
      // A public form: the name is a stranger's text in the subject of a mail to the admin.
      subject: `Upgrade request: ${safeHeaderText(b.name, 80, "Someone")} wants ${planText}`,
      text: [
        `New upgrade request from the pricing page.`,
        ``,
        `Name: ${b.name}`,
        `Email: ${b.email}`,
        `Mobile: ${b.mobile}`,
        `Country: ${b.country}`,
        `Plan requested: ${planText}`,
        auth ? `Existing workspace: ${auth.org.name} (${auth.org.id})` : `Existing workspace: none (not signed in)`,
        b.message ? `\nMessage:\n${b.message}` : ``,
        ``,
        `Reply to this email to reach them directly, then use the admin dashboard to move their plan once payment is settled.`,
      ].join("\n"),
    }).catch((e) => ({ ok: false as const, error: (e as Error)?.message ?? String(e) }));
    if (!sent.ok) console.warn(`[leadCapture] upgrade request ${row.id} was saved but the notification email was not sent: ${redactMessage(String(sent.error ?? "unknown error"))}. It is listed in the admin dashboard under Upgrade requests.`);
  } else {
    console.warn(`[leadCapture] upgrade request ${row.id} was saved, but no notification address is configured, so nobody was emailed. It is listed in the admin dashboard under Upgrade requests.`);
  }

  return c.json({ ok: true, id: row.id }, 201);
});
