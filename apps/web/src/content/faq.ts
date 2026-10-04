/**
 * The questions a buyer actually types, and straight answers to them.
 *
 * This file is the single source of truth for two things: the FAQ section a human reads on
 * the landing page, and the FAQPage structured data an engine reads. The JSON-LD is built
 * from this array at BUILD time and written into index.html (see vite.config.ts), rather
 * than rendered by React, because the crawlers that matter most here do not all run
 * JavaScript - and a product that sells AI visibility being invisible to the machines that
 * read pages would be an embarrassing thing for a prospect to discover.
 *
 * Because both come from this array, the page and the schema cannot drift apart.
 *
 * Rules for anything added here: answer the question in the first sentence, keep it under
 * about sixty words, and never claim something the product does not do. These answers are
 * exactly the text an engine may quote back to someone researching us, so an overclaim
 * here is an overclaim with our name on it, repeated by a third party.
 */

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  {
    q: "What does Scout do?",
    a: "Scout finds and verifies B2B buyers from live sources, writes outreach from what it actually found about the account, and separately measures what AI engines answer when those buyers research you. Both halves report into one database, so you can see whether being named by an AI engine turns into replies.",
  },
  {
    q: "How is Scout different from Apollo, Clay or Lusha?",
    a: "Two ways. Those tools sell you access to a contact database; Scout searches live sources, can verify each address before you send, and never sends to one it knows is invalid. And none of them measure what AI engines say about you, which is increasingly where buyers form an opinion before they ever reply.",
  },
  {
    q: "What are AEO and GEO?",
    a: "Answer Engine Optimisation and Generative Engine Optimisation are the practice of being named by AI assistants when someone asks about your category. Scout measures it: it writes the questions a real buyer would type, asks each engine repeatedly on a schedule, and reports how often you appear, per engine, with the sample size.",
  },
  {
    q: "Can you guarantee my brand will be recommended by ChatGPT or Gemini?",
    a: "No, and anyone who guarantees that is selling you variance. Ask any engine the same question twice and you get different brands in a different order. What Scout can tell you is which questions you are absent from, who currently owns those answers, and which gaps are realistically winnable.",
  },
  {
    q: "Where does the lead data come from?",
    a: "Live web search plus licensed data providers where you have connected them, followed by independent email verification. Scout does not resell a static contact database, because exported lists decay at roughly two percent a month and everyone who bought the list is emailing the same people.",
  },
  {
    q: "Will sending through Scout damage my email domain?",
    a: "Scout is built to prevent that. Addresses can be verified before they are used, ones known to be invalid are never sent to, each mailbox carries a health score, and a circuit breaker stops a campaign automatically if bounce rates climb mid-run.",
  },
  {
    q: "What happens when Scout does not have enough data to answer?",
    a: "It says so. Rates are withheld below the sample size needed to mean anything, week-on-week changes are not reported when the confidence intervals overlap, and a provider that failed to respond is reported as a failure rather than as an empty result. A number you cannot defend is worse than no number.",
  },
  {
    q: "Is there a free plan?",
    a: "Yes. The free plan sources what it can from the open web at no cost and needs no credit card. Paid plans add licensed provider data and verification volume, and are set up with you so the provider budget matches what you actually send.",
  },
  {
    q: "Can AI agents use Scout directly?",
    a: "Yes. Scout ships an MCP server and a REST API, so an agent can search, enrich, verify and send using the same tools a human rep uses, with the same quotas and the same safeguards.",
  },
];
