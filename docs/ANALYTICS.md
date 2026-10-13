# Product analytics and checkout follow-up

Scout counts its own funnel (visits to paid) for the admin "Growth" tab, and can send one
reminder email for a checkout that was started and not finished. Both are additive (migration
0023) and both are built so that no personal data travels where it is not needed.

## What is recorded

`product_events` (written by `apps/api/src/lib/productEvents.ts`, `trackProduct`):

| Event | Where it comes from | Carries |
| --- | --- | --- |
| `page_view`, `pricing_viewed` | public beacon `POST /v1/public/pv` | path, referrer host, utm tags. No org, no user, no IP |
| `signup`, `login_succeeded`, `login_failed`, `email_verified`, `api_key_created` | auth routes | org and user ids (`login_failed`: neither) |
| `activated` | first lead saved (once per workspace, `markActivated`) | org id |
| `checkout_started`, `checkout_completed`, `checkout_abandoned`, `subscription_cancelled` | billing routes, Stripe webhook, follow-up run | org id, plan |

Props are allow-listed (`plan, method, source, medium, campaign, referrer_host, reason, kind,
scope`), scalar, at most 80 characters, and any value containing "@" is dropped.
`trackProduct` never throws: a failed write is one warning line with the event name only.

## The public beacon

`apps/web/src/lib/pageview.ts` sends `{ path, ref, utm_* }` as `text/plain` with
`navigator.sendBeacon` (or `fetch` with `keepalive`). It sets no cookie, uses no storage, and
sends nothing when the browser has Do Not Track or Global Privacy Control on. It is called on
the landing page (`/`), the sign-up page (`/signup`) and once when the pricing section is on
screen (`/pricing`, recorded as `pricing_viewed`).

The API side always answers 204 with an empty body. It ignores the request entirely when the
`DNT: 1` or `Sec-GPC: 1` header is present, when the body is over 2 KB or not JSON, when the
path does not start with "/", or when the caller's address is over 30 views a minute. The
query string and fragment are cut from the path (200 characters at most). Only the host of
`ref` is kept, and our own hosts (APP_URL, API_URL) are dropped. The IP is used in memory for
the rate limit only and is never stored.

## Checkout sessions

`POST /v1/billing/checkout` stores a `checkout_sessions` row (open, Stripe session id, plan,
user). The Stripe webhook moves it to `completed` on `checkout.session.completed` and to
`expired` on `checkout.session.expired`; a replayed event changes nothing. Enable the
`checkout.session.expired` event on the Stripe webhook endpoint for the expired state.

## Follow-up email

| Variable | Values | Default |
| --- | --- | --- |
| `CHECKOUT_FOLLOWUP` | `off`, `dry_run`, `on` | `off` |
| `CHECKOUT_FOLLOWUP_AFTER_HOURS` | 1-168 | 24 |

The hourly job `checkout.followup` looks at sessions that are open or expired, have no
follow-up outcome, and were started at least AFTER_HOURS ago. Each gets exactly one outcome in
`followup_status`, claimed with `UPDATE ... WHERE followup_status IS NULL`:

- `sent`, `dry_run`, `failed`, `failed:no_mailer`
- `skipped:off` (mode off), `skipped:completed_later`, `skipped:plan_already`,
  `skipped:too_old` (over 7 days), `skipped:org_inactive`, `skipped:no_user`,
  `skipped:unverified`, `skipped:opted_out`, `skipped:suppressed` (platform do-not-contact
  list, plus-tag aware), `skipped:recent_followup` (one reminder per workspace per 14 days)

`checkout_abandoned` is recorded once per session judged abandoned, in every mode (not for
`completed_later` or `plan_already`). The email goes to the person who started the checkout,
through the platform mailer, in plain text:

> You started upgrading <workspace> to <Plan> but didn't finish. Pick up where you left off:
> <APP_URL>/settings/billing

It carries a one-click unsubscribe link,
`GET|POST /v1/public/email-opt-out?u=<userId>&k=checkout_followup&s=<hmac>`, signed with a key
derived from JWT_SECRET (HKDF, used for nothing else), and a `List-Unsubscribe` header. A bad
signature is a 400 and changes nothing. Rotating JWT_SECRET invalidates links already sent.

## Admin

- `GET /v1/admin/analytics/funnel?days=7|30|90`: step counts, step-to-step conversion, daily
  series, top referrer hosts and utm sources, sign-in counts, active API keys and keys used.
- `GET /v1/admin/checkouts?status=open|completed|expired|abandoned&limit=`: sessions with the
  workspace, plan, status, follow-up outcome and the owner's address.
- `POST /v1/admin/checkout-followup/preview`: what a run would do now, and the first email.
  Writes nothing.
- `POST /v1/admin/checkout-followup/test`: sends the sample to ADMIN_EMAIL only.

## Retention

`product_events` rows go after 395 days and `checkout_sessions` rows after 400 days, in the
six-hourly retention pass (`PRODUCT_RETENTION` in `apps/api/src/lib/privacyRetention.ts`).
