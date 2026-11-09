# Scout Security: Actions Required by Platform Owner
**Generated:** November 9, 2026  
**Auditor Reference:** Enterprise Security Audit `audit/hardening-2026-11-09`

The following items require administrative access, third-party vendor dashboard logins, or strategic business authorization that cannot be executed autonomously by automated tooling.

---

## 1. Third-Party Vendor Dashboard Key Rotations

> [!NOTE]
> During git history and source code scanning, no live production secret was found exposed in the client build or public repository. However, mock tokens and placeholder API keys were present in unit tests. To maintain pristine hygiene and guarantee compliance:

### 1.1 Stripe Secret & Webhook Keys
* **Provider:** Stripe Dashboard (`dashboard.stripe.com/apikeys` and `/webhooks`)
* **Impact if Ignored:** Potential invoice/payment interception or unauthorized refund issuance if old staging keys were reused.
* **Exact Dashboard Steps:**
  1. Navigate to Stripe Dashboard > **Developers** > **API keys**.
  2. Under "Secret key", click **Roll key**. Select an expiration window of 24 hours for the previous key.
  3. Copy the new key (`sk_live_...`).
  4. Navigate to Render Dashboard (`dashboard.render.com`) > `getleads-api` service > **Environment**.
  5. Update `STRIPE_SECRET_KEY` with the newly rolled value and trigger a deploy.
  6. Under Stripe Dashboard > **Webhooks**, rotate the Signing Secret (`whsec_...`) and update `STRIPE_WEBHOOK_SECRET` on Render.
* **Recommended Deadline:** Within 7 calendar days.

### 1.2 Resend / SMTP Sending Credentials
* **Provider:** Resend (`resend.com/api-keys`) or Custom SMTP Host
* **Impact if Ignored:** Risk of cold outreach reputation damage if staging keys were ever shared or leaked.
* **Exact Dashboard Steps:**
  1. Log into `resend.com` > **API Keys** > **Create API Key** (Permissions: Sending Access only).
  2. In Render Dashboard > Environment, update `RESEND_API_KEY`.
  3. Revoke the prior API key from the Resend console.
* **Recommended Deadline:** Within 14 calendar days.

---

## 2. Production Infrastructure Configuration

### 2.1 Enforce SSL Mode on Database Connection Strings
* **Provider:** Neon (`console.neon.tech`) / Supabase (`app.supabase.com`)
* **Requirement:** Ensure `DATABASE_URL` in Render environment has `?sslmode=require` or `?sslmode=verify-full`.
* **Action:**
  1. Check the Render environment variable `DATABASE_URL`.
  2. Confirm the URI terminates with `?sslmode=require`. Neon endpoints automatically support certificate verification via public CAs supported natively by Scout's `ssl.ts`.

### 2.2 Configure Trusted Proxy Header
* **Provider:** Render Dashboard
* **Requirement:** Set `TRUSTED_PROXY=cloudflare` on the API service to guarantee that `clientIp()` reads client IP from Cloudflare's trusted headers and prevents rate-limit / lockout spoofing.
* **Action:**
  1. In Render > `getleads-api` > **Environment**, set `TRUSTED_PROXY=cloudflare`.
  2. Save and redeploy.

---

## 3. Business & Product Decisions

### 3.1 14-Day Free Trial Restrictions vs. Feature Gating
* **Context:** Free trial accounts running unconstrained credits on expensive third-party APIs (Apollo, Hunter, Serper, LLMs) can lead to substantial platform infrastructure expense.
* **Decision Options:**
  - **Option A (Recommended):** Zero-credit trial tier. Allow trial users to freely test built-in CRM, pipeline visualizer, campaign builders, and digital sales rooms without consuming credits. Require credit card or paid subscription to execute live waterfall lookups or automated outreach.
  - **Option B:** Strict credit ceiling (e.g. 25 free credits total, non-renewable) with automated disposable email blocking.
* **Action Required:** Confirm desired credit ceiling policy for new signups.

### 3.2 Workspace Deletion Grace Period
* **Context:** `apps/api/src/routes/account.ts` currently provides a scheduled deletion grace period allowing users to cancel an accidental deletion before records are purged.
* **Decision:** Keep the standard 7-day grace period or shorten to immediate deletion upon 2FA verification.
* **Action Required:** Confirm if enterprise customers require a shorter or custom data retention window.
