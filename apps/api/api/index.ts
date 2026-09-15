// Vercel serverless entry (free Hobby tier). Set JOB_MODE=inline and hit /internal/jobs/run from cron-job.org every minute.
import { handle } from "@hono/node-server/vercel";
import { createApp } from "../src/app.js";

export default handle(createApp());
