# Pricing & unit economics

This is the answer to "if we buy real provider keys instead of free ones, what do we actually pay per lead, and what should we charge." Numbers below are from live provider pricing pages checked September 2026, not estimates. Provider pricing changes; re-check before finalizing contracts.

## Bootstrapping without prepaying for anything (Sept 15 2026 - do this first)

You do not have to subscribe to Apollo Professional or Hunter Growth before you have a single paying customer. Two things make that true, one already built and one a sourcing choice:

1. **Already true, verified in code:** an org's `premiumLeadsPerMonth` only changes when Stripe's `checkout.session.completed` webhook fires (`apps/api/src/routes/misc.ts`) or you set it manually via the admin endpoint. There is no path where a customer draws paid-provider budget before their payment has actually cleared. You are never spending ahead of revenue - the gating described below in "What's built to support this" already enforces it.
2. **The actual gap was the vendor choice, not the code:** Apollo Professional ($79/user/mo) and Hunter Growth are subscription products - Growth's cheaper $104/mo rate specifically requires committing to annual billing, which is exactly the commitment you said you don't want to make before you have revenue. Don't buy either yet.

The bootstrap path:

- **Day one, $0:** run entirely on the free tiers already wired in `.env.example` - Apollo's free plan, Hunter's free 25 searches/50 verifications per month, PDL's free 100/month, all pooled platform-wide. This covers your very first premium-lead usage (Starter's 150/month sub-quota) partially, maybe fully depending on how many customers convert at once, at zero commitment.
- **When a real paying customer's premium usage would exceed that free pool:** top up with a genuine pay-as-you-go vendor instead of a subscription - buy a one-time credit pack with a card, no recurring commitment, credits typically don't expire. Bookyourdata is a confirmed example of this model: no subscription required, credits never expire, and they give 10 free credits with no card to test before you buy anything (per their own pricing page, checked Sept 2026). There are others in this category (FullEnrich, Lusha, and similar credit-pack vendors) with slightly different rollover/expiry terms - worth comparing before you pick one, since I only have directional per-credit pricing for these from third-party roundups, not their live rate cards.
- **Only once volume is consistent and predictable** (say, several Growth/Scale customers sustaining real monthly premium usage) does a subscription like Apollo Professional or Hunter Growth start making sense - at that point the per-credit cost drops enough to matter, and you have revenue already in hand to justify the commitment.
- Practically: charge the customer via Stripe first (already how checkout works), let that revenue land, then buy exactly the credits their usage needs from a PAYG vendor. You are always spending your customer's money, never your own speculative float.

Once you pick a specific PAYG vendor, I'll pull their actual API reference and wire it into `packages/core/src/providers/people.ts` as another `PeopleProvider` in the fallback chain (checked before or after Apollo/Hunter/PDL, your call) - gated by the same `remainingPremiumBudget()` mechanism already protecting the others. I'm not writing that integration against the vendor's API sight-unseen off a marketing page; better to confirm their actual request/response shape first so it doesn't silently fail in production.

## Provider cost per unit (paid tier, moderate volume)

| Unit | Provider | Plan used for this math | Cost per unit |
|---|---|---|---|
| Enriched/exported lead | Apollo.io Professional | $79/user/mo, 2,000 export credits | ~$0.04 |
| Email verification | Hunter.io Growth (annual) | $104/mo (billed annually), 10,000 credits | ~$0.01 |
| Search query | Brave Search API | $5 per 1,000 queries (flat, no free tier as of Feb 2026) | ~$0.005 |
| AI message (personalization/parsing) | Groq/Gemini free tiers first, Anthropic overflow | Free up to ~14k Groq + 1.5k Gemini req/day pooled | ~$0 until you're past ~15k AI calls/day, then a few cents/1k tokens |
| Outbound email send | Resend Pro | $20/mo, 50,000 emails | ~$0.0004 |

Important correction to the earlier free-tier build: **Brave killed its free API tier in February 2026.** It's now metered from the first query above a $5/month credit. The zero-cost pilot stack should lean on Google Programmable Search (100 free queries/day, still free) as primary, and DuckDuckGo/Bing HTML scraping as fallback, with Brave treated as a small paid line item ($5-15/month) even in the "free" pilot, not a free one. `.env.example` and DEPLOY.md are updated to reflect this.

## Why you cannot just copy the pilot plan limits into paid pricing

`packages/db/src/plans.ts` originally had Pro at $49/mo for 2,500 leads and Business at $199/mo for 20,000 leads. Those numbers were sized for a $0-cost pilot where "leads" mostly come from free web search + your own site-crawl enrichment (near-zero marginal cost). If every one of those leads instead resolves through paid Apollo/Hunter credits at ~$0.05 all-in (export + verification), the COGS alone is:

- Pro: 2,500 leads x $0.05 = ~$125 in provider costs against $49 of revenue. **Loss-making.**
- Business: 20,000 leads x $0.05 = ~$1,000 against $199. **Badly loss-making.**

This is the actual trap in this business model: your dashboard and pipeline abstract the provider away from the customer, but the provider's meter doesn't disappear, it just moves to your bill. Pricing has to be built around blended sourcing, not against raw provider list price.

## The fix: two-tier sourcing, already built into the pipeline

The pipeline (`packages/core/src/pipeline.ts`) already checks paid data providers first and falls back to free web discovery + your own crawl-based enrichment. Keep that order, but cap what fraction of a plan's quota is allowed to hit paid providers:

- **Standard leads** (the bulk of every plan's quota): sourced via search engine discovery + your own website crawl for enrichment + built-in pattern-based email finding + MX/SMTP verification. Marginal cost is close to $0 (just your search query cost, ~$0.005-0.01/lead).
- **Verified/premium leads** (a smaller sub-quota per plan): allowed to consume an Apollo/Hunter/PDL credit for a materially better hit rate and verified-not-guessed emails. This is metered separately in the `usage` table (add a `premiumLeadsPerMonth` column alongside the existing `leadsPerMonth`) so a customer can't silently burn your whole Apollo allotment through the standard flow.

This mirrors what Apollo/Clay/Clearbit actually do: cheap discovery for volume, paid waterfall credits gated as a premium action.

## Paid tiers (live in plans.ts, >=85% gross margin)

| Plan | Price | Total leads/mo | Premium (provider) leads/mo | Verifications/mo | Searches/mo | AI msgs/mo | Seats | Est. COGS | Est. gross margin |
|---|---|---|---|---|---|---|---|---|---|
| Starter | $109/mo | 1,500 | 150 | 500 | 500 | 500 | 2 | ~$14.80 | ~86.4% |
| Growth | $359/mo | 6,000 | 500 | 1,500 | 2,000 | 1,500 | 5 | ~$49.70 | ~86.2% |
| Scale | $1,199/mo | 20,000 | 1,500 | 5,000 | 8,000 | 8,000 | 15 | ~$178 | ~85.2% |
| Enterprise | $3,199/mo | 60,000 | 5,000 | 15,000 | 25,000 | 25,000 | 50 | ~$473 | ~85.2% |

Free/Pilot: `premiumLeadsPerMonth = 0` - these orgs only ever get web-discovery + site-crawl leads, so they cost nothing to run beyond a fraction-of-a-cent search query per lead. That's the literal implementation of "for the free version, get them leads wherever we can from scraping/their website, at no cost to us."

COGS math per tier is in the comments right above each plan in `packages/db/src/plans.ts`, so the number and the code it prices never drift apart. Standard (non-premium) leads are costed inside the `searchesPerMonth` line, not double-counted; AI stays ~free at these volumes on pooled Groq/Gemini free tiers; email send cost is under a dollar a month per plan and is folded into the total. Enterprise assumes ~20% cheaper per-unit provider costs from negotiated volume pricing (Apollo Organization, Hunter Scale), which is stated explicitly rather than hidden in the number.

At 100 customers on a Growth-equivalent mix, provider spend lands around $5,000/month against roughly $33,000/month revenue - and real average utilization (most customers never touch their full quota) pushes actual margin higher than the worst-case numbers above, which assume every customer maxes out every metric.

## What's built to support this (done)

1. `packages/db/src/schema.ts` / `plans.ts`: `premiumLeadsPerMonth` limit alongside `leadsPerMonth`, metered as its own quota via a new `premiumLeads` usage metric.
2. `packages/core/src/pipeline.ts`: `runLeadPipeline()` takes `maxProviderLeads` and only calls `searchProviders()` (Apollo/Hunter/PDL) up to that many results; 0 skips provider calls entirely and falls straight to free web discovery + site-crawl enrichment.
3. `packages/db/src/usage.ts`: `remainingPremiumBudget(db, orgId)` computes an org's remaining provider-lead budget for the period (explicitly 0 when the plan limit is <= 0, unlike the generic quota convention); `consumeLead(db, orgId, source)` records a lead against `leads` and, only when `source` starts with `"provider:"`, against `premiumLeads` too.
4. Every lead-producing endpoint (`/v1/search`, `/v1/search/quick`, `/v1/agent/prospect`, the `search.run` and `savedsearch.run` jobs, autopilot) now checks the org's remaining premium budget before calling `runLeadPipeline`, and meters correctly afterward. The two single-lookup provider tools (`linkedin-to-email`, `email-to-linkedin`) are gated the same way.
5. `apps/api/src/routes/misc.ts` billing checkout now accepts any plan id in `plans.ts` and resolves its Stripe price from `STRIPE_PRICE_<PLAN>`, so adding a 5th tier later needs no code change, just an env var and a Stripe price.

Dashboard: Settings → Usage already renders every metric in `/v1/usage` generically, so `premiumLeads` shows up automatically as its own tile ("Premium Leads 12 / 150") next to the total lead count - no separate UI work was needed.
