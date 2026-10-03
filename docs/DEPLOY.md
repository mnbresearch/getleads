# Deploying Prospex for $0/month

Everything below is a genuinely free tier as of September 2026 - checked directly against each provider's current pricing page, not carried over from an older stack. Two things changed since the original build: **Fly.io no longer offers a free tier to new accounts** (legacy-only, now pay-as-you-go from the first machine), and **Brave Search API dropped its free tier in February 2026** (now $5/1,000 queries, no free quota). Both are removed from the recommended path below.

## Stack (one decisive pick per piece, chosen for the best combination of generous free limits, reliability, and a clean paid upgrade later)

| Piece | Provider | Free tier | Why this one |
|---|---|---|---|
| Postgres | **Neon** | 0.5 GB, autoscaling, branch-per-env | Free compute suspends on idle but never deletes data or breaks auth/API - reconnects automatically on the next request. Supabase's free tier instead pauses the *whole project* (including auth) after 7 days idle and needs a manual dashboard click to restore - fine for a side project, bad for a pilot a customer might open once a week. |
| API + worker | **Render Web Service** | 750 hrs/month, sleeps after 15 min idle (~1 min cold start on wake) | Simplest genuinely-free option that runs a persistent Node process with an embedded background worker. A free uptime pinger (step 2 below) keeps it effectively always-on within the free hour budget. |
| Dashboard | **Vercel** | Unlimited static hosting | `apps/web` is a static SPA; no practical free-tier ceiling for a dashboard's traffic level. |
| AI | **Groq** + **Google AI Studio (Gemini Flash)**, both configured | Groq ~14k req/day on Llama 3.3 70B, Gemini 1,500 req/day | Set both, not just one - `AI_PROVIDER=auto` automatically falls back from Groq to Gemini, so a rate-limit or outage on one doesn't take AI features down. Redundancy at zero extra cost is the "premium" part. |
| Search | **Google Programmable Search** | 100 queries/day (~3,000/month) | The only major search API with a real, durable free tier left after Brave's Feb 2026 change. Add SerpAPI (100/month free) as a third key for extra headroom if search volume is tight. |
| Email sending | **Resend** | 3,000 emails/month, 100/day | Needs a verified sending domain (proper SPF/DKIM from day one, which matters for deliverability); or let each customer add their own SMTP later. |
| Email verification boost | **Hunter.io free** | 25 domain searches + 50 verifications/month | Optional - the built-in MX+SMTP check already covers most cases; this just improves confidence on borderline addresses. |
| Cron (only if you deploy the API serverlessly) | cron-job.org | Unlimited, 1-minute resolution | Hits `/internal/jobs/run` (token in the `x-internal-token` header) if you run the API on Vercel instead of Render. Not used on Render. |

Search budget math for 100 pilot users: each lead search uses 2-6 queries. Google's 3,000/month free budget covers roughly 500-1,500 searches/month, about 5-15 per customer at light usage. If that's tight, add the SerpAPI key as a second free source, or lower `searchesPerMonth` in the pilot plan (`packages/db/src/plans.ts`).

## Step 1 - Database (Neon)

1. Create a project at neon.tech (free). Dashboard → Connection Details → copy the **pooled connection** string.
2. Put it in `DATABASE_URL`. Migrations run automatically on API start (`AUTO_MIGRATE` defaults to true).
3. If you'd rather use Supabase instead (same setup, `DATABASE_URL` from Settings → Database → **Transaction pooler**, port 6543), it works identically - just be aware the whole project pauses after 7 days with zero traffic and needs a manual unpause click in their dashboard.

## Step 2 - API on Render

1. Push the repo to GitHub. On render.com → New → Blueprint → select the repo; `render.yaml` is picked up.
2. Fill in the `sync: false` env vars: `DATABASE_URL`, `APP_URL` (your Vercel URL), `API_URL` (the Render URL), `GROQ_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX`, `RESEND_API_KEY`.
3. Deploy. Check `https://<service>.onrender.com/health` → `{"ok":true,"db":"up"}` and `/docs` for Swagger.
4. Keep it awake: add the health URL to a free uptime monitor (UptimeRobot, cron-job.org) every 10 minutes. The embedded worker only runs while the process is awake, so this also keeps scheduled jobs (campaign ticks, signal scans, autopilot) running on time.

SMTP note: Render blocks outbound port 25, so `SMTP_PROBE_ENABLED=false` there; emails are marked `risky` (MX-verified, pattern-inferred) instead of `valid`. Getting real SMTP-verified `valid` results now needs either a paid host with port 25 open (Fly.io works for this once you're paying anyway, or a small VPS), or the `HUNTER_API_KEY` / `ABSTRACT_EMAIL_API_KEY` external-verification boost above, which stays free at pilot volume.

## Step 2 alt - API on Vercel (serverless)

`apps/api/api/index.ts` + `vercel.json` are ready. Set `JOB_MODE=inline` (long searches run inside the request, capped ~25s; `/v1/search` returns results directly). For sequences and background enrichment, schedule `GET https://<api>/internal/jobs/run` every minute on cron-job.org, with the request header `x-internal-token: <INTERNAL_TOKEN>` (edit the job → Advanced → Headers). The token is not accepted in the URL - `?token=` answers 403 - because URLs are written to access logs. Set `TRUSTED_PROXY=xff` on Vercel (on Render it is `cloudflare`, which `render.yaml` sets). Vercel Hobby functions time out at 60s; Render is the simpler default for the worker.

## Step 3 - Dashboard on Vercel

```bash
cd apps/web && vercel --prod      # or import the repo: root directory apps/web, framework Vite
```
Set `VITE_API_URL=https://<your-api>`. `vercel.json` rewrites all routes to `index.html`.

## Step 4 - Email sending

Option A (platform-wide, simplest for pilot): verify your domain in Resend, set `RESEND_API_KEY` and `MAIL_FROM`. Users pick "Platform default" as sender; emails go out from your domain with their name. Good for a 100-user pilot within 3,000/month.

Option B (per customer, scales free): each customer adds their own Resend key or SMTP (Brevo, Zoho, Gmail app password) under Campaigns → Sender accounts. Credentials are AES-256-GCM encrypted with `ENCRYPTION_KEY`.

Inbound replies: point a Resend inbound webhook (or a Gmail → Zapier/Make forward) at `POST /v1/campaigns/inbound` with `{from, subject, text}` and the customer's API key. Replies stop the sequence and are intent-classified.

## Step 5 - Keys to create (all free)

- Neon: neon.tech → New project
- Groq: console.groq.com → API keys
- Gemini: aistudio.google.com → Get API key
- Google CSE: programmablesearchengine.google.com (create engine, enable "Search the entire web") + console.cloud.google.com Custom Search JSON API key
- Resend: resend.com → API keys + Domains
- Hunter: hunter.io → API

## Deploying this release

1. Deploy the API first. It applies migration `0018_grandfather_existing_users.sql` on boot (with `AUTO_MIGRATE=false`, run `npm run db:migrate` first). Check `/health`.
2. Deploy the web app immediately after. In between, "Sign in with Google" shows an error asking for a reload; it never signs anyone in unsafely, and password sign-in keeps working.
3. Rotate `INTERNAL_TOKEN` if it was ever used in a URL.

The migration marks every account that exists at deploy time as owning its email address, so an existing customer's first Google sign-in links their account and they keep their password, sessions and API keys. Accounts created after the deploy are unproved until a password reset or a Google sign-in proves them. It also adds the table that makes admin "Sign out" revoke the session, and two missing rows in "Tools & limits".

Rollback: redeploy the previous build; the old code runs on the upgraded database. Three things made on the new code do not work on the old code until you roll forward again: webhooks created or rotated on the new code (v2 signatures), sender and integration credentials saved on the new code (new encrypted format), and job-change signals (the old code cannot insert them). Admin sign-outs are not honoured by the old code.

Optional settings and the full notes are in DEPLOY.md section B8.

### Account security (migration 0019)

Also applied on boot, and also additive. It brings opt-in two-factor sign-in for customers, an email confirmation link for new signups, read-only API keys, security emails (password changed, two-factor changed, new API key, sign-in from a new address) and a Security tab in the admin dashboard. Existing customers are not asked for anything.

- The confirmation link and the security emails need the platform mail provider from Step 4. Without one they are not sent and nobody is restricted.
- **Turn on the admin second factor:** create a base32 secret (`openssl rand 20 | base32`), add it to an authenticator app as a time-based account ("Enter a setup key"), keep a copy in your password manager, and set it as `ADMIN_TOTP_SECRET` on the API service. The `/admin` login then asks for the 6-digit code after the password. Step-by-step, and what to do when a phone is lost, in DEPLOY.md section B9.
- A customer who has lost both their phone and their recovery codes can only be let back in by you: Admin > the workspace > the user > "Reset two-factor". Confirm it is really them first.
- Rolling back: read-only API keys are treated as full-access keys by the old code - revoke them first if you roll back for long. Details in DEPLOY.md section B9.

## Operating

- Admin: the dashboard at `/admin` (sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`), or `GET /v1/admin/orgs` and `PATCH /v1/admin/orgs/:id/plan` with header `x-admin-token: $ADMIN_API_TOKEN` to list orgs and change plans/limits. `INTERNAL_TOKEN` is only the job runner's token and does not open the admin API. Every admin change is recorded in the workspace's security log.
- Secrets: `JWT_SECRET` at least 32 random characters; keep `ENCRYPTION_KEY` set, and when rotating it list the previous value in `ENCRYPTION_KEYS_OLD` or every saved sender/integration credential becomes unreadable; optional `ADMIN_JWT_SECRET` signs the admin session separately; optional (recommended) `ADMIN_TOTP_SECRET` adds an authenticator code to the admin login. If `INTERNAL_TOKEN` was ever used in a URL, rotate it in the Render dashboard. Full table in DEPLOY.md section A8.
- Invite-only signup: set `PILOT_INVITE_CODE`.
- Logs: Render dashboard. Job failures are stored on the `jobs` row (`error`, `attempts`) and retried with backoff.
- Backups: Neon retains point-in-time recovery even on the free tier for a few days; for longer retention, a free `pg_dump` cron job is the zero-cost option.
- Scaling past free: Neon Launch (~$19/mo, no pause/suspend limits), Render Starter ($7, always-on, no cold start), Google CSE $5/1k queries past the free 100/day. The code needs no changes for any of this; add a second worker process (`npm run start:worker`) and set `EMBED_WORKER=false` on the web service once traffic justifies splitting them.
