# Scout: what it is, and what it is not

## The thesis

Outbound creates demand. AI answers decide whether that demand survives contact with reality.

A prospect gets your cold email. Before replying, they ask ChatGPT "is Scout any good, what
else should I look at". Whatever that answer says is now part of your funnel, and you have
no idea what it says. That gap is the product.

Every other tool in this space picks one side of it:

- Prospecting tools (Apollo, Clay, Instantly) optimise the sending. They know nothing about
  what a buyer finds when they go and check you out.
- AI visibility tools (Pixis Visibility, and the wave of AEO/GEO startups) measure what AI
  engines say about you. They know nothing about who you are contacting or whether it
  converted.

Scout is the only place both halves sit in the same database. That is the whole bet.

## What that unlocks that neither side can compute

These are the questions that require both datasets, and are therefore ours to answer:

1. **Does visibility actually convert?** Correlate reply rates against visibility for the
   same segment. Nobody can currently tell you whether being cited by ChatGPT is worth the
   effort, because nobody holds both numbers.
2. **Where should outbound push hardest?** Prioritise segments where you already win the
   AI answer, because the follow-up research reinforces you instead of undermining you.
3. **Where is outbound fighting uphill?** Flag segments where a rival owns the answer, so
   you know the email is landing into a bad second impression.
4. **Which questions matter?** The prompts worth tracking are derivable from the ICP that
   is already producing replies, rather than guessed in a keyword tool.

None of this is built yet. It is the point of building the two halves on one schema.

## Honest assessment of the moat

I am not going to pretend the code is defensible. It is not.

**Not a moat.** Running prompts against LLM APIs, parsing brand mentions, scoring ICP fit,
drafting replies. A competent team replicates any of it in weeks. The AI layer is commodity
models behind a provider abstraction. Assume it will be copied.

**The actual moat is time-series data that cannot be backfilled.** Visibility is a
measurement of a moment. Nobody can retroactively discover what Gemini said about a brand
last March. A competitor launching tomorrow starts at zero history and stays behind by
exactly as long as they were late, permanently. The same is true of the outbound outcome
data feeding ICP learning and the reply-style corpus: those are accumulated by use, not
bought.

So the strategy follows from that: **get orgs sampling early and never lose the history.**
Raw answers are stored verbatim, forever, alongside their analysis, because the analysis
logic will keep changing and only the raw text lets us recompute the past. Deleting raw
answers to save storage would be destroying the only durable asset in the company.

**The second defensible thing is trust, which is a positioning choice, not a technology.**
See below.

## The product principle: do not report noise as signal

An LLM answer is a sample from a distribution, not a measurement. Ask the same engine the
same question twice and you get different brands, in a different order. Temperature, model
updates, retrieval and personalisation all move it.

Almost every tool in this category runs a prompt once, finds you missing, and reports
"visibility dropped to 0%". That is not a measurement. It is variance sold as insight, and
it will eventually burn the customers who acted on it.

Scout's rule, enforced in code, not in marketing copy:

- Rates are reported with Wilson confidence intervals and a sample size, never as a bare
  number.
- A change is called real only when the intervals separate. Otherwise it says "no
  detectable change", which is usually the truth.
- Refusals and errors are excluded from the denominator, never counted as absence, because
  counting a refusal as "you were not mentioned" invents a collapse that never happened.
- Below a minimum sample the tool refuses to report a rate at all and says what it still
  needs.

The same standard already governs ICP learning (`icp/learn.ts`), A/B winner selection
(`outreach/experiment.ts`) and deliverability (`email/sendingHealth.ts`). It is a house
style: this product would rather say "I do not know yet" than be confidently wrong.

That is copyable in principle and rarely copied in practice, because it makes the numbers
look less impressive in a demo. It is the right trade for a tool people run a business on.

## Category position

Scout is a **go-to-market visibility and execution system for B2B**: find the right
accounts, reach them like a human, and know what the AI says about you when they check.

Not a "lead gen tool with an AI visibility feature bolted on". If the two halves never
inform each other, this document is wrong and the feature should be cut.

## What exists today

| Capability | State |
| --- | --- |
| Lead discovery, enrichment, verification | Shipped |
| AI-personalised outreach, sequences, reply triage | Shipped |
| Account intelligence briefs, conversational ICP builder | Shipped |
| Composite lead prioritisation | Shipped |
| Outcome-based ICP learning | Shipped |
| Deliverability circuit breaker and warm-up | Shipped |
| Statistical A/B winner selection | Shipped |
| AI visibility: tracked prompts, sampling, metrics, rivals, gaps | Shipped |
| Multi-engine sampling beyond the configured provider | Not built |
| Correlating visibility against reply outcomes | Not built |
| Deriving tracked prompts from the winning ICP | Not built |
| Sentiment of a mention | Deliberately not built until it can be done honestly |

The last three rows are the thesis. Until they exist, Scout is two good products sharing a
login, and the moat argument above is a plan rather than a fact.

## What would falsify this

Worth writing down so it can be checked rather than believed:

- If visibility turns out not to correlate with reply rates once there is enough data, the
  bridge is imaginary and the two halves should be separate products.
- If buyers will not pay for both, the bundle is a distraction from whichever one they will
  pay for.
- If the frontier labs ship first-party brand analytics, the measurement layer collapses to
  a commodity and only the correlation work survives.
