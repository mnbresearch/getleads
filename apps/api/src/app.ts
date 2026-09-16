import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { drainJobs, getDb } from "@prospex/db";
import { env } from "./env.js";
import { errorHandler } from "./lib/errors.js";
import type { Env } from "./middleware.js";
import { authRoutes } from "./routes/auth.js";
import { leadRoutes } from "./routes/leads.js";
import { searchRoutes } from "./routes/search.js";
import { icpRoutes } from "./routes/icps.js";
import { companyRoutes } from "./routes/companies.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { trackRoutes } from "./routes/track.js";
import { miscRoutes } from "./routes/misc.js";
import { agentRoutes } from "./routes/agent.js";
import { pixelPublic, visitorRoutes } from "./routes/visitors.js";
import { signalRoutes } from "./routes/signals.js";
import { joinRoutes, toolRoutes } from "./routes/tools.js";
import { adminRoutes } from "./routes/admin.js";
import { leadCaptureRoutes } from "./routes/leadCapture.js";
import { docsHtml, openapi } from "./openapi.js";
import { handlers } from "./jobs.js";
import { wireToolMeter } from "./lib/toolMeter.js";

export function createApp() {
  wireToolMeter();
  const app = new Hono<Env>();
  app.onError(errorHandler);
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  if (env.nodeEnv !== "test") app.use("*", logger());
  app.use("/px/*", cors({ origin: "*", allowMethods: ["POST", "GET", "OPTIONS"], allowHeaders: ["content-type"] }));
  app.use(
    "/v1/*",
    cors({
      origin: (o) => (!o || o === env.appUrl || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || /\.vercel\.app$/.test(o) || /\.netlify\.app$/.test(o) || /\.pages\.dev$/.test(o) ? o ?? "*" : env.appUrl),
      allowHeaders: ["authorization", "content-type", "x-api-key", "x-internal-token"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"],
      maxAge: 86400,
    }),
  );

  app.get("/", (c) => c.json({ name: "Prospex API", version: "1.0.0", docs: `${env.apiUrl}/docs`, openapi: `${env.apiUrl}/openapi.json`, health: `${env.apiUrl}/health` }));
  app.get("/health", async (c) => {
    try {
      const { sql } = getDb();
      await sql`select 1`;
      return c.json({ ok: true, db: "up", jobMode: env.jobMode, time: new Date().toISOString() });
    } catch (e) {
      return c.json({ ok: false, db: "down", error: (e as Error).message }, 503);
    }
  });
  app.get("/openapi.json", (c) => c.json(openapi(env.apiUrl)));
  app.get("/docs", (c) => c.html(docsHtml(`${env.apiUrl}/openapi.json`)));

  app.route("/v1/auth", authRoutes);
  app.route("/v1/leads", leadRoutes);
  app.route("/v1/search", searchRoutes);
  app.route("/v1/icps", icpRoutes);
  app.route("/v1/companies", companyRoutes);
  app.route("/v1/campaigns", campaignRoutes);
  app.route("/v1/agent", agentRoutes);
  app.route("/v1/visitors", visitorRoutes);
  app.route("/v1/signals", signalRoutes);
  app.route("/v1/tools", toolRoutes);
  app.route("/v1/auth", joinRoutes);
  app.route("/px", pixelPublic);
  app.route("/v1", miscRoutes);
  app.route("/v1", leadCaptureRoutes);
  app.route("/v1/admin", adminRoutes);
  app.route("/t", trackRoutes);

  /** Serverless job runner: call from an external cron (cron-job.org is free) when JOB_MODE=inline. */
  app.post("/internal/jobs/run", async (c) => {
    if (env.internalToken && c.req.header("x-internal-token") !== env.internalToken) return c.json({ error: "forbidden" }, 403);
    const n = await drainJobs(getDb().db, handlers, Number(c.req.query("maxMs") ?? 25_000));
    return c.json({ processed: n });
  });
  app.get("/internal/jobs/run", async (c) => {
    if (env.internalToken && c.req.query("token") !== env.internalToken) return c.json({ error: "forbidden" }, 403);
    const n = await drainJobs(getDb().db, handlers, Number(c.req.query("maxMs") ?? 25_000));
    return c.json({ processed: n });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));
  return app;
}
