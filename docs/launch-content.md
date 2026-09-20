# Scout launch content

Two posts, written against the current positioning: outbound and AI answer visibility on
one schema, with measurement discipline as the differentiator. Replaces the earlier draft,
which pitched Scout as a lead-gen tool with AI copilots and predates the repositioning.

House rules applied: no em dashes, no invented metrics, no customer counts or testimonials,
because there are none yet. Every claim below is something the product actually does.

---

## Post 1: An AI answer is a sample, not a measurement

**Target:** the methodology argument. This is the piece that earns trust, and it is also
the one most likely to get cited by an AI answer later, which is the point.

**Meta description:** Most AI visibility tools run a prompt once and report the result as
a fact. Here is why that number is noise, and what an honest measurement looks like.

---

Ask ChatGPT the same question twice and you will often get two different answers. Different
brands, different order, sometimes a different recommendation entirely. Temperature does
that. Model updates do that. Retrieval and personalisation do that.

This is not a flaw you can engineer around. It is what a language model is. An answer is a
draw from a distribution, and one draw tells you almost nothing about the distribution.

Now consider what most tools in the AI visibility category do with that fact. They run your
prompt once, look for your name, do not find it, and report that your visibility dropped to
zero. Run it again an hour later, find you, and report that visibility recovered. Neither
number describes anything real. A customer who acts on them reorganises their content
strategy around a coin flip.

We built Scout's visibility layer around the opposite commitment, and it is enforced in
code rather than promised in marketing copy.

**Rates always ship with their interval and their sample size.** Not "58% visibility" but
"58%, 95% CI 32 to 81%, n=12". If that interval looks embarrassingly wide, that is the
honest width at twelve samples. Hiding it would not make the underlying uncertainty smaller,
it would only move the uncertainty onto you.

**A change is only called real when the intervals separate.** Last week 4 of 10, this week
6 of 10. That looks like a 20 point jump and a good week. The intervals overlap heavily, so
Scout reports no detectable change. It is the less satisfying answer and it is usually the
correct one.

**Refusals and errors are excluded from the denominator, never counted as absence.** If an
engine declines to answer or the API errors, that is not evidence you were left out. Folding
those into the denominator manufactures a collapse that never happened, and it is the single
easiest way for a tool to produce alarming charts.

**Below a minimum sample, no rate is reported at all.** The tool says what it still needs
instead of showing you a number it cannot stand behind.

**Every engine is reported separately.** Engines disagree, often sharply. You can be well
represented in one and invisible in another. A blended headline figure averages those into a
number that describes no engine any of your buyers actually use.

**Raw answers are stored verbatim, forever.** The analysis logic will keep changing, and
only the original text lets us recompute the past when it does. A stored summary cannot be
re-examined. It also means every number traces back to the sentences it came from.

The trade is obvious. This makes the demo less impressive. A competitor's dashboard will
show a confident percentage and a dramatic trend line while ours says "not enough data yet,
here is what it would take".

We think that is the right trade for a tool people run a business on. The confident number
is more fun for exactly as long as it takes someone to act on it and get burned.

Scout is live at scout.mnbresearch.com.

---

## Post 2: Stop tracking your own brand name

**Target:** the practical piece. Shows the prompt generation feature and teaches something
useful even to someone who never signs up.

**Meta description:** The most common mistake in AI visibility tracking is measuring the
one question you are guaranteed to win. Here is how to pick questions that mean something.

---

Open almost any AI visibility tool and the first thing you get is an empty box asking which
prompts to track. Almost everyone types their own company name.

It is the obvious move and it is close to worthless. Ask an assistant "what is Acme Corp"
and it will tell you about Acme Corp. You appear in 100% of answers. The dashboard goes
green. You have measured your own question, not your visibility.

No buyer types that. A buyer in the market types questions like these:

- What is the best B2B lead generation platform for small sales teams?
- What are the top alternatives to Apollo?
- Apollo vs Clay: which is better for outbound in 2026?
- How do teams usually deal with lead lists going stale?
- What should I look for when choosing a prospecting tool?

Notice what none of them contain: your name. That is the whole point. These are the answers
where a brand discovers it is absent, and they are the answers that decide a shortlist.

They break into five kinds, and a tracking set that skips any of them has a blind spot:

**Category questions.** "Best X for Y." The first question a buyer asks. Absent here and
nothing downstream matters.

**Alternative questions.** "Top alternatives to [competitor]." Pure switching intent. The
highest converting answer to appear in, and often the cheapest to win, because the buyer has
already decided they want something else.

**Comparison questions.** "[Competitor A] vs [Competitor B]." Head to head answers
frequently name a third option. That slot is winnable and most brands never check whether
they hold it.

**Problem questions.** "How do teams usually handle X." Earlier stage, where your category
may not even come up yet. Expensive to win and it shapes the frame the buyer evaluates in.

**Evaluation questions.** "What should I look for when choosing X." Tells you which criteria
the engines treat as important, which is exactly what to lead with in your outreach.

Picking a dozen good questions across all five, for your specific market, is real work. So
Scout now writes the set for you. It reads your brand, your competitors and your ICP, the
one you already built and that reply outcomes have been refining, and generates the questions
your buyers would plausibly ask.

Two things about that generation are worth stating plainly, because "AI generated" usually
hides them.

Every generated question is validated before it is stored. Reworded duplicates are collapsed
against what you already track. And any question naming your brand is rejected outright,
with the reason shown, because that question guarantees a mention and measures nothing.

If the model returns too few usable questions to be a proper set, Scout falls back to a
deterministic starter pack and tells you that is what you are looking at. It does not pass
a thin result off as a generated one.

You review the list, uncheck anything that does not fit your market, and track the rest.

Scout is live at scout.mnbresearch.com.
