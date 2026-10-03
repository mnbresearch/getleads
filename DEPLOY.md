# Prospex - Compiled Deployment Guide

This is the single document you need. Part A lists exactly what to give me (or paste into the env). Part B is the deploy procedure. Part C is the feature map so you know what each key unlocks.

**Decision made: production path.** Paid plans (Starter/Growth/Scale/Enterprise) go live for real signups, on free-tier infrastructure and free-tier data-provider keys - no Apollo Professional / Hunter Growth prepayment. `render.yaml` is already configured for this (`PILOT_MODE=false`, `DEFAULT_PLAN=free`, Stripe env vars wired). The one item this path adds versus a pure pilot is Stripe (A7 below) - without it, paid tiers exist in the dashboard but the "Upgrade" button won't render. Everything else is unchanged: the code already guarantees you can't spend provider budget on a customer's behalf before their Stripe payment clears (checked in `apps/api/src/routes/misc.ts`'s webhook handler), and you top up a real data-provider only once a paying customer's usage needs more than the free-tier pool - see "Bootstrapping without prepaying" in [docs/PRICING.md](docs/PRICING.md).

**One thing that changed since the pilot build:** Brave Search API killed its free tier in February 2026 - it's now metered from the first query above a $5/month credit. Google Programmable Search (100 free queries/day) is now the primary free search key; Brave is a small paid line item ($5-15/month) even on the pilot path.

---

## Part A - What you need to provide

Create these accounts and send me the values (or fill `.env` yourself). Items marked REQUIRED are the minimum for a working deployment. Everything else unlocks a feature and is optional; the platform degrades gracefully without it. Each key in A3/A4 is tagged **[Free tier]** or **[Paid tier]** - for the production path, use the paid-tier column.

### A1. Infrastructure (REQUIRED) - one decisive pick per row, chosen for generous free limits + a clean upgrade path, not the cheapest option that breaks later

| # | What | Sign up at | Why this one | Send me |
|---|---|---|---|---|
| 1 | Postgres database | **neon.tech** → New project (free, 0.5GB, autoscaling branch-per-env) → Dashboard → Connection Details → pick the **pooled connection** string | Neon's free compute suspends when idle but never deletes data or breaks the app - reconnects automatically on the next request. Supabase's free tier instead pauses the *entire project* (including auth) after 7 days idle and needs a manual dashboard click to restore, which is a bad look mid-demo. Upgrading later (Neon Launch, ~$19/mo) is a plan change, not a migration. | `DATABASE_URL` |
| 2 | API + worker hosting | **render.com** → New → Web Service (free tier) → connect the GitHub repo. Sign up with GitHub | Free web services get 750 instance-hours/month (enough for one always-on service) and sleep after 15 min with no traffic (~1 min cold start on wake) - fully solved with a free uptime pinger (step B3 below), so it behaves like an always-on service at $0. Fly.io no longer has a free tier for new accounts as of 2026 (legacy-only), so it's not a genuinely free option anymore - worth revisiting once you're paying anyway and want real SMTP verification (see A4/A5 note). | Confirm the repo is on GitHub; I can deploy from this session |
| 3 | Dashboard hosting | **vercel.com** (free, generous static/SPA hosting, painless custom domains). Sign up with GitHub | Free tier has no practical limit for a dashboard's traffic level; upgrading is a billing toggle, not a migration | Confirm account exists (I have a Vercel connector in this session and can deploy it) |
| 4 | GitHub repo | Create an empty private repo, e.g. `mnb-research/prospex` | - | Repo URL + push access, or I hand you the zip to push |
| 5 | A domain (optional but recommended) | e.g. `prospex.mnbresearch.com` for the app, `api.prospex.mnbresearch.com` for the API | - | Domain + DNS access (Cloudflare recommended) |

### A2. AI (REQUIRED for personalization, ICP building, query parsing; at least one)

| # | Provider | Free tier | Where | Send |
|---|---|---|---|---|
| 6 | Groq (recommended, fast) | ~14k requests/day, Llama 3.3 70B | console.groq.com → API Keys | `GROQ_API_KEY` |
| 7 | Google Gemini (fallback) | 1,500 requests/day | aistudio.google.com → Get API key | `GEMINI_API_KEY` |
| 8 | Anthropic (best quality, paid) | pay-as-you-go | console.anthropic.com | `ANTHROPIC_API_KEY` (optional) |

### A3. Lead discovery search (REQUIRED for reliable prospecting; at least one)

Without a key the platform falls back to keyless DuckDuckGo/Bing scraping, which is bot-gated from cloud IPs and returns sparse results.

| # | Provider | Tier | Cost | Where | Send |
|---|---|---|---|---|---|
| 9 | Google Programmable Search (recommended free) | **[Free tier]** | 100 queries/day free | 1) programmablesearchengine.google.com → Add → "Search the entire web" ON → copy **Search engine ID** 2) console.cloud.google.com → APIs → Custom Search JSON API → Enable → Credentials → API key | `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` |
| 9b | Brave Search API | **[Paid tier]** | No free tier since Feb 2026 - $5/1,000 queries, $5/mo minimum credit | brave.com/search/api → add billing card | `BRAVE_SEARCH_API_KEY` |
| 10 | SerpAPI (optional third, free) | **[Free tier]** | 100 searches/month free | serpapi.com | `SERPAPI_KEY` |

### A4. Data providers (database-quality results, used before web search)

| # | Provider | Tier | Cost | Where | Send |
|---|---|---|---|---|---|
| 11 | Apollo.io free | **[Free tier]** | free plan credits (people search + enrich, small volume) | app.apollo.io → Settings → Integrations → API | `APOLLO_API_KEY` |
| 11b | Apollo.io Professional | **[Paid tier]** | $79/user/mo, 2,000 export credits (~$0.04/lead) - see docs/PRICING.md | same, upgrade plan first | `APOLLO_API_KEY` |
| 12 | Hunter.io free | **[Free tier]** | 25 domain searches + 50 verifications/month | hunter.io → API | `HUNTER_API_KEY` |
| 12b | Hunter.io Growth (annual) | **[Paid tier]** | $104/mo annual, 10,000 credits (~$0.01/verification) | same, upgrade plan first | `HUNTER_API_KEY` |
| 13 | People Data Labs | **[Free tier]** | 100 person enrichments/month free; paid tiers scale per-record | peopledatalabs.com | `PDL_API_KEY` |
| 14 | Abstract email validation | **[Free tier]** | 100/month free | abstractapi.com → Email Validation | `ABSTRACT_EMAIL_API_KEY` |
| 15 | ipinfo.io | **[Free tier]** | 50k IP lookups/month free (visitor identification; keyless ipapi.is is default) | ipinfo.io → token | `IPINFO_TOKEN` |

For the production path, only Apollo and Hunter need the paid tier to start - PDL/Abstract/ipinfo free tiers are generous enough to stay free even at moderate volume. Full cost-per-lead math and recommended customer pricing tiers: [docs/PRICING.md](docs/PRICING.md).

### A5. Email sending (REQUIRED for campaigns; one platform-wide, customers can add their own)

| # | Provider | Free tier | Where | Send |
|---|---|---|---|---|
| 17 | Resend (recommended) | 3,000 emails/month, 100/day | resend.com → API Keys; Domains → add + verify your sending domain (DNS records) | `RESEND_API_KEY`, `MAIL_FROM` (e.g. `Prospex <hello@prospex.mnbresearch.com>`) |
| 18 | Brevo SMTP (alternative) | 300 emails/day | brevo.com → SMTP & API | `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS` |

Inbound replies (so sequences stop on reply): in Resend → Webhooks, or via Zapier/Make Gmail trigger, POST `{from, subject, text}` to `https://<api>/v1/campaigns/inbound` with the customer's API key.

### A6. Channels (OPTIONAL)

| # | Provider | Free tier | Where | Send |
|---|---|---|---|---|
| 19 | WhatsApp Cloud API | 1,000 service conversations/month | developers.facebook.com → Create app → WhatsApp → API setup → Phone number ID + permanent token; create and get approval for a template with one `{{1}}` body variable | Configured per customer in Settings → Integrations → WhatsApp (phoneNumberId, accessToken, templateName) |

### A7. Billing - REQUIRED for the production path (this is what makes paid signups actually work)

Without Stripe configured, the dashboard still shows all plans but no "Upgrade" button renders - so this is the one item that turns "free demo" into "customers can actually pay you." No data-provider spend is needed to set this up; it only touches Stripe and your own database.

1. dashboard.stripe.com → Product catalog → New product, four times, each with one **recurring monthly** price:
   - "Prospex Starter" - $99.00/month
   - "Prospex Growth" - $329.00/month
   - "Prospex Scale" - $1,099.00/month
   - "Prospex Enterprise" - $2,999.00/month (usually custom-quoted in practice, but a real Stripe price still needs to exist for the checkout button to work)
2. Copy each price's ID (starts `price_...`) into `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE`, `STRIPE_PRICE_ENTERPRISE` respectively - these map 1:1 to the plan ids already in `packages/db/src/plans.ts`, no code change needed if the names match exactly.
3. Developers → API keys → copy the **secret key** → `STRIPE_SECRET_KEY`.
4. Developers → Webhooks → Add endpoint → `https://<your-api>/v1/billing/webhook` → select events `checkout.session.completed` and `customer.subscription.deleted` → copy the **signing secret** → `STRIPE_WEBHOOK_SECRET`.
5. Send me all six values: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE`, `STRIPE_PRICE_ENTERPRISE`.

You can start in Stripe **test mode** (test-mode keys, e.g. `sk_test_...`) to verify the whole checkout → webhook → plan-upgrade flow end to end before flipping to live keys - costs nothing and catches config mistakes before a real customer hits them.

### A8. Secrets I generate for you (no action needed)

`JWT_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_TOKEN`, `ADMIN_API_TOKEN` - generated as long random values at deploy time (`render.yaml` does this). What each one is for:

| Variable | What it guards | Notes |
|---|---|---|
| `JWT_SECRET` | Every customer session | At least 32 random characters (`openssl rand -hex 32`); the API warns at startup if it is shorter and refuses to start on the built-in default. Rotating it signs every user out once. |
| `ENCRYPTION_KEY` | Stored SMTP passwords, CRM tokens, webhook secrets | Set it. Without it those are encrypted under `JWT_SECRET`. To rotate: put the new value in `ENCRYPTION_KEY` and the old one in `ENCRYPTION_KEYS_OLD` (comma-separated, newest first). Reads try every listed key; new writes use `ENCRYPTION_KEY`. Dropping the old value without listing it makes every saved sender and integration unreadable. |
| `INTERNAL_TOKEN` | `/internal/jobs/run` only (the serverless job runner) | Sent in the `x-internal-token` header, never in the URL. It is **not** an admin credential. The Render deployment (embedded worker) does not call this endpoint at all. |
| `ADMIN_API_TOKEN` | Server-to-server calls to `/v1/admin/*` (header `x-admin-token`) | Separate from `INTERNAL_TOKEN`. Leave it unset and the header path is off; the admin dashboard's password login still works. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | The admin dashboard login | Use a long random password. Five wrong attempts from one address lock that address for up to 15 minutes; fifty wrong attempts in 15 minutes lock the form for every address that has not signed in before. An address you have signed in from keeps working either way. "Sign out" in the dashboard revokes the session on the server. |
| `ADMIN_JWT_SECRET` (optional) | Signs the admin dashboard session | Falls back to `JWT_SECRET`. Setting it means a leak of `JWT_SECRET` alone cannot mint an admin session. |
| `ADMIN_TOTP_SECRET` (optional, recommended) | A second factor on the admin dashboard login | A base32 secret that you also add to an authenticator app. When set, signing in to `/admin` needs the current 6-digit code as well as the password. Unset, the login is email + password as before. How to create it: section B9, "Admin two-factor sign-in". |

**If `INTERNAL_TOKEN` was ever put in a URL** (the old cron instructions said `?token=`), treat it as leaked - URLs are written to access logs and cron dashboards - and rotate it: Render → the API service → Environment → `INTERNAL_TOKEN` → generate a new value → save. Nothing else needs to change on Render.

### A9. Pilot policy decisions (tell me)

- Invite-only signup? If yes, choose an invite code → `PILOT_INVITE_CODE`.
- Default plan for new signups: `pilot` (1,000 leads/mo, 300 searches, 2,000 verifications, 1,000 AI messages, 1,500 emails, 5 campaigns, 3 seats) or something else. Adjustable later per org via admin API without redeploy.
- Region for the API: Render's Singapore region is closest to India for lowest latency.

**Minimum to go live on the production path today: items 1, 2, 3, 4, 6, 9, 17, and A7 (Stripe).** Items 11/12/13 (free-tier data providers) are worth adding too since they feed the premium-lead sub-quota on paid plans, but aren't blocking - the platform runs on web-discovery leads alone without them. You don't need 11b/12b (paid Apollo/Hunter subscriptions) at all to start; add a paid data-provider key only once real customer volume needs it, bought as pay-as-you-go credits rather than a subscription until volume is consistent - see docs/PRICING.md.

---

## Part B - Deploy procedure

### B1. Push the code
```bash
unzip prospex.zip && cd prospex
git init && git add -A && git commit -m "Prospex v2"
git remote add origin git@github.com:<you>/prospex.git && git push -u origin main
```

### B2. Database
Paste the Neon pooled connection string into `DATABASE_URL`. Migrations run automatically on API boot (`AUTO_MIGRATE=true` by default). Every file in `packages/db/migrations` is applied once, in order, and recorded in the `_migrations` table. (Using Supabase instead works identically - just note its free project pauses after 7 days idle and needs a manual unpause click.)

### B3. API + worker

**Option 1 - Render (recommended, simplest genuinely-free option).** Dashboard → New → Blueprint → pick the repo; `render.yaml` is detected. Set the `sync: false` env vars from Part A. The single web service runs the API and the embedded worker (`EMBED_WORKER=true`). Add the health URL `https://<service>.onrender.com/health` to a free uptime monitor (UptimeRobot / cron-job.org, every 10 min) so the free instance does not sleep and the scheduler keeps running. Render blocks port 25: keep `SMTP_PROBE_ENABLED=false` (emails verify as `risky` = MX + pattern; add Hunter/Abstract keys for `valid`).

**Option 2 - Vercel serverless (API too).** Works, but background jobs need `JOB_MODE=inline` plus an external cron hitting `GET https://<api>/internal/jobs/run` every minute (cron-job.org) **with the request header `x-internal-token: <INTERNAL_TOKEN>`** (cron-job.org: edit the job → Advanced → Headers → add key `x-internal-token`). The token is not accepted in the URL (`?token=` answers 403): a secret in a URL ends up in every access log on the way. Also set `TRUSTED_PROXY=xff` there (see B3a). Prefer Render for the worker unless you specifically want everything on Vercel.

**Once you're paying anyway and want real SMTP-verified emails** (not the free-tier MX+pattern `risky` check): Fly.io no longer has a free tier for new accounts (pay-as-you-go from the first machine, roughly $2-3/month for a small instance), but it's worth it at that point specifically because it allows outbound port 25 on request, which Render blocks entirely.
```bash
fly launch --no-deploy --copy-config
fly secrets set DATABASE_URL=... JWT_SECRET=$(openssl rand -hex 32) ENCRYPTION_KEY=$(openssl rand -hex 32) INTERNAL_TOKEN=$(openssl rand -hex 24) ADMIN_API_TOKEN=$(openssl rand -hex 24) TRUSTED_PROXY=xff \
  GROQ_API_KEY=... GOOGLE_CSE_API_KEY=... GOOGLE_CSE_CX=... RESEND_API_KEY=... MAIL_FROM="Prospex <hello@yourdomain>" \
  APP_URL=https://prospex.vercel.app API_URL=https://prospex-api.fly.dev SMTP_PROBE_ENABLED=true
fly deploy
```
Then open a support ticket: "please unblock outbound port 25 for app prospex-api (email verification, no bulk sending)". Until approved, set `SMTP_PROBE_ENABLED=false`.

Verify: `curl https://<api>/health` → `{"ok":true,"db":"up"}`; open `https://<api>/docs`.

### B4. Dashboard (Vercel)
Import the repo → Root directory `apps/web` → Framework Vite → Env `VITE_API_URL=https://<api>`. Optionally `VITE_DEMO_VIDEO_ID=<youtube id>` to show the explainer under the hero; unset, that section is not rendered. `apps/web/vercel.json` handles SPA routing. Then set `APP_URL` on the API to the Vercel URL (CORS + links in emails).

### B3a. Network settings the API needs to know about

- `TRUSTED_PROXY` - which proxy header carries the visitor's real address. Rate limits and the security log use it, so a wrong value either lets one person dodge the limits or puts everyone in one bucket.
  - `cloudflare` - use `cf-connecting-ip`. Correct on Render (its edge is Cloudflare, which overwrites the header) and for any domain proxied through Cloudflare. `render.yaml` sets this.
  - `xff` - use the right-most `X-Forwarded-For` entry. Use on Vercel, Fly and other hosts that are not behind Cloudflare; there `cf-connecting-ip` is whatever the client typed.
  - `none` - nothing in front of the API; headers are ignored.
  - Unset: `cloudflare` on Render, `xff` on any other production host.
- `CORS_EXTRA_ORIGINS` - comma-separated browser origins allowed to call the API in addition to `APP_URL` (e.g. a second dashboard domain). `CORS_ALLOW_REGEX` - a regular expression of further allowed origins; by default any `https://*.vercel.app` origin, so Vercel preview deployments keep working. Set it to `none` to turn that off. The API never allows credentialed (cookie) cross-origin requests.
- Request size limits: 1 MB per request, 10 MB for the lead import, 256 KB for the unauthenticated endpoints (sign-in, pixel, unsubscribe). Larger bodies get `413 payload_too_large`.
- Sign in with Google uses a short-lived cookie on the API's own domain (`g_state`) while the browser is at Google. `API_URL` must be the exact public https URL of the API, and the Google console's redirect URI must be `<API_URL>/v1/auth/google/callback`.

### B5. Domains (optional)
CNAME `prospex.<yourdomain>` → Vercel; `api.prospex.<yourdomain>` → Render. Update `APP_URL`, `API_URL`, `VITE_API_URL`. The visitor pixel and tracking links use `API_URL`, so set it before customers install pixels.

### B6. Post-deploy checks (5 minutes)
1. Sign up at the dashboard → you get an API key. On the production path this lands you on the `free` plan (1 seat, 50 leads) like any real customer would - bump your own test org up first so the rest of this checklist isn't blocked by free-tier limits: `curl -X PATCH https://<api>/v1/admin/orgs/<orgId>/plan -H "x-admin-token: $ADMIN_API_TOKEN" -H 'content-type: application/json' -d '{"plan":"growth"}'` (or use the admin dashboard at `/admin`).
2. Settings → Team → invite a colleague (email arrives if Resend/SMTP is set).
3. Find leads → "Founders of fintech startups in Bengaluru" → 25 results in 1-2 min (needs the Google CSE key).
4. Website visitors → New website → paste the snippet on mnbresearch.com → visit /pricing from an office IP → company appears within ~10s.
5. Intent signals → Scan now → live funding/acquisition/leadership news parsed → Find decision makers.
6. Tools → Sender domain health → your sending domain → fix anything below 90 before campaigns.
7. Campaigns → add sender → 3-step sequence (LinkedIn connect → email A/B → WhatsApp or email) → enroll → start.
8. Run `API=https://<api> ./scripts/smoke.sh && ./scripts/smoke-v2.sh` for the full 40-check regression.
9. Settings → Billing → click "Upgrade" on Starter with Stripe in **test mode** first → complete test checkout (card `4242 4242 4242 4242`, any future date/CVC) → confirm the org's plan flips to `starter` and the premium-leads quota shows 150 in Settings → Usage. Only then switch Stripe to live keys.

### B7. Operating
- Admin: `GET /v1/admin/orgs`, `PATCH /v1/admin/orgs/:id/plan {plan, overrides}` with header `x-admin-token: $ADMIN_API_TOKEN` (not `INTERNAL_TOKEN`, which only runs the job queue). `plan` must be a real plan id; `overrides` is a strict partial of the plan limits (whole numbers from 0, or true/false for the switches) and anything else is refused with a message naming the field. A workspace keeps its overrides when only its plan changes; send `"overrides": {}` to clear them. Every admin change is written to the security log of the workspace it touched (Settings → Security log; table `audit_log`), with the value before and after; a request that changes nothing answers `changed: false` and is not logged. Customers see what the operator changed in their security log, never the address it was changed from.
- Free-tier budget for 100 orgs: Google CSE 3k queries/month (100/day) + SerpAPI 100/month ≈ 3,000-3,500 searches/month total, no Brave spend if you skip 9b. If usage is high, lower `searchesPerMonth` in `packages/db/src/plans.ts` (pilot) or add Brave/Apollo paid keys.
- Scaling past free: Neon Launch ~$19/mo (removes the idle-suspend behavior entirely), Render Starter $7 (always-on, no cold start), Google CSE $5/1k queries past the free 100/day. No code changes needed for infra scaling. For scaling the *business* (paid customers, not just infra), see docs/PRICING.md for provider-tier upgrades and plan restructuring - the pilot plan limits in `plans.ts` are not safe to sell at paid-provider cost. Optionally split the worker into its own process (`npm run start:worker`, set `EMBED_WORKER=false` on the web service).
- Logs: Render dashboard. Job failures live in the `jobs` table with `error` and retry with backoff.

### B8. Deploying this release (admin fixes, Google sign-in, migration 0018)

Do it in this order, in one sitting:

1. **Deploy the API first.** On boot it applies migration `0018_grandfather_existing_users.sql` (unless `AUTO_MIGRATE=false`, in which case run `npm run db:migrate` before starting the new code). Check `curl https://<api>/health` answers `{"ok":true,"db":"up"}`.
2. **Deploy the web app immediately after.** In the minutes between the two, the old web app talking to the new API shows an error when someone clicks "Sign in with Google" and asks them to reload. It never signs anyone in unsafely, and password sign-in is unaffected. Reloading after the web deploy fixes it.
3. **Rotate `INTERNAL_TOKEN`** if it was ever sent as `?token=` in a URL (section A8). On Render nothing calls the job runner, so there is nothing else to update; on a serverless deploy, update the header in the cron service.
4. Sign in to `/admin`, open "Tools & limits" and press "Test all keys". The summary now says how many keys were tested and names any provider that holds a key but cannot be tested for free.

What migration 0018 does:

- **Existing accounts keep everything on their first Google sign-in.** "Sign in with Google" takes over a password account whose address was never proved: the password is turned off, sessions are signed out and, for a single-user workspace, API keys are revoked. Before this release nothing recorded that an address was proved, so every existing password account would have been treated that way. The migration marks every account that exists at deploy time as owning its address, so those accounts are simply linked to Google. Accounts created after the deploy are unproved until a password reset or a Google sign-in proves them, and the takeover rule applies to those.
- Adds the `admin_revoked_tokens` table, which is what makes admin "Sign out" real.
- Adds the Reoon and MillionVerifier rows to "Tools & limits".

It is idempotent and only adds things; it can be re-run safely.

**Rolling back.** The previous release runs on the upgraded database, so rolling back is "redeploy the previous build" and nothing needs to be undone in the database. Three things made on the new code do not work on the old code, so check them if you roll back:

- **Webhooks created or rotated on the new code** sign with v2 and keep their secret encrypted. The old code cannot read that secret, so those webhooks stop delivering until you roll forward again (webhooks that were never rotated keep working).
- **Sender and integration credentials saved on the new code** are stored in the new encrypted format, which the old code cannot decrypt. Those senders and integrations show as needing to be reconnected on the old code. Do not reconnect them there; roll forward instead and they work again.
- **Job-change signals** cannot be inserted by the old code (it writes against the old index), so the daily job-change scan logs errors and records nothing until you roll forward. Nothing already stored is lost.

Admin sessions issued by the new code keep working on the old code, but the old code ignores sign-outs: a signed-out admin session works again until it expires (12 hours at most). Rotate `ADMIN_JWT_SECRET` (or `JWT_SECRET` if that is not set) if that matters.

Optional settings that this release reads (all have safe defaults, none is required):

| Variable | What it does | Default |
|---|---|---|
| `ADMIN_JWT_SECRET` | Signs the admin session with its own key | falls back to `JWT_SECRET` |
| `ENCRYPTION_KEYS_OLD` | Previous `ENCRYPTION_KEY` values, so rotating the key does not make saved credentials unreadable | none |
| `TRUSTED_PROXY` | Which proxy header carries the visitor's address (`cloudflare`, `xff`, `none`) | `cloudflare` on Render, `xff` elsewhere |
| `CORS_EXTRA_ORIGINS`, `CORS_ALLOW_REGEX` | Extra browser origins allowed to call the API | `APP_URL`, localhost and `https://*.vercel.app` |
| `LEAD_NOTIFY_EMAIL` | Where upgrade requests are emailed | `ADMIN_EMAIL` |
| `OUTBOUND_SENDING_ENABLED` | `false` pauses every campaign send platform-wide; nothing is lost, sends resume when it is `true` again | `true` |
| `ORG_DAILY_SEND_CEILING` | The most one workspace may send per day across all its senders | 2000 |
| `SYSTEM_SENDER_DAILY_CAP` | The most one workspace may send per day through the shared platform sender | 50, or 1/20 of the plan's monthly emails |
| `AUTO_MIGRATE` | `false` stops the API applying migrations on boot (you then run `npm run db:migrate` yourself before each deploy) | `true` |

### B9. Account security in this release (migration 0019)

Migration `0019_account_security.sql` only adds things (nullable columns and new tables), so the previous release keeps running on the upgraded database. Nothing here changes how an existing customer signs in: every protection is either something a person turns on for themselves, or applies to accounts created from now on.

**What customers get**

- **Two-factor sign-in** (Settings > Security). Opt-in per person. After the password, sign-in asks for a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator - any app that reads a standard QR code). Ten single-use recovery codes are shown once when it is turned on. Sign in with Google is not asked for the code (Google does its own).
- **Email confirmation for new accounts.** A new signup is emailed a link (valid 24 hours). Until they click it the workspace cannot send team invitations or use the shared platform sender; everything else works. Accounts that existed before this release, and accounts created with Google, are already confirmed.
- **Read-only API keys.** A key can be created as "read-only": it can fetch data and cannot change anything. Existing keys are full access, as before.
- **Security emails.** The account owner is emailed when their password is changed or reset, two-factor sign-in is turned on or off, an API key is created, or the account is signed in to from an address it has not used before.

The confirmation link and the security emails are sent through the platform's own mail provider (`RESEND_API_KEY`, or `SMTP_HOST` and friends - section A5). **With no mail provider configured they are simply not sent, and unconfirmed accounts are not restricted in any way** - a deployment can never lock its users behind an email it cannot send. Set a mail provider to get both.

**When a customer has lost their phone AND their recovery codes**

There is one way back in, and it is yours: Admin > the workspace > the user > "Reset two-factor" (`POST /v1/admin/orgs/:id/users/:userId/reset-2fa`). Their password alone then signs them in and they can set two-factor up again. Before you do it, satisfy yourself that the person asking is the account's owner (reply to the address on the account, not to the address the request came from): the reset removes a protection the owner chose. It is recorded in the workspace's security log and the user is emailed that support did it.

**Admin two-factor sign-in (recommended)**

The admin dashboard guards every customer's plan and status behind one password. Add a second factor:

1. Create a secret - 32 base32 characters (letters A-Z and digits 2-7). Either of:
   ```
   node -e "const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';console.log([...require('crypto').randomBytes(32)].map(b=>a[b&31]).join(''))"
   openssl rand 20 | base32
   ```
2. Add it to your authenticator app: "Add account" > "Enter a setup key" (some apps say "Enter key manually"). Account name: `Scout admin`. Key: the secret. Type: time based. (If you prefer to scan a QR code, make one on your own machine from `otpauth://totp/Scout%20admin?secret=<THE SECRET>&issuer=Scout`, for example with `qrencode -t ansiutf8 '<that link>'`. Do not paste the secret into an online QR generator.)
3. Store the secret in your password manager as well. It is the only copy apart from the one on the server, and it is how you add a second phone or replace a lost one.
4. Set it on the server: Render > the API service > Environment > add `ADMIN_TOTP_SECRET` with the secret as its value > save (the service restarts).
5. Sign out of `/admin` and sign in again. After the email and password the form asks for the 6-digit code.

Notes:

- A code works once. If a sign-in fails on the code, wait for the next one (they change every 30 seconds) and check that the phone's clock is set automatically: the codes depend on the time, and one step (30 seconds) either way is tolerated.
- Wrong codes count towards the admin lock exactly like wrong passwords.
- The server-to-server header (`x-admin-token: $ADMIN_API_TOKEN`) is a separate credential and is not asked for a code.
- Lost the phone: add the secret from your password manager to a new phone. Lost the secret too: delete `ADMIN_TOTP_SECRET` (or set a new one) in the Render dashboard; whoever can do that already controls the deployment.
- A value that is not base32 is refused at sign-in with a message saying so, rather than silently ignored; the API also warns about it at startup.

When a mail provider is configured, `ADMIN_EMAIL` is emailed when the admin dashboard is signed in to from an address that has not signed in before, and when the admin login is locked after failed attempts.

**The Security tab in the admin dashboard**

`GET /v1/admin/security/summary` (the last 24 hours: failed sign-ins, locked accounts, refused actions, admin sign-ins, new workspaces, exports, bulk deletions, workspaces waiting to be deleted, the addresses with the most failed sign-ins) and `GET /v1/admin/audit-log` (the security log across every workspace, filterable by workspace, action, result and actor). Both accept the admin session or the `x-admin-token` header.

**Limits that are new**

- New workspaces: 5 an hour and 20 a day from one network address. Past that the signup form says so and asks the person to try later or write to us. (Counted in the API process's memory, like the other rate limits.)
- "Forgot password": one address is mailed at most 3 reset links an hour, whoever asks. The form answers the same either way.

**Rolling back**

Redeploy the previous build; the database needs nothing undone. On the old code:

- **Read-only API keys become full-access keys.** The old code does not know about key scopes and lets any key write. If you roll back for more than a moment, revoke the read-only keys first (`UPDATE api_keys SET revoked_at = now() WHERE NOT ('*' = ANY(scopes)) AND revoked_at IS NULL;`) or tell the customers who created them.
- **Two-factor sign-in is not asked for.** Accounts that turned it on sign in with their password alone until you roll forward; their setting is kept.
- `ADMIN_TOTP_SECRET` is ignored: the admin login is email + password again.
- Email confirmation is not enforced and security emails are not sent.

---

## Part C - What each key unlocks (feature map)

| Feature | Works with zero keys? | Better with |
|---|---|---|
| Natural-language lead search (LinkedIn profiles via search engines) | Sparse (bot-gated) | Google CSE / SerpAPI / Brave, Apollo |
| Company enrichment (website crawl: description, team, emails, tech, socials) | Yes | - |
| Company intelligence (hiring by function, news, intent score) | Yes | - |
| Email finding (pattern inference + candidates) | Yes | Hunter, Apollo, PDL |
| Email verification | MX-only (`risky`) on Render/Vercel; full SMTP (`valid`) once deployed somewhere with port 25 open (Fly.io paid, or a VPS) | Hunter, Abstract |
| ICP scoring (rules) | Yes | - |
| ICP lookalike builder, AI email personalization, reply intent, query parsing | No (template fallback) | Groq / Gemini / Anthropic |
| Website visitor identification (pixel, ISP filtering, intent by page, decision makers) | Yes (ipapi.is keyless) | ipinfo token, Google CSE for decision makers |
| Intent signals (funding, acquisition, hiring, leadership, expansion, launch, partnership) from news, subscriptions that auto-create leads | Yes (Google News RSS) | Google CSE for decision makers |
| Monitors: LinkedIn post engagers, competitor, keyword, company news, job openings | Yes (LinkedIn posts only when publicly served) | - |
| LinkedIn URL → email, email → LinkedIn, colleagues, decision makers by persona | Partial | Brave/Google, Apollo, PDL |
| Sequences: email A/B variants, LinkedIn connect/message tasks, call tasks, WhatsApp, send windows, daily limits, open/click/reply tracking, unsubscribe, auto-stop | Email needs a sender | Resend / SMTP; WhatsApp Cloud API |
| Engagement scoring + lead pipeline status (new → contacted → engaged → replied → qualified → customer) | Yes | - |
| Autopilot (daily autonomous prospecting → list → campaign) | Needs search key | Brave/Google + AI |
| Saved searches with daily email alerts | Needs search key + mail | - |
| Team seats + invites | Yes (invite link shown; email needs mail provider) | Resend |
| Domain deliverability check (SPF/DKIM/DMARC/MX) | Yes | - |
| Webhooks (HMAC), CRM sync (HubSpot, Pipedrive, Zoho, Cortex, generic, Sheets) | Yes | customer's CRM tokens |
| REST API + OpenAPI + SDK + MCP (46 tools) | Yes | - |
| Stripe billing | Off in pilot | Stripe keys |
