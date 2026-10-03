// Vercel serverless entry (free Hobby tier). Set JOB_MODE=inline and call /internal/jobs/run from cron-job.org every
// minute with the header `x-internal-token: <INTERNAL_TOKEN>` (the token is no longer accepted in the URL).
import { handle } from "@hono/node-server/vercel";
import { createApp } from "../src/app.js";

export default handle(createApp());
