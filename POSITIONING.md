# Scout: strategic positioning

Written for the question "is this fundable, and on what basis". Companion to VISION.md,
which holds the product thesis. This one holds the argument an investor actually tests.

---

## 1. The honest starting point

Scout today has a built product, a live deployment, and no customers, no revenue and no
usage history. That is the single most important fact in this document, and every section
below is written around it rather than over it.

A seed investor is not buying the product. They are buying a claim about a market that is
about to exist, plus evidence that this team gets there first. Positioning changes which
claim you are making. It does not substitute for the evidence. **The fastest path to
fundable is not a better deck, it is ten design partners sampling daily**, for reasons
that section 5 makes concrete.

So: use this to decide what to build and who to talk to. Do not use it to decide what to
put on a slide and stop there.

---

## 2. The category claim

> **Search-era SEO measured whether you could be found. Nothing measures whether you get
> recommended. Scout is the system of record for how AI answers talk about a B2B brand,
> tied to the outbound that created the demand in the first place.**

Two things make this a category claim rather than a feature claim:

**The unit of measurement changes.** SEO's unit was a ranked list of ten links, stable
enough to check once a day. An AI answer is a single synthesised recommendation, drawn
from a distribution, different every time you ask. Measuring it is a sampling problem, not
a crawling problem. Tools built on the crawling assumption will report variance as
movement, and their customers will act on noise until they stop trusting the numbers.

**The buyer's journey gained a step nobody instruments.** Outbound creates demand. The
prospect then asks an assistant whether you are any good. That answer either reinforces or
destroys the email that preceded it, and today it is a black hole between "sent" and
"replied".

Scout's specific position inside that: **the only place the outbound outcome data and the
AI answer data sit on one schema.** Prospecting tools optimise the sending and know
nothing about the research moment. Visibility tools measure the research moment and know
nothing about who was contacted or whether it converted.

---

## 3. Why now

Three things are true at once, which is what makes the timing argument rather than a
guess. All three are checkable claims, and you should check them with current numbers
before putting them in front of an investor:

1. **Assistant-mediated research is becoming a normal step in B2B evaluation.** Not
   replacing search, sitting alongside it, at the highest-intent moment.
2. **The answer is a recommendation, not a list.** One or two brands get named. Position
   is close to binary in a way a SERP never was.
3. **Nobody has the correlation data.** Whether appearing in an AI answer actually moves
   pipeline is unanswered, because answering it needs both datasets and nobody holds both.

The window is the gap between "buyers do this" and "a default tool exists". That gap is
measured in quarters, not years.

---

## 4. The moat, stated honestly

**The code is not a moat.** Running prompts against LLM APIs, parsing brand mentions,
scoring ICP fit, drafting replies. A competent team replicates any of it in weeks. Assume
it is copied. Any deck that claims the technology is defensible will be marked down by an
investor who has seen twenty of these.

**Three things are actually defensible, in ascending order of strength:**

**a) Un-backfillable time series.** Visibility is a measurement of a moment. Nobody can
retroactively discover what Gemini said about a brand last March. A competitor launching
tomorrow starts at zero history and stays behind by exactly as long as they were late,
permanently. This is real but weak on its own: it compounds only while customers keep
sampling, and it is worth nothing at n=0. It becomes a moat the day you have customers
with a year of history, and not before.

**b) The correlation dataset.** Once outbound outcomes and visibility sit together at
volume, Scout can answer "does being cited actually convert" for a segment. That answer is
a product nobody else can build without first building both halves and waiting. This is
the strongest structural claim, and it is currently unbuilt.

**c) Measurement credibility as a positioning choice.** Confidence intervals, sample
sizes, refusals excluded from the denominator, a change called real only when intervals
separate, and a tool that says "not enough data yet" rather than invent a collapse. This
is copyable in principle and rarely copied in practice, because it makes the demo look
worse. In a category that will produce a wave of tools reporting variance as insight, the
one that was right when the others were confidently wrong wins the renewal. Treat this as
brand and trust, not as technology.

**What is not a moat, and should not be claimed as one:** the AI layer (commodity models
behind a provider abstraction), the number of features, the MCP server, or being
free-tier-first on infrastructure.

---

## 5. What makes this fundable, concretely

Ranked by how much each moves an investor, and each is a thing to go do this quarter.

1. **Ten design partners sampling daily.** Not logos on a slide, orgs with live tracked
   prompts accumulating history. This is the only item that simultaneously proves demand,
   starts the moat compounding, and produces the data for item 2. Everything else is
   downstream.
2. **One real correlation finding.** Even a small one: "in this segment, accounts where we
   held the AI answer replied at X%, versus Y% where a rival did." That single chart is
   the entire thesis made real, and it is the thing no competitor can show.
3. **Evidence that the honest measurement matters commercially.** A customer who switched
   because another tool told them their visibility collapsed and it had not. One such
   story converts the trust positioning from a principle into a wedge.
4. **A defensible category name that you use consistently.** Pick one and never drift.
   "AI answer visibility, joined to outbound" is clearer than AEO or GEO, both of which
   are contested acronyms that make you sound like a follower.
5. **Retention evidence.** Visibility tools have a churn problem: a customer checks, sees
   a number, and stops. Scout's answer is that the outbound half is a daily-use product
   that keeps them in the tool, so the visibility history keeps accumulating. Show weekly
   active usage, not just signups.

**The uncomfortable one:** a single founder with several products in flight is a real
objection, not an unfair one. AbroBot, MNB Research, Topper's Hub, Cortex, a CRM, Scout.
An investor will ask which one gets your next two years. Have an answer, and if the answer
is Scout, the others need a visible structure that does not depend on your attention.

---

## 6. Who to raise from, and how to frame it

**Frame as:** GTM data infrastructure for the assistant era. Sold to revenue teams,
priced per seat plus usage, expanding into the measurement layer that agencies and
consultants resell.

**Not as:** another lead-gen tool with AI features, which prices you against Apollo and
loses, or a pure AEO/GEO tool, which prices you against a crowd of 2026 startups all
saying the same sentence.

**Best-fit investors:** early-stage GTM or devtools funds who have already formed a view
that search-era measurement is breaking. India-based seed funds for capital efficiency
plus a large domestic SME base to prove the motion on. Angels who ran revenue orgs and
have personally watched an AI answer kill a deal.

**The question you will be asked and must have a crisp answer to:** "What happens when
OpenAI or Google ships first-party brand analytics?" The honest answer: the measurement
layer commoditises and only the correlation work survives, which is exactly why the
correlation work is the roadmap rather than more measurement features. Saying this plainly
scores better than dodging it, because every investor in this category is already
thinking it.

---

## 7. Messaging hierarchy

Use the same ladder everywhere: landing page, deck, cold email, LinkedIn.

| Level | Line |
| --- | --- |
| One-liner | Scout shows you what AI tells your buyers about you, and ties it to the outbound that got them asking. |
| Problem | Your email lands, they ask an assistant whether you are any good, and that answer is now part of your funnel. |
| Insight | An AI answer is a sample, not a measurement. Most tools run one prompt, find you missing, and report a collapse that never happened. |
| Proof | Rates with confidence intervals and sample sizes, per engine, raw answers kept, and a tool that says "not enough data yet". |
| Wedge | The questions worth tracking are written from your ICP, not guessed in a keyword box. |
| Vision | The only place outbound outcomes and AI answers sit on one schema, which is the only way to answer whether visibility converts. |

---

## 8. What would falsify this

Worth writing down so it can be checked rather than believed:

- If visibility turns out not to correlate with reply rates once there is enough data, the
  bridge is imaginary and the two halves should be separate products.
- If buyers will not pay for both, the bundle is a distraction from whichever one they
  will pay for.
- If the frontier labs ship first-party brand analytics, the measurement layer collapses
  to a commodity and only the correlation work survives.
- If design partners sample once and stop, the time-series moat never compounds and the
  whole argument in section 4a is void.

---

## 9. What this document does not claim

No customer counts, revenue figures, success rates or testimonials appear anywhere above,
because Scout does not have them yet. Competitor landing pages in this space lead with
exactly those numbers. Borrowing the shape of that page without the numbers behind it is
the fastest way to lose an investor who checks one of them, and the metrics above are the
ones to go earn instead.
