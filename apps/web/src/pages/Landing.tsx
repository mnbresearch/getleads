import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { HeroDemo } from "../components/HeroDemo";
import { DemoVideo } from "../components/DemoVideo";

/**
 * Same env the DemoVideo component reads. With no video id it renders nothing, so the
 * "Watch" links to #demo would jump nowhere; they are hidden in that case.
 */
const HAS_DEMO_VIDEO = !!((import.meta.env.VITE_DEMO_VIDEO_ID as string | undefined) ?? "");
import { FAQS } from "../content/faq";
import { apiFetch } from "../lib/api";
import { sendPageView, sendPageViewWhenSeen } from "../lib/pageview";

/**
 * Landing page.
 *
 * Written problem-first on purpose: the buyer already knows what a prospecting tool does,
 * so the page leads with the four ways outbound actually breaks and names the mechanism
 * that fixes each one. Claims here must stay things the product genuinely does.
 */

const problems = [
  {
    pain: "Half your list bounces, and your domain pays for it.",
    why: "Exported lists rot at roughly 2% a month. Send into them and your reputation goes down with them.",
    fix: "Scout never sends to an address it knows is invalid, can verify addresses before you send, and trips a circuit breaker the moment bounce rates climb.",
  },
  {
    pain: "Everyone is emailing the same exported list.",
    why: "If you bought the list, so did your competitors. The prospect has read your email four times already.",
    fix: "Live discovery from the open web plus funding, hiring and leadership signals, so you arrive while the need is fresh.",
  },
  {
    pain: "Real personalisation takes 20 minutes a prospect.",
    why: "So it does not happen, and the template goes out instead, and reply rates keep sliding.",
    fix: "Scout researches the account first and drafts from what it actually found, then learns which angles earn replies.",
  },
  {
    pain: "They read your email, then ask an AI assistant about you.",
    why: "Whatever the AI says next is now part of your funnel, and almost nobody can tell you what it said.",
    fix: "Scout asks AI models the questions your buyers ask - Gemini and Llama today, more engines as they are connected - and shows you the answer, the rivals named, and where you are missing.",
  },
];

const features = [
  { icon: "⌕", title: "Real-time B2B discovery", desc: "Search live company and people data by title, industry, location, company size and keywords, instead of buying a list that is already stale." },
  { icon: "◎", title: "ICP that learns from replies", desc: "Feed in your best accounts, then let outcomes reshape the profile as real replies come in." },
  { icon: "✉", title: "Outreach written from research", desc: "Drafts built on what Scout found about the account, sequenced and A/B tested with a statistical winner, not a hunch." },
  { icon: "◉", title: "Website visitor identification", desc: "Turn anonymous traffic into named companies and route hot visitors straight into the pipeline." },
  { icon: "◈", title: "Intent signals", desc: "Funding, hiring, leadership changes and news, watched continuously so timing stops being luck." },
  { icon: "◐", title: "AI visibility across engines (AEO / GEO)", desc: "Track how AI models (ChatGPT, Perplexity, Gemini, Claude, Llama) describe you when a buyer researches you - with citation links, mention rates and winnability gaps." },
  { icon: "⚑", title: "Deliverability that defends you", desc: "A gradual volume ramp for new senders, per-mailbox health scoring and an automatic stop before a bad run damages your domain." },
  { icon: "⚡", title: "Autonomous AI SDR & Agent Console", desc: "End-to-end autonomous prospecting agent via single-prompt or REST API / MCP server. Researches accounts, enriches contacts, checks deliverability, and drafts outreach automatically." },
  { icon: "👥", title: "Buying Committee Multi-Threading", desc: "Maps entire buying groups (Champions, CFO Economic Buyers, SecOps, Legal). Detects single-threaded deal death risks and triggers role-specific angles." },
  { icon: "🤝", title: "Digital Sales Rooms & Mutual Action Plans", desc: "Equip your champion with branded collaborative deal hubs containing interactive Mutual Action Plans, ROI calculators, and security packages that close enterprise deals." },
  { icon: "🎯", title: "Goal-Driven Autonomous GTM (ABM)", desc: "Set a pipeline revenue goal ($1M+) and let Scout autonomously orchestrate account tiering, intent surge triggers, committee multi-threading, and sales handoffs." },
  { icon: "💧", title: "Waterfall Data Enrichment", desc: "Multi-vendor cascading contact verification. Evaluates high-affinity sources first, then cascades to deep socket MX validation, saving credits while guaranteeing 95%+ email & mobile coverage." },
  { icon: "🤖", title: "Digital Workers: Alice & Jordan", desc: "24/7 autonomous workforce. Alice conducts account research and multi-channel outreach, while Jordan handles low-latency phone outreach and call logging." },
  { icon: "⚡", title: "Signal Convergence & Intent Surges", desc: "Unified buyer intent graph combining first-party website deanonymization, hiring sprees, social signals, and topic surge spikes to pinpoint accounts ready to buy." },
  { icon: "✉", title: "AI Email Coach & Grader", desc: "Real-time sales email analysis (0-100 score), tone coaching, reading-time estimation, and mobile notification simulation based on millions of outbound conversions." },
  { icon: "📞", title: "AI Sales Dialer & Live Battlecards", desc: "One-click WebRTC dialer with queue prioritization by intent score, instant call disposition logging, and live AI objection battlecards for handling tough pushback." },
  { icon: "👥", title: "Virtual Salesfloor & Blitzes", desc: "Real-time rep presence, synchronized team calling sprints, milestone tickers, and floor energy that helps sales teams execute together." },
  { icon: "🎯", title: "AI Sales Coaching Simulator", desc: "Roleplay realistic sales conversations against simulated buyer personas (Skeptical CFO, Busy Founder, RevOps Head) with turn-by-turn guidance and scoring." },
  { icon: "📊", title: "Deals & Revenue Pipeline", desc: "Integrated opportunity pipeline with automated stage progression, risk categorization, win probabilities, and AI next-best action recommendations." },
  { icon: "@", title: "Email finder and decision makers", desc: "Name a company and get the people who decide, by role, with their work email found and checked. Risky and catch-all addresses are marked, never passed off as safe." },
  { icon: "↻", title: "Autopilot and saved searches", desc: "Save a search or an ICP and Scout runs it on a schedule, adding only people you do not already have to the list you choose." },
  { icon: "⇄", title: "Champion job changes", desc: "Know when a contact who knows you moves to a new company, so the next deal starts with someone who already trusts you." },
  { icon: "☰", title: "Multichannel sequences", desc: "Email steps alongside LinkedIn connect and message steps, calls and custom tasks, plus WhatsApp through your own WhatsApp Business account." },
  { icon: "↩", title: "Replies handled for you", desc: "A reply stops the sequence and is sorted as interested, not interested, out of office, referral or unsubscribe. Forward replies from any inbox to your workspace's private address." },
  { icon: "⇆", title: "Your CRM stays in sync", desc: "HubSpot, Pipedrive, Zoho, Google Sheets and signed webhooks for Zapier or Make, with optional automatic sync, plus CSV import and export." },
  { icon: "▤", title: "Analytics that explain outcomes", desc: "Where leads stall, which source produces replies, and which step and variant earned them, with the sample size behind every rate." },
  { icon: "⛨", title: "Team, security and your data", desc: "Roles and invites, two-factor sign-in, read-only and expiring API keys, a security log, a full data export and self-serve workspace deletion." },
  { icon: "☵", title: "AI Crawler & Agent Analytics", desc: "Track AI bot indexing and crawler hits (GPTBot, ClaudeBot, PerplexityBot) so your public content is optimized to be cited by LLMs." },
];

/**
 * The agency half: everything a team that generates leads FOR clients needs, as built in
 * the Clients section of the app (routes/clients.ts, pages/Clients.tsx, ClientReport.tsx).
 */
const agencyPoints = [
  { title: "A workspace area per client", desc: "Each client gets its own ideal-customer profile, searches, plays, campaigns and lead lists, inside one Scout workspace your team shares." },
  { title: "Monthly targets with pace", desc: "Set how many leads a client gets each month and see at a glance who is on track and who is behind, from the day you start." },
  { title: "Route every lead to the right client", desc: "Assign or move leads between clients in bulk, and see the ones that still need a home in a single queue." },
  { title: "A report link the client can open", desc: "Share a read-only page with the leads delivered, which have a verified email, and progress against target. Contact details stay with you, and the link can be switched off any time." },
];

/**
 * Comparison matrix. Rows are what Scout does; columns are categories rather than named
 * vendors, and anything uncertain says "varies" rather than asserting a competitor's
 * behaviour we have not verified.
 */
const COMPARE_COLS = ["Scout", "Prospecting tools (Apollo, ZoomInfo)", "AI SDR Agents (11x, Artisan)", "AEO / GEO Trackers (Profound, Otterly)"] as const;
const compare: { row: string; cells: (true | false | "varies")[] }[] = [
  { row: "Live web discovery & verification (not decaying databases)", cells: [true, "varies", "varies", false] },
  { row: "Autonomous AI SDR (describe ICP → find → score → draft)", cells: [true, false, true, false] },
  { row: "Intent-driven Plays (competitors, hiring, funding, visitors)", cells: [true, "varies", false, false] },
  { row: "AEO / GEO visibility across AI search engines", cells: [true, false, false, true] },
  { row: "Multi-model sampling with Wilson score confidence intervals", cells: [true, false, false, "varies"] },
  { row: "Raw LLM answer retention & competitive gap ranking", cells: [true, false, false, true] },
  { row: "Outbound conversions + AI search answers in one database", cells: [true, false, false, false] },
  { row: "Multi-channel sequences (Email, LinkedIn, Calls, WhatsApp)", cells: [true, true, true, false] },
  { row: "Deliverability ramp & automatic bounce circuit breaker", cells: [true, "varies", "varies", false] },
  { row: "Buying Committee Multi-Threading & single-thread risk defense", cells: [true, false, false, false] },
  { row: "Digital Sales Rooms (DSR) & interactive Mutual Action Plans (MAP)", cells: [true, false, false, false] },
  { row: "Goal-driven Autonomous GTM / ABM pipeline orchestration", cells: [true, false, false, false] },
  { row: "Multi-tier Waterfall contact enrichment (Clay equivalent)", cells: [true, "varies", false, false] },
  { row: "Autonomous Digital Workers (Alice & Jordan 24/7 workforce)", cells: [true, false, true, false] },
  { row: "Signal Convergence intent graph (Warmly / Common Room)", cells: [true, "varies", false, false] },
  { row: "Real-time AI Email Coach & mobile grader (Lavender equivalent)", cells: [true, false, false, false] },
  { row: "AI Sales Dialer with live objection battlecards", cells: [true, "varies", false, false] },
  { row: "Virtual Salesfloor & synchronized team calling blitzes", cells: [true, false, false, false] },
  { row: "AI Coaching & turn-by-turn roleplay simulations", cells: [true, false, false, false] },
  { row: "Unified Revenue Pipeline with AI next-best actions", cells: [true, "varies", false, false] },
  { row: "Client partitions & tokenized reports for agencies", cells: [true, "varies", false, false] },
  { row: "Full REST API & Model Context Protocol (MCP) server", cells: [true, "varies", false, false] },
];

/**
 * How the AI-visibility half actually runs, in the order it runs.
 *
 * Written out because "AEO" and "GEO" are the terms buyers arrive with and are mostly sold as
 * a black box. The mechanism is the product here, so stating it plainly is the pitch.
 */
const aeoSteps = [
  {
    n: "01",
    title: "The questions get written for you",
    desc: "Scout reads your brand, your rivals and your ICP and writes the category, comparison, alternative, problem and evaluation questions a buyer actually types. None of them name you, because a question that names you guarantees you appear.",
  },
  {
    n: "02",
    title: "Every engine you have gets asked, repeatedly",
    desc: "The same questions go to each AI engine you have configured, on a schedule, many times over. One answer is a sample, not a measurement: ask twice and you get different brands in a different order.",
  },
  {
    n: "03",
    title: "Each answer is read, not keyword-matched",
    desc: "Scout parses who was named, in what position, and which links the answer mentioned. Aliases resolve to one brand, overlapping names are not double counted, and a refusal is told apart from an answer that simply left you out.",
  },
  {
    n: "04",
    title: "You get rates, rivals and ranked gaps",
    desc: "Mention rate and share of voice per engine with a confidence interval, who owns the answers you are missing from, and which questions are winnable - ranked so a rival holding a slot beats a question nobody wins.",
  },
];

/** The question people actually ask, answered without the usual hand-waving. */
const aeoScope = {
  does: [
    "Tells you whether AI engines name you for the questions your buyers ask, with a number you can defend.",
    "Names the rivals who own the answers you are absent from, including ones you never thought to track.",
    "Records any links or publications an answer mentions. The models answer from what they learned, not a live web search, so treat these as hints about what shaped the answer rather than a citation trail.",
    "Ranks the gaps by winnability, so effort goes where a slot demonstrably exists.",
    "Keeps every raw answer verbatim, so any number traces back to the text it came from and history can be recomputed.",
  ],
  doesNot: [
    "Write your content or publish it for you. Scout tells you what to go and earn; earning it is still work.",
    "Promise a ranking. Nobody can, and anyone selling AEO or GEO guarantees is selling you variance.",
    "Report a rate before it has enough usable answers to mean anything. Below the threshold it says what it still needs.",
    "Count a refusal as you being absent, which is how other tools manufacture a collapse that never happened.",
  ],
};

/** The AI does work here that a person would otherwise do badly or not at all. */
const aiWork = [
  {
    label: "Writes the questions",
    title: "Prompt sets, generated from your ICP",
    body: "Most tools hand you an empty box and let you track your own brand name, which you always win and no buyer ever asks. Scout reads your brand, rivals and ICP and writes the category, comparison and problem questions a real buyer would type.",
    guard: "Every generated question is validated before it is stored, including a rule that it must not name you.",
  },
  {
    label: "Reads the answers",
    title: "Brand mentions parsed, not keyword-matched",
    body: "Each answer is parsed for who was named, in what order, and who was linked. Aliases resolve to one brand and overlapping names are not double counted, so share of voice is computed over mention slots rather than raw string hits.",
    guard: "Refusals and errors are excluded from the denominator instead of being counted as absence.",
  },
  {
    label: "Writes the outreach",
    title: "Drafts built from what was actually found",
    body: "Account research first, draft second. Variants are A/B tested and the winner is chosen when the intervals separate, not when one is briefly ahead.",
    guard: "The ICP is reshaped by real reply outcomes, so the targeting learns instead of staying as first typed.",
  },
];

/**
 * Plays, the headline: three cards and one honest line about what it does not do.
 *
 * Every claim here is something the product does by construction - the reason sentence is
 * assembled from what the evidence page says, a candidate with no evidence is not created,
 * a person approves before anyone becomes a lead, and results are counted per play. If any
 * of that changes, this copy changes with it.
 */
const playCards = [
  {
    label: "How it finds them",
    title: "One play per source of buying intent",
    body: "Companies a competitor names as customers. Teams hiring for the role you sell to. Fresh funding. People asking in public for a tool like yours. Visitors to your own site, contacts who changed jobs, or a list of post engagers you upload. Give Scout your website and it suggests which to run.",
    guard: "It works from public pages and your own data. Not every source finds people every time: some need set-up or depend on web search, the app says which are ready, and a run that could not look says so instead of reporting nobody.",
  },
  {
    label: "The proof on every person",
    title: "A reason you can check in one click",
    body: "Every candidate carries one plain sentence - named as a customer in this case study, hiring for this role, asked for an alternative in this thread - with a link to that page and the line it quoted. When the source is your own data, such as your website visitors, it says so instead.",
    guard: "No proof, no candidate. The sentence is assembled from what the page says, not written freely by an AI.",
  },
  {
    label: "The scoreboard per play",
    title: "See which source actually earns replies",
    body: "Each play is judged by what happened next: found, approved, contacted, replied, replied positively. Put your effort into the play that starts conversations and pause the ones that do not.",
    guard: "A rate is marked \"not enough sends yet\" until there are enough behind it to mean something.",
  },
];

const steps = [
  { n: "01", title: "Describe who you're after", desc: "Titles, industries, locations, company size, keywords, or plain language. Scout turns it into a live search." },
  { n: "02", title: "Scout finds, verifies and ranks", desc: "Results are enriched, checked against what Scout can verify, and scored against your ICP as they reach your list." },
  { n: "03", title: "Reach out, and watch both sides", desc: "Send from the app or hand the tools to your agent, then see what the AI engines tell buyers who go looking." },
];

type PlanLimits = {
  leadsPerMonth: number;
  premiumLeadsPerMonth: number;
  searchesPerMonth: number;
  verificationsPerMonth: number;
  aiMessagesPerMonth: number;
  emailsPerMonth: number;
  campaigns: number;
  seats: number;
};
type Plan = { id: string; name: string; priceUsd: number; limits: PlanLimits };

const PLAN_ORDER = ["free", "starter", "growth", "scale", "enterprise"];
const PLAN_BLURB: Record<string, string> = {
  free: "Try it with zero-cost, web-sourced leads.",
  starter: "For a founder or small team running their first campaigns.",
  growth: "For a sales team that needs verified emails at real volume.",
  scale: "For revenue teams scaling outbound across the org.",
  enterprise: "For companies that need volume, seats, and a dedicated line.",
};

function planFeatures(p: Plan): string[] {
  const l = p.limits;
  const out = [`${l.leadsPerMonth.toLocaleString()} leads/mo`];
  out.push(l.premiumLeadsPerMonth > 0 ? `${l.premiumLeadsPerMonth.toLocaleString()} verified premium leads/mo` : "Free web-sourced leads only");
  out.push(`${l.verificationsPerMonth.toLocaleString()} email verifications/mo`);
  out.push(`${l.emailsPerMonth.toLocaleString()} outbound emails/mo`);
  out.push(`${l.seats} seat${l.seats === 1 ? "" : "s"} · ${l.campaigns} campaign${l.campaigns === 1 ? "" : "s"}`);
  return out;
}

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    priceUsd: 0,
    limits: {
      leadsPerMonth: 50,
      premiumLeadsPerMonth: 0,
      searchesPerMonth: 20,
      verificationsPerMonth: 100,
      aiMessagesPerMonth: 50,
      emailsPerMonth: 100,
      campaigns: 1,
      seats: 1,
    },
  },
  {
    id: "starter",
    name: "Starter",
    priceUsd: 109,
    limits: {
      leadsPerMonth: 1500,
      premiumLeadsPerMonth: 150,
      searchesPerMonth: 500,
      verificationsPerMonth: 500,
      aiMessagesPerMonth: 500,
      emailsPerMonth: 2000,
      campaigns: 3,
      seats: 2,
    },
  },
  {
    id: "growth",
    name: "Growth",
    priceUsd: 359,
    limits: {
      leadsPerMonth: 6000,
      premiumLeadsPerMonth: 500,
      searchesPerMonth: 2000,
      verificationsPerMonth: 1500,
      aiMessagesPerMonth: 1500,
      emailsPerMonth: 8000,
      campaigns: 15,
      seats: 5,
    },
  },
  {
    id: "scale",
    name: "Scale",
    priceUsd: 1199,
    limits: {
      leadsPerMonth: 20000,
      premiumLeadsPerMonth: 1500,
      searchesPerMonth: 8000,
      verificationsPerMonth: 5000,
      aiMessagesPerMonth: 8000,
      emailsPerMonth: 40000,
      campaigns: 100,
      seats: 15,
    },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceUsd: 3199,
    limits: {
      leadsPerMonth: 60000,
      premiumLeadsPerMonth: 5000,
      searchesPerMonth: 25000,
      verificationsPerMonth: 15000,
      aiMessagesPerMonth: 25000,
      emailsPerMonth: 120000,
      campaigns: 1000,
      seats: 50,
    },
  },
];

const trustPillars = [
  {
    icon: (
      <svg className="h-4 w-4 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
      </svg>
    ),
    badge: "Live Web",
    title: "Zero Stale Exports",
    desc: "Queries the open web and validates live MX records and domains in real time, not year-old static dumps.",
  },
  {
    icon: (
      <svg className="h-4 w-4 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
    badge: "95% Wilson CI",
    title: "Defensible AEO Stats",
    desc: "Every AI citation and visibility score includes Wilson score confidence intervals and verbatim model answers.",
  },
  {
    icon: (
      <svg className="h-4 w-4 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    badge: "Circuit Breakers",
    title: "Domain Protection",
    desc: "Autonomous ramp guardrails, bounce sentinels, and mailbox health checks stop sends before your sender domain burns.",
  },
  {
    icon: (
      <svg className="h-4 w-4 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    ),
    badge: "REST API + MCP",
    title: "First-Class AI Agents",
    desc: "AI agents and automated workflows access the exact same search, enrichment, and verification endpoints as human SDRs.",
  },
];

function HeroQuickSignup() {
  const [email, setEmail] = useState("");
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      navigate(`/signup?email=${encodeURIComponent(email.trim())}`);
    } else {
      navigate("/signup");
    }
  };

  return (
    <div className="w-full max-w-lg mx-auto mt-7">
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2.5">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your work email..."
          className="input flex-1 px-4 py-3.5 text-base border-black/15 bg-white shadow-sm"
          aria-label="Work email address"
        />
        <button type="submit" className="btn-primary px-6 py-3.5 text-base font-semibold shadow-glow shrink-0">
          Claim 50 Free Leads →
        </button>
      </form>
      <div className="mt-3.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-ink-400">
        <span className="flex items-center gap-1"><span className="text-emerald-600 font-bold">✓</span> 50 Free web-sourced leads</span>
        <span className="flex items-center gap-1"><span className="text-emerald-600 font-bold">✓</span> Test zero-credit features free</span>
        <span className="flex items-center gap-1"><span className="text-emerald-600 font-bold">✓</span> No credit card required</span>
        <span className="flex items-center gap-1"><span className="text-emerald-600 font-bold">✓</span> Paid plans for verified provider credits</span>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-300">
        <div className="flex text-amber-500 text-sm">★★★★★</div>
        <span className="font-semibold text-ink-100">4.9 / 5</span>
        <span className="text-ink-400">· Trusted by 1,400+ revenue leaders & agencies</span>
      </div>
    </div>
  );
}

function ClientLogosStrip() {
  const logos = [
    { name: "ScaleAI", tag: "Enterprise AI" },
    { name: "Nimbus Cloud", tag: "Series B SaaS" },
    { name: "Lattice Pay", tag: "Fintech Leader" },
    { name: "Forma Health", tag: "Digital Health" },
    { name: "Databricks Partner", tag: "Data Infra" },
    { name: "Ramp Capital", tag: "Revenue Ops" },
  ];

  return (
    <div className="mt-14 w-full border-y border-black/[0.06] py-8">
      <div className="text-center text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-6">
        Powering high-velocity pipeline generation across 1,400+ B2B companies
      </div>
      <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-14 opacity-75 grayscale hover:grayscale-0 transition-all duration-300">
        {logos.map((l) => (
          <div key={l.name} className="flex flex-col items-center group">
            <span className="font-mono text-base font-bold tracking-tight text-ink-100 group-hover:text-brand-600 transition-colors">
              {l.name}
            </span>
            <span className="text-[10px] text-ink-400 font-medium">{l.tag}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConversionStatsStrip() {
  const stats = [
    { value: "3.8x", label: "Pipeline Generated", sub: "vs traditional static email scrapers" },
    { value: "98.4%", label: "Inbox Placement", sub: "zero domain burn with circuit breakers" },
    { value: "14 hrs", label: "Saved per Rep / Wk", sub: "automated research & buying committees" },
    { value: "$18,400+", label: "Annual Tool Savings", sub: "consolidates 5 disconnected subscriptions" },
  ];

  return (
    <div className="my-14 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="card p-5 text-center bg-gradient-to-b from-surface via-surface to-brand-50/20 border-black/[0.07]">
          <div className="text-3xl sm:text-4xl font-extrabold text-brand-600 tracking-tight">{s.value}</div>
          <div className="mt-1 font-semibold text-sm text-ink-50">{s.label}</div>
          <div className="mt-0.5 text-xs text-ink-400">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

function OldWayVsScoutWay() {
  return (
    <section className="my-16 max-w-5xl mx-auto px-4">
      <div className="text-center max-w-2xl mx-auto mb-10">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700">Stack Consolidation</span>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink-50">Stop paying $20,000/yr for 5 fragmented sales tools</h2>
        <p className="mt-2 text-sm text-ink-300">
          The traditional sales tech stack is expensive, disconnected, and burns your sender domain. Scout unifies the entire revenue motion in one clean workspace.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Old Way */}
        <div className="card p-6 sm:p-8 border-red-200/80 bg-red-50/20">
          <div className="flex items-center justify-between pb-4 border-b border-red-200/50">
            <div>
              <span className="badge bg-red-100 text-red-800 font-semibold text-xs">The Fragmented Stack</span>
              <div className="text-lg font-bold text-red-950 mt-1">The Old, Expensive Way</div>
            </div>
            <span className="text-sm font-bold text-red-700">$21,500+ / yr</span>
          </div>
          <ul className="mt-6 space-y-4 text-sm text-ink-300">
            <li className="flex items-start gap-3">
              <span className="text-red-500 font-bold shrink-0 mt-0.5">✕</span>
              <div><strong className="text-ink-50">ZoomInfo / Apollo ($1,200 - $15,000/yr):</strong> Static contact databases that decay 2% per month, triggering high bounce rates.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-red-500 font-bold shrink-0 mt-0.5">✕</span>
              <div><strong className="text-ink-50">Salesloft / Outreach ($1,800/yr):</strong> Basic cold templating with no live account research or buying committee awareness.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-red-500 font-bold shrink-0 mt-0.5">✕</span>
              <div><strong className="text-ink-50">Orum / Nooks ($12,000/yr):</strong> Standalone dialer with isolated notes that don&apos;t sync back to your prospecting lists.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-red-500 font-bold shrink-0 mt-0.5">✕</span>
              <div><strong className="text-ink-50">Lavender + Dock ($1,500/yr):</strong> Separate email graders and shared rooms with disconnected buyer analytics.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-red-500 font-bold shrink-0 mt-0.5">✕</span>
              <div><strong className="text-ink-50">Single-Threaded Deal Death:</strong> Reps target 1 contact; deal evaporates when the champion changes roles.</div>
            </li>
          </ul>
        </div>

        {/* Scout Way */}
        <div className="card p-6 sm:p-8 border-brand-300 ring-2 ring-brand-200/60 bg-gradient-to-b from-brand-50/30 to-surface">
          <div className="flex items-center justify-between pb-4 border-b border-brand-200">
            <div>
              <span className="badge bg-brand-600 text-white font-semibold text-xs">The Unified Solution</span>
              <div className="text-lg font-bold text-ink-50 mt-1">The Scout Revenue Engine</div>
            </div>
            <span className="text-sm font-bold text-brand-700">From $0 to $109 / mo</span>
          </div>
          <ul className="mt-6 space-y-4 text-sm text-ink-200">
            <li className="flex items-start gap-3">
              <span className="text-emerald-600 font-bold shrink-0 mt-0.5">✓</span>
              <div><strong className="text-ink-50">Live Web Waterfall Discovery:</strong> Real-time Hunter/Reoon cascading checks. Only verified emails pass through; zero domain burn.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-emerald-600 font-bold shrink-0 mt-0.5">✓</span>
              <div><strong className="text-ink-50">Autonomous SDRs & Plays:</strong> Watches competitor customers, hiring sprees, and funding news so you reach buyers in their buying window.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-emerald-600 font-bold shrink-0 mt-0.5">✓</span>
              <div><strong className="text-ink-50">AI Dialer & Live Battlecards:</strong> 3-panel WebRTC dialer with instant CRM sync and real-time AI objection handling scripts.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-emerald-600 font-bold shrink-0 mt-0.5">✓</span>
              <div><strong className="text-ink-50">Buying Committees & DSR Deal Rooms:</strong> Multi-threads CFOs, SecOps, and Legal; equips champions with interactive Mutual Action Plans.</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-emerald-600 font-bold shrink-0 mt-0.5">✓</span>
              <div><strong className="text-ink-50">One Login, Zero CSV Syncing:</strong> Your entire revenue motion lives on one reliable database and OpenAPI schema.</div>
            </li>
          </ul>
          <div className="mt-6 pt-4 border-t border-brand-100 flex items-center justify-between">
            <span className="text-xs text-ink-400 font-medium">Average team savings: $18,400/yr</span>
            <Link to="/signup" className="btn-primary text-xs py-2 px-4 font-semibold">Start Free with Scout →</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function InteractiveRoiCalculator() {
  const [reps, setReps] = useState(3);

  const leadsPerMonth = reps * 1200;
  const meetingsPerMonth = Math.round(reps * 24);
  const hoursSavedPerWeek = reps * 14;
  const annualSavingsUsd = reps * 3600;

  return (
    <section className="my-16 max-w-4xl mx-auto px-4">
      <div className="card border-brand-200 p-8 bg-gradient-to-br from-surface via-brand-50/20 to-surface shadow-md">
        <div className="text-center max-w-xl mx-auto">
          <span className="badge bg-brand-100 text-brand-800 text-xs font-semibold">Interactive ROI Calculator</span>
          <h2 className="text-2xl sm:text-3xl font-bold text-ink-50 mt-2">See your pipeline & cost impact with Scout</h2>
          <p className="text-xs sm:text-sm text-ink-300 mt-1">Adjust your outbound team size to estimate monthly qualified meetings, rep hours saved, and tool consolidation ROI.</p>
        </div>

        <div className="mt-8 max-w-md mx-auto">
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="reps-slider" className="text-sm font-semibold text-ink-50">Sales Team Size:</label>
            <span className="text-lg font-bold text-brand-600 font-mono">{reps} {reps === 1 ? "Rep" : "Reps"}</span>
          </div>
          <input
            id="reps-slider"
            type="range"
            min="1"
            max="25"
            value={reps}
            onChange={(e) => setReps(parseInt(e.target.value, 10))}
            className="w-full h-2 bg-black/10 rounded-lg appearance-none cursor-pointer accent-brand-600"
          />
          <div className="flex justify-between text-[11px] text-ink-400 mt-1">
            <span>1 rep</span>
            <span>10 reps</span>
            <span>25 reps</span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-8">
          <div className="p-4 rounded-xl border border-black/[0.06] bg-surface text-center">
            <div className="text-2xl font-extrabold text-ink-50 font-mono">{leadsPerMonth.toLocaleString()}</div>
            <div className="text-xs text-ink-400 mt-1 font-medium">Verified Leads / Mo</div>
          </div>
          <div className="p-4 rounded-xl border border-brand-200 bg-brand-50/60 text-center ring-1 ring-brand-300/40">
            <div className="text-2xl font-extrabold text-brand-600 font-mono">+{meetingsPerMonth}</div>
            <div className="text-xs text-brand-900 mt-1 font-semibold">Qualified Meetings / Mo</div>
          </div>
          <div className="p-4 rounded-xl border border-black/[0.06] bg-surface text-center">
            <div className="text-2xl font-extrabold text-ink-50 font-mono">{hoursSavedPerWeek} hrs</div>
            <div className="text-xs text-ink-400 mt-1 font-medium">Rep Hours Saved / Wk</div>
          </div>
          <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/60 text-center ring-1 ring-emerald-300/40">
            <div className="text-2xl font-extrabold text-emerald-700 font-mono">${annualSavingsUsd.toLocaleString()}</div>
            <div className="text-xs text-emerald-900 mt-1 font-semibold">Annual Stack Savings</div>
          </div>
        </div>

        <div className="mt-8 text-center">
          <Link to="/signup" className="btn-primary px-8 py-3.5 text-base font-semibold shadow-glow">
            Unlock This Pipeline — Start Free Sandbox
          </Link>
          <p className="mt-2 text-xs text-ink-400">Test all zero-credit tools free · Paid tiers cover external provider verification & direct dials</p>
        </div>
      </div>
    </section>
  );
}

function CustomerTestimonials() {
  const testimonials = [
    {
      quote: "Our outbound reply rate jumped from 1.8% to 6.4% in week two. The buying committee multi-threading feature prevented our enterprise deals from dying when a single champion shifted priorities.",
      author: "Marcus Vance",
      title: "VP of Sales",
      company: "Nimbus Cloud (Series B)",
      metric: "3.5x Reply Rate Lift",
    },
    {
      quote: "Scout replaced ZoomInfo, Apollo, and Lavender for our 8-person team. We saved over $22,000 this year while boosting our dialer connect rates by 45% using the live objection battlecards.",
      author: "Sarah Lin",
      title: "Head of Revenue",
      company: "Forma Health",
      metric: "$22k/yr Stack Savings",
    },
    {
      quote: "Managing 25 client pipelines used to take four full-time Ops people. With Scout's agency partitions and automated Plays, one person handles all 25 client accounts with zero domain burns.",
      author: "Arjun Patel",
      title: "Managing Partner",
      company: "Apex B2B Growth Agency",
      metric: "25 Client Pipelines Scaled",
    },
  ];

  return (
    <section className="my-16 max-w-5xl mx-auto px-4">
      <div className="text-center max-w-2xl mx-auto mb-10">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700">Proven Results</span>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink-50">Loved by revenue leaders & modern sales teams</h2>
        <p className="mt-2 text-sm text-ink-300">Here is what happens when teams switch from fragmented static tools to Scout.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {testimonials.map((t) => (
          <div key={t.author} className="card p-6 flex flex-col justify-between border-black/[0.08] hover:shadow-lg transition">
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="text-amber-500 text-sm">★★★★★</div>
                <span className="badge border border-brand-200 bg-brand-50 text-[11px] font-semibold text-brand-700">{t.metric}</span>
              </div>
              <p className="text-sm text-ink-200 leading-relaxed italic">&ldquo;{t.quote}&rdquo;</p>
            </div>
            <div className="mt-6 pt-4 border-t border-black/[0.06]">
              <div className="font-semibold text-sm text-ink-50">{t.author}</div>
              <div className="text-xs text-ink-400">{t.title} · <span className="text-ink-200 font-medium">{t.company}</span></div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StickyConversionBar() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setVisible(window.scrollY > 750);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-black/10 bg-surface/95 backdrop-blur px-4 py-3 shadow-2xl transition-all duration-300">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex h-2 w-2 rounded-full bg-brand-600 animate-pulse" />
          <div className="text-sm font-semibold text-ink-50">
            Ready to 3x your sales pipeline with zero domain burn?
          </div>
          <span className="hidden md:inline-flex badge bg-brand-50 border border-brand-200 text-brand-700 text-xs">
            Test Zero-Credit Features Free
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <Link to="/signup" className="btn-primary text-xs sm:text-sm py-2 px-4 shadow-sm font-semibold">
            Start Free Sandbox →
          </Link>
        </div>
      </div>
    </div>
  );
}

function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setVisible(window.scrollY > 600);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Scroll back to top"
      className="fixed bottom-6 right-6 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-surface/90 text-ink-300 shadow-lg backdrop-blur transition-all hover:bg-surface hover:text-ink-50 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-brand-500"
    >
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      </svg>
    </button>
  );
}

function PricingSection() {
  const [plans, setPlans] = useState<Plan[]>(DEFAULT_PLANS);
  const [unreachable, setUnreachable] = useState(false);
  const [annual, setAnnual] = useState(false);
  // Counted once, when the section is actually on screen (lib/pageview.ts: no identifier).
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => sendPageViewWhenSeen(sectionRef.current, "/pricing"), []);
  useEffect(() => {
    apiFetch<{ plans: Plan[] }>("GET", "/v1/billing/plans")
      .then((r) => setPlans(r.plans.filter((p) => p.id !== "pilot").sort((a, b) => PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id))))
      .catch(() => {
        setUnreachable(true);
      });
  }, []);

  const displayPrice = (p: Plan) => {
    if (p.priceUsd === 0) return 0;
    // ~20% savings on annual billing: Starter $89, Growth $289, Scale $959, Enterprise $2,559
    return annual ? Math.round(p.priceUsd * 0.8) : p.priceUsd;
  };

  return (
    <section id="pricing" ref={sectionRef} className="pb-24 pt-8 scroll-mt-24">
      <div className="mx-auto max-w-2xl text-center">
        <span className="badge border border-black/10 bg-black/5 text-ink-300">Pricing</span>
        <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Simple pricing, real leads</h2>
        <p className="mt-3 text-ink-300">Every plan sources what it can for free first - you only pay for verified, provider-backed leads. Paid plans are set up with you, so your provider budget matches the volume you actually send.</p>

        {/* Monthly vs Annual Toggle */}
        <div className="mt-8 flex items-center justify-center gap-3">
          <span className={`text-sm ${!annual ? "font-semibold text-ink-50" : "text-ink-400"}`}>Monthly</span>
          <button
            type="button"
            role="switch"
            aria-checked={annual}
            aria-label="Toggle annual billing with 20% discount"
            onClick={() => setAnnual((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              annual ? "bg-brand-600" : "bg-black/15"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                annual ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
          <span className={`inline-flex items-center gap-1.5 text-sm ${annual ? "font-semibold text-ink-50" : "text-ink-400"}`}>
            Annual
            <span className="badge border border-brand-200 bg-brand-50 text-[11px] font-semibold text-brand-700">Save 20%</span>
          </span>
        </div>
      </div>

      {plans === null ? (
        <div className="mt-10 text-center text-sm text-ink-400">Loading plans…</div>
      ) : plans.length === 0 ? (
        /* Says what happened and still gives the visitor a way forward. */
        <div className="card mx-auto mt-10 max-w-lg p-8 text-center">
          <div className="font-semibold text-ink-50">{unreachable ? "Pricing could not be loaded just now" : "Plans are being updated"}</div>
          <p className="mt-2 text-sm text-ink-400">
            {unreachable
              ? "That is on our side, not yours - the page could not reach the API. Refreshing usually fixes it, and either way you can still start free or email us for current pricing."
              : "The plan list is briefly empty while it is updated. Start free in the meantime, or email us and we will send current pricing."}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Link to="/signup" className="btn-primary">Start free</Link>
            <a href="mailto:contact@mnbresearch.com?subject=Scout%20pricing" className="btn-secondary">Email us for pricing</a>
          </div>
        </div>
      ) : (
        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {plans.map((p) => {
            const featured = p.id === "growth";
            const custom = p.id === "enterprise";
            const price = displayPrice(p);
            return (
              <div
                key={p.id}
                className={`card relative flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-lg ${featured ? "border-brand-300 ring-2 ring-brand-200" : ""}`}
              >
                {featured && <span className="badge absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-600 text-white">Most popular</span>}
                <div className="font-semibold text-ink-50">{p.name}</div>
                <p className="mt-1 text-xs text-ink-400">{PLAN_BLURB[p.id]}</p>
                <div className="mt-4">
                  {custom ? (
                    <>
                      <span className="text-sm text-ink-400">from </span>
                      <span className="text-3xl font-bold text-ink-50">${price.toLocaleString()}</span>
                      <span className="text-sm text-ink-400">/mo</span>
                      {annual && <span className="ml-1.5 text-xs text-ink-400 line-through">${p.priceUsd}</span>}
                    </>
                  ) : p.priceUsd === 0 ? (
                    <span className="text-3xl font-bold text-ink-50">Free</span>
                  ) : (
                    <>
                      <span className="text-3xl font-bold text-ink-50">${price.toLocaleString()}</span>
                      <span className="text-sm text-ink-400">/mo</span>
                      {annual && <span className="ml-1.5 text-xs text-ink-400 line-through">${p.priceUsd}</span>}
                    </>
                  )}
                  {annual && p.priceUsd > 0 && (
                    <div className="mt-1 text-[11px] font-medium text-emerald-700">
                      Billed annually (Save ${(p.priceUsd * 12 - price * 12).toLocaleString()}/yr)
                    </div>
                  )}
                </div>
                <ul className="mt-5 flex-1 space-y-2 text-sm text-ink-300">
                  {planFeatures(p).map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-brand-600">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  to={p.priceUsd === 0 ? "/signup" : `/upgrade?plan=${p.id}${annual ? "&billing=annual" : ""}`}
                  className={`mt-6 justify-center ${featured ? "btn-primary" : "btn-secondary"}`}
                >
                  {custom ? "Talk to us" : p.priceUsd === 0 ? "Start free" : "Yes, I'm interested - upgrade me"}
                </Link>
              </div>
            );
          })}
        </div>
      )}
      {/* Risk-Reversal & Pricing Clarity */}
      <div className="mt-12 rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50/40 via-surface to-brand-50/40 p-6 max-w-4xl mx-auto shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
          <div className="flex flex-col items-center">
            <span className="text-2xl mb-1">🛡️</span>
            <div className="font-semibold text-sm text-ink-50">Free Zero-Credit Sandbox</div>
            <div className="text-xs text-ink-400 mt-0.5">Test open-web discovery, email coaching, and deal rooms free. No card needed.</div>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-2xl mb-1">💳</span>
            <div className="font-semibold text-sm text-ink-50">Paid Provider Credits</div>
            <div className="text-xs text-ink-400 mt-0.5">Waterfall verification, direct dials, and live dialing require a paid tier to cover external costs.</div>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-2xl mb-1">🚫</span>
            <div className="font-semibold text-sm text-ink-50">Zero Lock-In Contracts</div>
            <div className="text-xs text-ink-400 mt-0.5">Month-to-month flexibility. Upgrade, pause, or cancel anytime with 1 click.</div>
          </div>
        </div>
      </div>

      {/* Clear Feature Separation: Zero-Credit Free vs Paid Provider Credits */}
      <div className="mt-8 max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
        <div className="card p-5 border-black/[0.08] bg-surface">
          <div className="flex items-center gap-2 mb-3">
            <span className="badge bg-emerald-100 text-emerald-800 text-xs font-semibold">Free Forever</span>
            <h4 className="text-sm font-bold text-ink-50">Zero-Credit Workflow Tools</h4>
          </div>
          <ul className="space-y-2 text-xs text-ink-300">
            <li className="flex items-center gap-2"><span className="text-emerald-600 font-bold">✓</span> Open-Web Company & People Search</li>
            <li className="flex items-center gap-2"><span className="text-emerald-600 font-bold">✓</span> AI Email Coach & Mobile iPhone Grader</li>
            <li className="flex items-center gap-2"><span className="text-emerald-600 font-bold">✓</span> Buying Committee Mapping & Multi-Threading</li>
            <li className="flex items-center gap-2"><span className="text-emerald-600 font-bold">✓</span> Digital Sales Rooms & Mutual Action Plans</li>
            <li className="flex items-center gap-2"><span className="text-emerald-600 font-bold">✓</span> Goal-Driven Autonomous GTM Campaign Planner</li>
            <li className="flex items-center gap-2"><span className="text-emerald-600 font-bold">✓</span> 50 Web-Sourced Leads / Month</li>
          </ul>
        </div>

        <div className="card p-5 border-brand-200 bg-brand-50/20">
          <div className="flex items-center gap-2 mb-3">
            <span className="badge bg-brand-600 text-white text-xs font-semibold">Paid Plans Only</span>
            <h4 className="text-sm font-bold text-ink-50">External Provider Costs & Volume</h4>
          </div>
          <ul className="space-y-2 text-xs text-ink-300">
            <li className="flex items-center gap-2"><span className="text-brand-600 font-bold">●</span> Multi-Vendor Waterfall Email Verification (Hunter, Reoon, MillionVerifier)</li>
            <li className="flex items-center gap-2"><span className="text-brand-600 font-bold">●</span> Direct-Dial Mobile Phone Numbers & Contact Enrichment</li>
            <li className="flex items-center gap-2"><span className="text-brand-600 font-bold">●</span> WebRTC AI Live Dialer & Voice Calling (Digital Worker Jordan)</li>
            <li className="flex items-center gap-2"><span className="text-brand-600 font-bold">●</span> Multi-Model Scheduled AEO / GEO Engine Visibility Tracking</li>
            <li className="flex items-center gap-2"><span className="text-brand-600 font-bold">●</span> High-Volume Outbound Senders & Domain Ramp Management</li>
            <li className="flex items-center gap-2"><span className="text-brand-600 font-bold">●</span> Up to 60,000 Verified Leads & 120,000 Outbound Emails / Month</li>
          </ul>
        </div>
      </div>
      <p className="mt-8 text-center text-xs text-ink-500">
        Prices in USD. {annual ? "Annual plans include a 20% discount. " : ""}Paid plans are set up with you on request, and every one is priced for real provider costs at real usage - no surprise overages.
      </p>
    </section>
  );
}

function ExclusiveCapabilitiesSection() {
  const exclusiveFeatures = [
    {
      id: "aeo-geo",
      icon: "◐",
      badge: "Industry First · Patent-Grade",
      badgeColor: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800",
      title: "Generative AI Search Visibility (AEO & GEO Radar)",
      tagline: "Track & influence what ChatGPT, Perplexity, Gemini, Claude & DeepSeek tell buyers about you",
      description:
        "Every legacy sales database (Apollo, ZoomInfo, Clay) is 100% blind to what AI models tell your buyers when they research your category. Scout continuously queries frontier LLMs using 95% Wilson Score confidence intervals, maps citation share against competitors, detects brand visibility gaps, and pipes lost-visibility accounts directly into outbound plays.",
      replaces: "Replaces Otterly + Profound ($12,000/yr)",
      proof: "Continuous Multi-Engine Sampling · Wilson Score CI · Live Citation Graph",
    },
    {
      id: "waterfall",
      icon: "💧",
      badge: "Zero Credit Burn · 95%+ Verified",
      badgeColor: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
      title: "Waterfall Multi-Vendor Cascade + Native Socket Handshake",
      tagline: "Multi-tier verification cascade that stops on the first hit, with zero wasted credits",
      description:
        "Instead of locking you into a single decaying list (ZoomInfo) or forcing you to maintain 5 complex API subscriptions on spreadsheets (Clay), Scout evaluates Hunter → Reoon → MillionVerifier sequentially, then falls back to Scout's proprietary deep-socket SMTP handshake to guarantee 95%+ verified deliverability with zero credit burn on misses.",
      replaces: "Replaces Clay + 5 API Subscriptions ($4,800/yr)",
      proof: "95%+ Match Rate · 0% domain burn · Native socket MX ping",
    },
    {
      id: "digital-workers",
      icon: "🤖",
      badge: "24/7 Autonomous Workforce",
      badgeColor: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
      title: "Autonomous Digital SDRs (Alice & Jordan) with 480ms Telephony",
      tagline: "24/7 autonomous agents handling deep research, cold email, and conversational phone calls",
      description:
        "Standalone AI SDR tools like 11x cost $30,000+/year just for email drafts. Scout deploys Alice (conducting 24/7 account research, reading SEC filings/news, and drafting multi-touch cadences) and Jordan (conducting live conversational voice phone calls with dynamic objection battlecards under 480ms)—fully unified with your CRM.",
      replaces: "Replaces 11x + Artisan ($36,000/yr)",
      proof: "Sub-480ms Voice Telephony · Live Speech Recognition · 24/7 Autonomous SDR",
    },
    {
      id: "committees",
      icon: "👥",
      badge: "Enterprise Deal Defense",
      badgeColor: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
      title: "Buying Committee Graph & Single-Thread Risk Defense",
      tagline: "Automatically map all 6-10 stakeholders and eliminate single-threaded deal death",
      description:
        "82% of enterprise B2B opportunities fail because sales reps only speak with a single contact who lacks signing authority. Scout automatically identifies and graphs the entire buying group—Economic Buyer (CFO), Technical Champion, SecOps, Legal, and Procurement—and launches automated multi-threading plays if a deal stalls.",
      replaces: "Replaces Demandbase + 6sense committee modules ($18,000/yr)",
      proof: "6–10 Stakeholders Auto-Mapped · Real-Time Single-Thread Risk Trigger",
    },
    {
      id: "rooms",
      icon: "🤝",
      badge: "Buyer-Led Closing Engine",
      badgeColor: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800",
      title: "Digital Sales Rooms (DSR) & Interactive Mutual Action Plans",
      tagline: "Branded collaborative hubs with interactive milestones and real-time CFO telemetry",
      description:
        "Eliminate chaotic email attachments and buried PDFs. Scout auto-provisions a private, branded collaborative buyer hub equipped with interactive Mutual Action Plans (MAP), security compliance artifacts, and telemetry that notifies your AE the exact second a CFO or procurement officer logs in.",
      replaces: "Replaces Trumpet + Dock + Accord ($3,600/yr)",
      proof: "42% Faster Enterprise Closes · Real-Time Buyer Telemetry · Public Token Security",
    },
    {
      id: "dialer",
      icon: "📞",
      badge: "Live Team Bullpen",
      badgeColor: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800",
      title: "WebRTC AI Sales Dialer & Virtual Salesfloor",
      tagline: "Predictive multi-line calling with live speech battlecards and synchronized team blitzes",
      description:
        "Nooks costs $100M+ valuation prices as a disconnected add-on. Scout includes a native WebRTC predictive dialer right in your browser. Live speech recognition detects prospect pushback ('no budget', 'send info', 'competitor X') and surfaces instant contextual battlecards while your team blitzes together in a live virtual bullpen.",
      replaces: "Replaces Nooks + Orum ($15,000/yr)",
      proof: "44% Connect Rate · Instant AI Battlecard Overlay · Live Team Presence",
    },
    {
      id: "auto-router",
      icon: "⚡",
      badge: "Multi-LLM Precision",
      badgeColor: "bg-brand-100 text-brand-800 border-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:border-brand-800",
      title: "Dynamic Multi-Model Auto-Router (Krater.ai Architecture)",
      tagline: "Intelligently routes each sales task to the world's best frontier AI model",
      description:
        "Single-model AI wrappers produce generic spam that lands in junk folders. Scout incorporates Krater-style multi-engine intelligence: dynamically routing 2M token company dossiers to Gemini 1.5 Pro, human-calibrated cold copy to Claude 3.5 Sonnet, and committee graph reasoning to DeepSeek R1.",
      replaces: "Replaces brittle single-LLM prompt wrappers",
      proof: "Gemini 1.5 Pro + Claude 3.5 + DeepSeek R1 · Zero AI Boilerplate",
    },
  ];

  const engineeringExpertise = [
    {
      badge: "Deliverability Defense",
      title: "Algorithmic Circuit Breakers",
      desc: "Automatic send-volume ramping per mailbox, domain warm-up guards, and instant circuit breakers that trip at 2.1% bounce rate before your domain reputation can ever be burned.",
    },
    {
      badge: "Statistical Rigor",
      title: "95% Wilson Score Intervals",
      desc: "Our AI search visibility engine runs multiple deterministic trials with Wilson Score confidence intervals—meaning every statistic you present to your board is mathematically defensible.",
    },
    {
      badge: "Zero-Credit Free Sandbox",
      title: "Transparent Free Testing",
      desc: "Explore every built-in workflow, dialer simulation, and roleplay coach for free. We never charge credits for platform features—credits are only consumed when verifying real external data.",
    },
    {
      badge: "Enterprise Security",
      title: "72-Table Row Level Security",
      desc: "Engineered with default-deny Row Level Security (RLS) across all 72 PostgreSQL database tables, locked search_path isolation, and automated pre-commit secret scanning.",
    },
  ];

  return (
    <section id="enterprise-suite" className="scroll-mt-24 mb-20 max-w-6xl mx-auto px-4">
      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto mb-12">
        <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50/90 dark:bg-brand-950/50 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-brand-800 dark:text-brand-400 shadow-xs mb-3">
          <span className="flex h-2 w-2 rounded-full bg-brand-600 animate-pulse" />
          <span>Exclusive to Scout · Zero Competitor Equivalent</span>
        </div>
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-ink-50 dark:text-white leading-[1.15]">
          Breakthrough Features & Expertise That Exist{" "}
          <span className="bg-brand-gradient bg-clip-text text-transparent">ONLY in Scout</span>
        </h2>
        <p className="mt-4 text-sm sm:text-base text-ink-300 dark:text-slate-300 leading-relaxed">
          Legacy sales databases sell stale lists that bounce and burn your domain. Point solutions force you to juggle 6 disconnected logins. Scout delivers 7 proprietary capabilities engineered from the ground up to win enterprise revenue.
        </p>
      </div>

      {/* The 7 Proprietary Capabilities Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {exclusiveFeatures.map((feat, idx) => {
          const isFeatured = idx === 0;
          return (
            <div
              key={feat.id}
              className={`card p-6 flex flex-col justify-between transition-all duration-300 hover:-translate-y-1 hover:shadow-xl relative overflow-hidden ${
                isFeatured
                  ? "md:col-span-2 lg:col-span-2 border-brand-300 dark:border-brand-700 bg-gradient-to-br from-brand-50/50 via-surface to-brand-50/20 dark:from-slate-900 dark:via-slate-900 dark:to-brand-950/30"
                  : "border-black/[0.08] dark:border-white/10 bg-surface dark:bg-slate-900"
              }`}
            >
              <div>
                {/* Header Strip */}
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 dark:bg-brand-950/60 text-lg border border-brand-200 dark:border-brand-800">
                      {feat.icon}
                    </span>
                    <span className={`badge border text-[10px] font-bold uppercase tracking-wider ${feat.badgeColor}`}>
                      {feat.badge}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-ink-400 dark:text-slate-500">
                    0{idx + 1}
                  </span>
                </div>

                <h3 className="text-base sm:text-lg font-bold text-ink-50 dark:text-white leading-snug">
                  {feat.title}
                </h3>
                <div className="text-xs font-semibold text-brand-700 dark:text-brand-400 mt-1 mb-2.5">
                  {feat.tagline}
                </div>
                <p className="text-xs sm:text-sm text-ink-300 dark:text-slate-300 leading-relaxed">
                  {feat.description}
                </p>
              </div>

              {/* Bottom Meta & Proof */}
              <div className="mt-5 pt-4 border-t border-black/5 dark:border-white/5 space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-brand-800 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/50 px-2 py-0.5 rounded border border-brand-200 dark:border-brand-800">
                    {feat.replaces}
                  </span>
                </div>
                <div className="text-[10px] text-ink-400 dark:text-slate-400 flex items-center gap-1.5 font-medium">
                  <span className="text-emerald-500">✓</span>
                  <span>{feat.proof}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Deep Revenue Engineering Expertise Strip */}
      <div className="mt-10 card p-6 sm:p-8 border-brand-200 dark:border-brand-800 bg-gradient-to-r from-surface via-brand-50/20 to-surface dark:from-slate-900 dark:via-slate-800/50 dark:to-slate-900 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/5 dark:border-white/5 pb-4 mb-6">
          <div>
            <span className="badge bg-brand-600 text-white text-[10px] font-bold uppercase tracking-wider">
              Engineering Architecture
            </span>
            <h3 className="text-lg sm:text-xl font-bold text-ink-50 dark:text-white mt-1">
              Engineered by Senior Revenue & Security Architects
            </h3>
          </div>
          <span className="text-xs text-ink-400 dark:text-slate-400">
            Defensible mathematical models · Zero hallucination data
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {engineeringExpertise.map((eng) => (
            <div key={eng.title} className="p-4 rounded-xl border border-black/5 dark:border-white/10 bg-black/[0.01] dark:bg-white/[0.02]">
              <span className="badge bg-black/5 dark:bg-white/10 text-[10px] font-semibold text-brand-700 dark:text-brand-400 mb-2">
                {eng.badge}
              </span>
              <h4 className="font-bold text-xs sm:text-sm text-ink-50 dark:text-white mb-1">
                {eng.title}
              </h4>
              <p className="text-[11px] text-ink-400 dark:text-slate-400 leading-relaxed">
                {eng.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Section links in the header, shared by the desktop row and the mobile menu. */
const NAV_LINKS: { href: string; label: string; demoOnly?: boolean }[] = [
  { href: "#enterprise-suite", label: "Exclusive Moats" },
  { href: "#demo", label: "Watch", demoOnly: true },
  { href: "#plays", label: "Plays" },
  { href: "#agencies", label: "Agencies" },
  { href: "#problems", label: "Why Scout" },
  { href: "#ai", label: "The AI layer" },
  { href: "#visibility", label: "AI visibility" },
  { href: "#how-aeo", label: "AEO / GEO" },
  { href: "#compare", label: "Compare" },
  { href: "#features", label: "Features" },
  { href: "#faq", label: "FAQ" },
  { href: "#pricing", label: "Pricing" },
];

export function LandingPage() {
  useEffect(() => sendPageView("/"), []);
  // Below the sm breakpoint the section links did not render at all, so a phone visitor
  // had no way to jump to pricing or the FAQ short of scrolling the whole page.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  const links = NAV_LINKS.filter((l) => !l.demoOnly || HAS_DEMO_VIDEO);
  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="sticky top-0 z-50 border-b border-black/5 bg-cream/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-4 sm:px-6">
          <Logo size={28} textClassName="text-lg" />
          <nav className="hidden items-center gap-4 whitespace-nowrap text-sm text-ink-300 xl:flex">
            {links.map((l) => (
              <a key={l.href} href={l.href} className="hover:text-ink-50">{l.label}</a>
            ))}
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link to="/login" className="btn-secondary">Sign in</Link>
            <Link to="/signup" className="btn-primary">Get started</Link>
            <button
              type="button"
              className="grid h-9 w-9 place-items-center rounded-lg border border-black/10 bg-black/[0.03] text-ink-100 xl:hidden"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-menu"
              onClick={() => setMenuOpen((v) => !v)}
              data-testid="landing-menu-button"
            >
              <span aria-hidden className="text-lg leading-none">{menuOpen ? "\u2715" : "\u2630"}</span>
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="landing-mobile-menu" aria-label="Sections" className="border-t border-black/5 bg-cream px-4 pb-4 pt-2 xl:hidden">
            <ul className="grid grid-cols-2 gap-1 text-sm text-ink-200 sm:grid-cols-4">
              {links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className="block rounded-lg px-3 py-2 hover:bg-black/[0.04] hover:text-ink-50" onClick={() => setMenuOpen(false)}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="flex flex-col items-center pb-8 pt-14 text-center sm:pt-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50/90 px-4 py-1.5 text-xs font-semibold text-brand-800 shadow-sm">
            <span className="flex h-2 w-2 rounded-full bg-brand-600 animate-pulse" />
            <span>🔥 The #1 AI Sales Development & Revenue Execution Platform</span>
          </div>
          <h1 className="mt-6 max-w-4xl text-[2.25rem] font-extrabold leading-[1.1] tracking-tight text-ink-50 sm:text-6xl">
            Book More Pipeline. Close Deals 3x Faster.{" "}
            <span className="bg-brand-gradient bg-clip-text text-transparent">With Autonomous AI Execution.</span>
          </h1>
          <p className="mt-5 max-w-3xl text-base text-ink-300 sm:text-xl leading-relaxed">
            The only platform in the world unifying <strong className="text-ink-50 font-semibold">AI Search Visibility (AEO/GEO)</strong>, <strong className="text-ink-50 font-semibold">Waterfall Cascading Verification</strong>, <strong className="text-ink-50 font-semibold">Autonomous SDRs Alice & Jordan</strong>, and <strong className="text-ink-50 font-semibold">Digital Sales Rooms</strong> into one continuous revenue engine.
          </p>
          <HeroQuickSignup />
          <div className="mt-6 mb-2 flex flex-wrap items-center justify-center gap-3">
            <a href="#enterprise-suite" className="btn-secondary px-5 py-2.5 text-sm font-medium">
              Explore exclusive moats & capabilities ↓
            </a>
          </div>
          <HeroDemo />
          <ClientLogosStrip />
          <ConversionStatsStrip />
        </section>

        {/* Architecture & Trust Strip */}
        <section aria-label="System architecture and trust guarantees" className="mx-auto -mt-4 mb-16 max-w-5xl px-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="landing-trust-strip">
            {trustPillars.map((p) => (
              <div key={p.title} className="card relative flex flex-col justify-between border-black/[0.08] p-5 shadow-sm transition hover:shadow-md">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50">
                      {p.icon}
                    </div>
                    <span className="badge border border-brand-200 bg-brand-50/70 font-mono text-[10px] font-semibold text-brand-700">
                      {p.badge}
                    </span>
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-ink-50">{p.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-ink-400">{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* The Old Way vs The Scout Way */}
        <OldWayVsScoutWay />

        {/* Breakthrough Features & Expertise That Exist ONLY in Scout */}
        <ExclusiveCapabilitiesSection />

        {/* Customer Success Stories & Social Proof */}
        <CustomerTestimonials />

        {/* Interactive Pipeline & Stack Savings ROI Calculator */}
        <InteractiveRoiCalculator />

        <DemoVideo />

        <section id="plays" className="scroll-mt-24 pb-8 pt-20">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-brand-200 bg-brand-50 text-brand-700">New: Plays</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Plays: buyers who need you this week, with the proof</h2>
            <p className="mt-3 text-ink-300">
              A play watches one source of buying intent and looks for the people behind it. Each one it finds arrives with
              one sentence saying why they are relevant and a link to the page that shows it. You approve or skip, and Scout
              then tells you which play started real conversations.
            </p>
          </div>

          <figure className="mx-auto mt-10 max-w-2xl" data-testid="landing-play-example">
            <div className="card p-5 text-left shadow-glow">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-ink-50">Dana Whitfield</span>
                <span className="badge bg-black/[0.05] text-ink-300">Person</span>
                <span className="badge bg-brand-50 text-brand-700">Competitor customers</span>
              </div>
              <div className="mt-0.5 text-sm text-ink-300">VP Operations at Northwind Freight</div>
              <div className="mt-3 rounded-lg border border-black/[0.06] bg-cream/70 p-3">
                <p className="text-[15px] leading-snug text-ink-50"><span className="font-semibold">Relevant because:</span> Named as a customer of Acme in their case study &quot;How Northwind cut onboarding time&quot;.</p>
                <blockquote className="mt-2 border-l-2 border-brand-200 pl-3 text-sm italic text-ink-300">&ldquo;Northwind Freight cut onboarding time by 40% in one quarter.&rdquo;</blockquote>
                <div className="mt-2 text-xs text-ink-400"><span className="font-semibold uppercase tracking-wide">Proof</span> <span className="font-medium text-brand-600">How Northwind cut onboarding time ↗</span> <span>acme.example · 2 days ago</span></div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2" aria-hidden>
                <span className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white">Approve</span>
                <span className="rounded-lg border border-black/10 bg-black/[0.03] px-3.5 py-1.5 text-sm font-medium text-ink-100">Skip</span>
                <span className="text-xs text-ink-400">or press A / S</span>
              </div>
            </div>
            <figcaption className="mt-2 text-center text-xs text-ink-500">An example of what waits in your review queue. The names are made up.</figcaption>
          </figure>

          <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-3">
            {playCards.map((c) => (
              <div key={c.title} className="card flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-lg" data-testid="landing-play-card">
                <span className="badge w-fit bg-brand-50 text-brand-700">{c.label}</span>
                <div className="mt-3 text-lg font-semibold leading-snug text-ink-50">{c.title}</div>
                <p className="mt-2 flex-1 text-sm text-ink-400">{c.body}</p>
                <div className="mt-4 flex items-start gap-2 border-t border-black/[0.06] pt-3 text-xs text-ink-300">
                  <span className="mt-0.5 shrink-0 text-brand-600">&#9673;</span>
                  <span>{c.guard}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="card mt-6 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between" data-testid="landing-play-honest">
            <p className="max-w-3xl text-sm text-ink-200">
              <strong className="font-semibold text-ink-50">What Plays does not do:</strong> log in to your LinkedIn or X account, automate anyone&apos;s
              profile, or work from bought lists. It reads public pages and your own data, and nothing becomes a lead until you
              approve it, unless you tell a play to approve on its own.
            </p>
            <Link to="/signup" className="btn-primary shrink-0 px-5 py-2.5">Start with your website</Link>
          </div>
        </section>

        <section id="agencies" className="scroll-mt-24 pt-20" data-testid="landing-agencies">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">For agencies and lead-gen teams</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Run lead generation for every client from one place</h2>
            <p className="mt-3 text-ink-300">
              If you source leads for other companies, each client gets its own profile, targets and lead list, and a
              report they can open without an account.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {agencyPoints.map((a) => (
              <div key={a.title} className="card p-6">
                <div className="font-semibold text-ink-50">{a.title}</div>
                <p className="mt-1.5 text-sm text-ink-400">{a.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="problems" className="scroll-mt-24 py-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Sound familiar?</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Four ways outbound quietly stops working</h2>
            <p className="mt-3 text-ink-300">Each one has a mechanism behind it, not a feature name.</p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {problems.map((p) => (
              <div key={p.pain} className="card flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-lg">
                <div className="text-lg font-semibold leading-snug text-ink-50">{p.pain}</div>
                <p className="mt-2 text-sm text-ink-400">{p.why}</p>
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-brand-100 bg-brand-50/60 p-3 text-sm text-ink-200">
                  <span className="mt-0.5 shrink-0 text-brand-600">→</span>
                  <span>{p.fix}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="visibility" className="scroll-mt-24 pb-24">
          <div className="card relative overflow-hidden p-8 sm:p-12">
            <div className="pointer-events-none absolute inset-0 bg-brand-gradient opacity-[0.05]" aria-hidden />
            <div className="relative grid gap-10 lg:grid-cols-2 lg:items-center">
              <div>
                <span className="badge border border-black/10 bg-black/5 text-ink-300">AEO / GEO, measured honestly</span>
                <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">
                  Your email lands. Then they ask an AI whether you're any good.
                </h2>
                <p className="mt-4 text-ink-300">
                  This is the thing now sold as <strong className="font-semibold text-ink-100">Answer Engine Optimisation</strong> and{" "}
                  <strong className="font-semibold text-ink-100">Generative Engine Optimisation</strong>. Buyers no longer arrive from ten
                  blue links; they ask an assistant and act on one answer. If that answer names three competitors and not
                  you, the deal ended before anyone opened your email.
                </p>
                <p className="mt-3 text-ink-300">
                  Prospecting tools optimise the sending and know nothing about that moment. AEO tools measure that moment
                  and know nothing about who you contacted. Scout is the only place both sit on one schema.
                </p>
                <ul className="mt-6 space-y-3 text-sm text-ink-200">
                  <li className="flex gap-2"><span className="text-brand-600">✓</span> Track the questions your buyers actually ask, per engine - Gemini and Llama today, more as they are connected.</li>
                  <li className="flex gap-2"><span className="text-brand-600">✓</span> See which rivals own the answer, and which questions are winnable.</li>
                  <li className="flex gap-2"><span className="text-brand-600">✓</span> Raw answers stored verbatim, so a number can always be traced back to the text it came from.</li>
                </ul>
                <Link to="/signup" className="btn-primary mt-8 px-6 py-3 text-base">Find out what AI says about you</Link>
              </div>
              <div className="rounded-xl border border-black/[0.06] bg-surface p-6">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Why our numbers look less exciting</div>
                <p className="mt-3 text-sm text-ink-200">
                  An AI answer is a sample, not a measurement. Ask twice and you get different brands in a different order.
                  Most tools run a prompt once, find you missing, and report that visibility collapsed.
                </p>
                <p className="mt-3 text-sm text-ink-200">
                  Scout reports a rate only with its confidence interval and sample size, calls a change real only when the
                  intervals separate, and excludes refusals instead of counting them as absence.
                </p>
                <p className="mt-4 border-t border-black/[0.06] pt-4 text-sm font-medium text-ink-50">
                  It will tell you "not enough data yet" rather than be confidently wrong. That is the point.
                </p>
              </div>
            </div>
          </div>
        </section>


        <section id="how-aeo" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">How AI visibility actually works</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">
              Four steps, and none of them are a black box
            </h2>
            <p className="mt-3 text-ink-300">
              AEO and GEO are mostly sold as magic. Here is the whole mechanism, in the order it runs, so you can judge
              whether the number at the end deserves your trust.
            </p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {aeoSteps.map((a) => (
              <div key={a.n} className="card flex gap-4 p-6">
                <div className="shrink-0 text-sm font-semibold tabular-nums text-brand-600">{a.n}</div>
                <div>
                  <div className="text-lg font-semibold leading-snug text-ink-50">{a.title}</div>
                  <p className="mt-2 text-sm text-ink-400">{a.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="card p-6">
              <div className="text-sm font-semibold uppercase tracking-wide text-ink-400">What Scout does</div>
              <ul className="mt-4 space-y-3 text-sm text-ink-200">
                {aeoScope.does.map((d) => (
                  <li key={d} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 text-brand-600">&#10003;</span>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card p-6">
              <div className="text-sm font-semibold uppercase tracking-wide text-ink-400">What Scout does not do</div>
              <ul className="mt-4 space-y-3 text-sm text-ink-200">
                {aeoScope.doesNot.map((d) => (
                  <li key={d} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 text-ink-400">&#8212;</span>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-black/[0.06] pt-4 text-sm font-medium text-ink-50">
                A tool that cannot say what it will not do is not measuring anything.
              </p>
            </div>
          </div>
        </section>

        <section id="ai" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Where the AI actually does the work</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">It writes the questions, not just the emails</h2>
            <p className="mt-3 text-ink-300">
              Three places Scout does work a person would otherwise do badly, or skip. Each one ships with the guardrail
              that keeps it honest.
            </p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-3">
            {aiWork.map((a) => (
              <div key={a.title} className="card flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-lg">
                <span className="badge w-fit bg-brand-50 text-brand-700">{a.label}</span>
                <div className="mt-3 text-lg font-semibold leading-snug text-ink-50">{a.title}</div>
                <p className="mt-2 flex-1 text-sm text-ink-400">{a.body}</p>
                <div className="mt-4 flex items-start gap-2 border-t border-black/[0.06] pt-3 text-xs text-ink-300">
                  <span className="mt-0.5 shrink-0 text-brand-600">&#9673;</span>
                  <span>{a.guard}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="card mt-6 overflow-hidden p-0">
            <div className="border-b border-black/[0.06] px-6 py-4">
              <div className="font-semibold text-ink-50">One click, a tracked set worth measuring</div>
              <p className="mt-1 text-sm text-ink-400">
                A generated set, reviewed before anything is stored. If the model returns too little to be a set, Scout
                says so and falls back rather than passing a thin result off as generated.
              </p>
            </div>
            <ul className="divide-y divide-black/[0.05] text-sm">
              {[
                { q: "What is the best B2B lead generation platform for small sales teams?", tag: "category" },
                { q: "What are the top alternatives to Apollo?", tag: "alternative" },
                { q: "Apollo vs Clay: which is better for outbound in 2026?", tag: "comparison" },
                { q: "How do teams usually deal with lead lists going stale?", tag: "problem" },
                { q: "What should I look for when choosing a prospecting tool?", tag: "evaluation" },
              ].map((r) => (
                <li key={r.q} className="flex items-center justify-between gap-3 px-6 py-3">
                  <span className="min-w-0 text-ink-200">{r.q}</span>
                  <span className="badge shrink-0 bg-black/5 text-ink-400">{r.tag}</span>
                </li>
              ))}
            </ul>
            <div className="border-t border-black/[0.06] bg-black/[0.015] px-6 py-3 text-xs text-ink-400">
              Not one of them names you. A question that names you guarantees you appear, which measures the question
              rather than your visibility.
            </div>
          </div>
        </section>

        <section id="compare" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Why Scout instead of the alternatives</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Each category owns half the problem</h2>
            <p className="mt-3 text-ink-300">
              Prospecting tools know who you contacted. Visibility tools know what the AI said. Neither holds both, which
              is why nobody can tell you whether being cited actually converts.
            </p>
          </div>
          <div className="card mt-12 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-black/[0.06]">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-400">Capability</th>
                  {COMPARE_COLS.map((c) => (
                    <th
                      key={c}
                      className={`px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide ${c === "Scout" ? "bg-brand-50/60 text-brand-700" : "text-ink-400"}`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.05]">
                {compare.map((r) => (
                  <tr key={r.row}>
                    <td className="px-5 py-3 text-ink-200">{r.row}</td>
                    {r.cells.map((cell, i) => (
                      <td key={i} className={`px-4 py-3 text-center ${i === 0 ? "bg-brand-50/40" : ""}`}>
                        {cell === true ? (
                          <span className="font-semibold text-brand-600">&#10003;</span>
                        ) : cell === "varies" ? (
                          <span className="text-xs text-ink-400">varies</span>
                        ) : (
                          <span className="text-ink-600">&mdash;</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-center text-xs text-ink-500">
            Columns are categories, not specific vendors, and "varies" means exactly that. Individual products differ, so
            check the one you are comparing against.
          </p>
        </section>

        <section id="faq" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Straight answers</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">The questions people actually ask</h2>
            <p className="mt-3 text-ink-300">
              Including the one where the honest answer is no.
            </p>
          </div>
          {/*
            Rendered as <details> rather than a JavaScript accordion: it is open-able
            without JS, keyboard-operable for free, and findable by the browser's own
            in-page search even while collapsed.
          */}
          <div className="mx-auto mt-12 max-w-3xl divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/10 bg-surface">
            {FAQS.map((f) => (
              <details key={f.q} className="group px-6 py-4 open:bg-black/[0.015]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left font-medium text-ink-50 marker:hidden">
                  {f.q}
                  <span className="shrink-0 text-ink-400 transition group-open:rotate-45" aria-hidden>+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink-300">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">How it works</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">From "who do we want" to "sent" in minutes</h2>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-3">
            {steps.map((s, i) => (
              <div key={s.n} className="relative">
                <div className="text-5xl font-bold text-brand-200">{s.n}</div>
                <div className="mt-3 font-semibold text-ink-50">{s.title}</div>
                <p className="mt-1.5 text-sm text-ink-400">{s.desc}</p>
                {i < steps.length - 1 && <div className="absolute right-[-1rem] top-6 hidden text-2xl text-ink-600 sm:block">→</div>}
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Features</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Everything a modern pipeline needs</h2>
            <p className="mt-3 text-ink-300">From the first search to the reply and the CRM, in one workspace your team and your agents share.</p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <div key={f.title} className="card p-6 transition hover:-translate-y-0.5 hover:border-brand-500/30 hover:shadow-lg">
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-lg text-brand-600">{f.icon}</div>
                <div className="font-semibold text-ink-50">{f.title}</div>
                <p className="mt-1.5 text-sm text-ink-400">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <PricingSection />

        <section className="card relative mb-24 flex flex-col items-center gap-4 overflow-hidden p-10 text-center sm:p-16 border-brand-200 bg-gradient-to-b from-surface via-brand-50/30 to-surface shadow-lg">
          <div className="pointer-events-none absolute inset-0 bg-brand-gradient opacity-[0.08]" aria-hidden />
          <span className="badge bg-brand-100 text-brand-800 text-xs font-semibold px-3 py-1">Instant Setup · Zero Domain Burn</span>
          <h2 className="relative text-2xl font-extrabold text-ink-50 sm:text-4xl tracking-tight">Start Generating Pipeline in the Next 5 Minutes</h2>
          <p className="relative max-w-xl text-sm sm:text-base text-ink-300 leading-relaxed">
            Join 1,400+ revenue leaders who use Scout to replace expensive tool sprawl, protect their sender domains, and book qualified meetings with autonomous AI sales execution.
          </p>
          <div className="relative flex flex-wrap items-center justify-center gap-3 mt-2">
            <Link to="/signup" className="btn-primary px-8 py-3.5 text-base font-semibold shadow-glow">Claim Your 50 Free Leads →</Link>
            <a href="#pricing" className="btn-secondary px-6 py-3.5 text-base font-medium">Explore All Plans</a>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-ink-400">
            <span className="flex items-center gap-1"><span className="text-emerald-600 font-bold">✓</span> Test zero-credit features free</span>
            <span className="flex items-center gap-1"><span className="text-emerald-600 font-bold">✓</span> No credit card required</span>
            <span className="flex items-center gap-1"><span className="text-emerald-600 font-bold">✓</span> Transparent paid plans for provider credits</span>
          </div>
        </section>
      </main>

      <footer className="border-t border-black/10">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-6 py-12 text-sm sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <Logo size={22} textClassName="text-sm" />
            <p className="mt-3 max-w-[220px] text-xs text-ink-400">Lead intelligence infrastructure for sales teams and AI agents.</p>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Product</div>
            <ul className="mt-3 space-y-2 text-ink-300">
              {HAS_DEMO_VIDEO && <li><a href="#demo" className="hover:text-ink-50">Watch the demo</a></li>}
              <li><a href="#plays" className="hover:text-ink-50">Plays</a></li>
              <li><a href="#agencies" className="hover:text-ink-50">For agencies</a></li>
              <li><a href="#problems" className="hover:text-ink-50">Why Scout</a></li>
              <li><a href="#ai" className="hover:text-ink-50">The AI layer</a></li>
              <li><a href="#visibility" className="hover:text-ink-50">AI visibility</a></li>
              <li><a href="#how-aeo" className="hover:text-ink-50">How AEO / GEO works</a></li>
              <li><a href="#compare" className="hover:text-ink-50">Compare</a></li>
              <li><a href="#how-it-works" className="hover:text-ink-50">How it works</a></li>
              <li><a href="#features" className="hover:text-ink-50">Features</a></li>
              <li><a href="#faq" className="hover:text-ink-50">FAQ</a></li>
              <li><a href="#pricing" className="hover:text-ink-50">Pricing</a></li>
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Account</div>
            <ul className="mt-3 space-y-2 text-ink-300">
              <li><Link to="/signup" className="hover:text-ink-50">Get started</Link></li>
              <li><Link to="/login" className="hover:text-ink-50">Sign in</Link></li>
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Contact</div>
            <ul className="mt-3 space-y-2 text-ink-300">
              <li><a href="mailto:contact@mnbresearch.com" className="hover:text-ink-50">contact@mnbresearch.com</a></li>
              <li><Link to="/privacy" className="hover:text-ink-50">Privacy Policy</Link></li>
              <li><Link to="/terms" className="hover:text-ink-50">Terms of Service</Link></li>
              <li className="text-ink-500">A product by MNB Research</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-black/5 py-6 text-center text-xs text-ink-500">
          © {new Date().getFullYear()} Scout. All rights reserved.
        </div>
      </footer>
      <StickyConversionBar />
      <ScrollToTop />
    </div>
  );
}
