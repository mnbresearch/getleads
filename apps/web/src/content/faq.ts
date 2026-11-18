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
 */

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  {
    q: "What is Scout?",
    a: "MNB Scout is an AI-powered prospect discovery, sales intelligence, and custom audience generation platform. Instead of searching static contact lists, you describe your ideal prospect in natural language or structured criteria, and Scout discovers matching people, companies, and opportunities from real-time open-web data and verified sources.",
  },
  {
    q: "Can Scout find individuals?",
    a: "Yes. Scout discovers professionals, decision-makers, founders, C-suite executives, and department leads matching your specific job titles, seniority levels, geographic regions, and company criteria, complete with role context and verified business contact channels.",
  },
  {
    q: "Can Scout find companies?",
    a: "Yes. You can discover companies, startups, agencies, and enterprises by industry, location, headcount, revenue tier, technologies used, recent funding rounds, hiring activity, or public signals, building comprehensive account dossiers.",
  },
  {
    q: "Can I find specific job titles?",
    a: "Yes. You can target specific designations (e.g. Chief Marketing Officer, Head of Supply Chain, VP of Engineering) or broader seniority levels (Director, VP, C-Suite, Founder), with include and exclude filters to pinpoint the exact buyer.",
  },
  {
    q: "Can I customise my search?",
    a: "Yes. Custom targeting is a core capability in Scout. You can combine dozens of filters including industry, geography, company size, revenue, tech stack, hiring signals, leadership changes, and custom keywords to create unique, high-intent audience segments.",
  },
  {
    q: "Can I describe my requirements in natural language?",
    a: "Yes. You can simply type a prompt like 'Find founders of Indian D2C brands with 20 to 200 employees who raised funding in the last 2 years'. Scout's AI translates your plain-English prompt into structured targeting filters automatically.",
  },
  {
    q: "Can Scout find potential customers?",
    a: "Yes. By combining public business signals, high-intent activity triggers (such as hiring surges, tech stack installations, or funding), and your own first-party audience criteria, Scout identifies active buyers ready for your solution.",
  },
  {
    q: "Where does the data come from?",
    a: "Scout discovers data in real time from public web sources, company registries, official job listings, news announcements, and licensed verification providers. Scout does not resell decaying, static databases that your competitors have already exhausted.",
  },
  {
    q: "Can Scout verify email addresses?",
    a: "Yes. Scout performs multi-tier email validation including syntax validation, MX record resolution, domain health checks, and deep SMTP socket verification. Catch-all and risky addresses are clearly flagged, protecting your domain deliverability.",
  },
  {
    q: "Can I upload my own lists?",
    a: "Yes. You can import existing prospect lists via CSV, map custom columns, and let Scout enrich missing company data, discover decision-makers, and verify email addresses across your entire dataset.",
  },
  {
    q: "Can I save searches?",
    a: "Yes. Any natural language or structured search can be saved. Scout can run saved searches on Autopilot, continuously monitoring the web and notifying you whenever new matching prospects or companies appear.",
  },
  {
    q: "Can agencies manage multiple clients?",
    a: "Yes. Scout provides dedicated agency workspaces where you can manage separate client profiles, dedicated lead lists, monthly target quotas with pace tracking, and generate shareable white-labeled client reporting links.",
  },
  {
    q: "Does Scout support CRM integrations?",
    a: "Yes. Scout connects natively to HubSpot, Pipedrive, Zoho CRM, and Google Sheets, alongside webhooks for Zapier and Make, automatically synchronizing discovered leads and outreach status.",
  },
  {
    q: "Is there a free plan or sandbox?",
    a: "Yes. Scout provides a zero-credit free sandbox that allows you to explore the platform, test open-web discovery, and build custom audiences without a credit card. Paid plans provide external data provider verification credits and scaled outreach.",
  },
  {
    q: "Do I need technical knowledge?",
    a: "No. Scout is designed for sales teams, founders, recruiters, and agencies. You can run all searches using plain English or our visual filter builder. For developers and AI agents there is a REST API and a hosted MCP endpoint, so Claude Code or Cursor can use Scout with one command.",
  },
  {
    q: "Can I use Scout through APIs or AI agents?",
    a: "Yes. Scout has a REST API with API key authentication and webhooks, so agents can search, qualify, enrich and draft outreach with the same capabilities as a rep. The hosted MCP endpoint, on the Growth plan and above, gives Claude Code, Cursor and Claude Desktop the same tools with nothing to install: add it with an API key, and every call obeys that key's plan limits and read-only scope.",
  },
];
