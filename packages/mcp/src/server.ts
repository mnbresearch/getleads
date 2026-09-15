#!/usr/bin/env node
/**
 * GetLeads MCP server (stdio). Config for Claude Desktop / Cursor:
 * {
 *   "mcpServers": { "getleads": { "command": "npx", "args": ["-y", "@getleads/mcp"],
 *     "env": { "GETLEADS_API_KEY": "gl_live_...", "GETLEADS_API_URL": "https://api.yourdomain.com" } } }
 * }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GetLeads, GetLeadsError } from "@getleads/sdk";

const gl = new GetLeads();
const server = new McpServer({ name: "getleads", version: "0.1.0" });

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const wrap = <T>(fn: () => Promise<T>) =>
  fn().then(text, (e) => ({ isError: true, ...text(e instanceof GetLeadsError ? { error: e.code, message: e.message, status: e.status, details: e.details } : { error: String(e) }) }));

const sender = z.object({ name: z.string(), company: z.string(), title: z.string().optional(), valueProp: z.string(), signature: z.string().optional(), tone: z.enum(["friendly", "direct", "formal", "casual"]).optional() });

server.tool(
  "prospect",
  "Find B2B decision makers matching a description (e.g. 'Heads of Marketing at D2C brands in Mumbai'). Discovers people, enriches companies, finds + verifies work emails, scores fit. Returns up to 10 leads in one call (5-40s). Optionally drafts a personalized email for each.",
  { query: z.string(), limit: z.number().int().min(1).max(10).default(5), findEmails: z.boolean().default(true), generateEmails: z.boolean().default(false), sender: sender.optional(), save: z.boolean().default(true), country: z.string().length(2).optional() },
  (a) => wrap(() => gl.agent.prospect(a)),
);

server.tool(
  "search_leads_async",
  "Start a larger lead search (up to 200) that runs in the background. Returns searchId + jobId; use get_search_status to poll, then list_leads with tag search:<first 8 chars of searchId>.",
  { query: z.string().optional(), titles: z.array(z.string()).optional(), industries: z.array(z.string()).optional(), locations: z.array(z.string()).optional(), companyDomains: z.array(z.string()).optional(), limit: z.number().int().min(1).max(200).default(25), findEmails: z.boolean().default(true), icpId: z.string().optional(), listId: z.string().optional() },
  (a) => wrap(() => gl.request("POST", "/v1/search", a)),
);
server.tool("get_search_status", "Status of an async search and its resulting lead ids.", { searchId: z.string() }, (a) => wrap(() => gl.search.status(a.searchId)));

server.tool("find_people_at_company", "Find people (with titles) at a specific company.", { companyName: z.string().optional(), companyDomain: z.string().optional(), titles: z.array(z.string()).optional(), limit: z.number().int().min(1).max(50).default(10) }, (a) => wrap(() => gl.search.people(a)));
server.tool("find_companies", "Find companies matching a description / industry / location.", { query: z.string().optional(), industries: z.array(z.string()).optional(), locations: z.array(z.string()).optional(), keywords: z.array(z.string()).optional(), limit: z.number().int().min(1).max(50).default(20) }, (a) => wrap(() => gl.search.companies(a)));
server.tool("enrich_company", "Enrich a company by domain: description, industry hints, tech stack, public emails, team members, social links.", { domain: z.string() }, (a) => wrap(() => gl.enrich.company(a.domain)));
server.tool("find_email", "Find a person's work email from first name, last name and company domain.", { firstName: z.string(), lastName: z.string(), domain: z.string() }, (a) => wrap(() => gl.enrich.findEmail(a)));
server.tool("verify_email", "Verify one or more email addresses (syntax, disposable, MX, SMTP, catch-all).", { emails: z.array(z.string()).min(1).max(50) }, (a) => wrap(() => gl.enrich.verifyEmails(a.emails)));

server.tool("list_leads", "List saved leads with filters.", { q: z.string().optional(), emailStatus: z.string().optional(), minScore: z.number().optional(), tag: z.string().optional(), icpId: z.string().optional(), listId: z.string().optional(), hasEmail: z.enum(["true", "false"]).optional(), sort: z.enum(["score", "created", "updated", "name"]).optional(), limit: z.number().int().max(200).default(25), offset: z.number().int().default(0) }, (a) => wrap(() => gl.leads.list(a)));
server.tool("get_lead", "Get one lead with company details.", { id: z.string() }, (a) => wrap(() => gl.leads.get(a.id)));
server.tool("create_lead", "Create or upsert a lead (dedupes on email / LinkedIn URL).", { firstName: z.string().optional(), lastName: z.string().optional(), fullName: z.string().optional(), title: z.string().optional(), email: z.string().optional(), linkedinUrl: z.string().optional(), companyDomain: z.string().optional(), companyName: z.string().optional(), location: z.string().optional(), tags: z.array(z.string()).optional() }, (a) => wrap(() => gl.leads.create(a)));
server.tool("enrich_lead", "Queue full enrichment for a saved lead (company crawl, email find + verify, rescore).", { id: z.string() }, (a) => wrap(() => gl.enrich.lead(a.id)));
server.tool("tag_leads", "Add/remove tags on leads.", { ids: z.array(z.string()), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }, (a) => wrap(() => gl.leads.tag(a.ids, a.add, a.remove)));

server.tool("create_icp", "Create an Ideal Customer Profile; AI derives lookalike criteria from a description and/or seed customer domains.", { name: z.string(), description: z.string().optional(), product: z.string().optional(), seedDomains: z.array(z.string()).optional(), criteria: z.record(z.array(z.string())).optional() }, (a) => wrap(() => gl.icps.create(a)));
server.tool("score_leads", "Score saved leads against an ICP (0-100 with reasons). assign=true writes scores to leads.", { icpId: z.string(), leadIds: z.array(z.string()).optional(), assign: z.boolean().default(false), aiRerankTop: z.number().int().min(0).max(50).default(0) }, (a) => wrap(() => gl.icps.score(a.icpId, a)));

server.tool("generate_email", "Write an AI-personalized cold email for a lead (by id or inline details).", { leadId: z.string().optional(), lead: z.record(z.unknown()).optional(), sender, instructions: z.string().optional(), stepNo: z.number().int().min(1).default(1), language: z.string().optional() }, (a) => wrap(() => gl.outreach.generate(a)));
server.tool("create_campaign", "Create an email sequence campaign. steps: [{delayDays, subjectTemplate, bodyTemplate, aiPersonalize, aiInstructions}]. Templates support {{first_name}}, {{company}}, {{title}}, {{sender_name}}.", { name: z.string(), emailAccountId: z.string().optional(), listId: z.string().optional(), icpId: z.string().optional(), settings: z.record(z.unknown()).optional(), steps: z.array(z.object({ delayDays: z.number().int().default(0), subjectTemplate: z.string(), bodyTemplate: z.string(), aiPersonalize: z.boolean().default(true), aiInstructions: z.string().optional() })) }, (a) => wrap(() => gl.outreach.createCampaign(a)));
server.tool("enroll_in_campaign", "Enroll leads into a campaign.", { campaignId: z.string(), leadIds: z.array(z.string()).optional(), fromList: z.boolean().default(false), minScore: z.number().optional() }, (a) => wrap(() => gl.outreach.enroll(a.campaignId, a)));
server.tool("start_campaign", "Start sending a campaign (respects daily limits + send window).", { campaignId: z.string() }, (a) => wrap(() => gl.outreach.start(a.campaignId)));
server.tool("pause_campaign", "Pause a campaign.", { campaignId: z.string() }, (a) => wrap(() => gl.outreach.pause(a.campaignId)));
server.tool("campaign_stats", "Sent/open/click/reply stats for a campaign.", { campaignId: z.string() }, (a) => wrap(() => gl.outreach.stats(a.campaignId)));
server.tool("list_campaigns", "List campaigns.", {}, () => wrap(() => gl.outreach.campaigns()));
server.tool("list_email_accounts", "List configured sender accounts.", {}, () => wrap(() => gl.outreach.emailAccounts()));

server.tool("sync_to_crm", "Push leads to a configured CRM integration (hubspot | pipedrive | zoho | cortex | webhook).", { provider: z.string(), leadIds: z.array(z.string()).min(1) }, (a) => wrap(() => gl.account.syncToCrm(a.provider, a.leadIds)));
server.tool("usage", "Current month's usage vs plan limits.", {}, () => wrap(() => gl.account.usage()));
server.tool("analytics", "Workspace analytics overview.", {}, () => wrap(() => gl.account.analytics()));

// ── v2: visitors, signals, monitors, tools, autopilot ──
server.tool("website_visitors", "Companies identified visiting the customer's website (via the GetLeads pixel), sorted by buying intent.", { days: z.number().int().default(30), status: z.string().optional(), limit: z.number().int().default(50) }, (a) => wrap(() => gl.visitors.companies(a)));
server.tool("visitor_decision_makers", "Find decision makers at a company that visited the website and save them as leads.", { domain: z.string(), titles: z.array(z.string()).optional(), limit: z.number().int().default(5), save: z.boolean().default(true) }, (a) => wrap(() => gl.visitors.decisionMakers(a.domain, a)));
server.tool("signals_feed", "Recent intent signals: funding rounds, acquisitions, hiring surges, leadership changes, expansions (from public news).", { type: z.string().optional(), q: z.string().optional(), days: z.number().int().default(14), limit: z.number().int().default(50) }, (a) => wrap(() => gl.signals.feed(a)));
server.tool("signals_scan", "Scan news now for fresh signals matching keywords/industries/locations.", { types: z.array(z.string()).default(["funding", "acquisition"]), keywords: z.array(z.string()).optional(), industries: z.array(z.string()).optional(), locations: z.array(z.string()).optional(), days: z.number().int().default(7) }, (a) => wrap(() => gl.signals.scan(a)));
server.tool("signals_subscribe", "Create a signal subscription that scans every 6h and can auto-create decision-maker leads at matching companies.", { name: z.string(), types: z.array(z.string()), keywords: z.array(z.string()).optional(), industries: z.array(z.string()).optional(), locations: z.array(z.string()).optional(), targetTitles: z.array(z.string()).optional(), autoCreateLeads: z.boolean().default(true), icpId: z.string().optional(), campaignId: z.string().optional() }, (a) => wrap(() => gl.signals.subscribe(a)));
server.tool("create_monitor", "Monitor a LinkedIn post (engagers → leads), a competitor, a keyword, a company's news, or a company's job openings.", { type: z.enum(["linkedin_post", "keyword", "competitor", "company_news", "jobs"]), name: z.string(), target: z.string(), intervalMinutes: z.number().int().default(360) }, (a) => wrap(() => gl.signals.createMonitor(a)));
server.tool("run_monitor", "Run a monitor now and return how many new results were found.", { id: z.string() }, (a) => wrap(() => gl.signals.runMonitor(a.id)));
server.tool("monitor_results", "Results collected by a monitor.", { id: z.string() }, (a) => wrap(() => gl.signals.monitorResults(a.id)));
server.tool("linkedin_to_email", "Resolve LinkedIn profile URLs to name, title, company and a verified work email.", { urls: z.array(z.string()).min(1).max(25), save: z.boolean().default(false) }, (a) => wrap(() => gl.tools.linkedinToEmail(a.urls, a.save)));
server.tool("email_to_linkedin", "Find LinkedIn profiles for email addresses.", { emails: z.array(z.string()).min(1).max(25) }, (a) => wrap(() => gl.tools.emailToLinkedin(a.emails)));
server.tool("colleagues", "Find other people at the same company as a lead (or at a domain).", { leadId: z.string().optional(), companyDomain: z.string().optional(), titles: z.array(z.string()).optional(), limit: z.number().int().default(10), save: z.boolean().default(false) }, (a) => wrap(() => gl.tools.colleagues(a)));
server.tool("decision_makers", "Find decision makers at a company by persona (CEO / Founder, Sales leader, CMO / Marketing, CTO / Engineering, CFO / Finance, COO / Operations, HR / People, Product, IT / Security, Procurement) with emails.", { companyDomain: z.string().optional(), companyName: z.string().optional(), personas: z.array(z.string()).optional(), limit: z.number().int().default(6), findEmails: z.boolean().default(true), save: z.boolean().default(true) }, (a) => wrap(() => gl.tools.decisionMakers(a)));
server.tool("company_intel", "Company intelligence: description, tech stack, open roles by function (hiring signal), recent funding/news, intent score.", { domain: z.string() }, (a) => wrap(() => gl.tools.companyIntel(a.domain)));
server.tool("domain_health", "Check a sender domain's SPF, DKIM, DMARC and MX for deliverability, with recommendations.", { domain: z.string() }, (a) => wrap(() => gl.tools.domainHealth(a.domain)));
server.tool("verify_batch", "Verify up to 500 emails and get a status summary.", { emails: z.array(z.string()).min(1).max(500) }, (a) => wrap(() => gl.tools.verifyBatch(a.emails)));
server.tool("list_tasks", "Pending human tasks from multichannel sequences (LinkedIn connects/messages, calls, WhatsApp).", { status: z.string().default("pending") }, (a) => wrap(() => gl.tools.tasks(a.status)));
server.tool("complete_task", "Mark a task done/skipped; the contact's sequence advances to the next step.", { id: z.string(), outcome: z.enum(["done", "skipped"]).default("done"), note: z.string().optional() }, (a) => wrap(() => gl.tools.completeTask(a.id, a.outcome, a.note)));
server.tool("create_autopilot", "Create an autonomous daily prospecting agent: finds N fresh leads for a query every day, verifies, scores, saves to a list and optionally enrolls in a campaign.", { name: z.string(), query: z.string(), icpId: z.string().optional(), listId: z.string().optional(), campaignId: z.string().optional(), dailyLeads: z.number().int().default(10), minScore: z.number().int().default(60), requireValidEmail: z.boolean().default(true), autoEnroll: z.boolean().default(false), runHourUtc: z.number().int().default(3) }, (a) => wrap(() => gl.tools.createAutopilot({ ...a, query: { query: a.query } })));
server.tool("run_autopilot", "Run an autopilot now (background job).", { id: z.string() }, (a) => wrap(() => gl.tools.runAutopilot(a.id)));
server.tool("set_lead_status", "Move a lead through the pipeline: new | contacted | engaged | replied | qualified | customer | lost.", { id: z.string(), status: z.string() }, (a) => wrap(() => gl.tools.setLeadStatus(a.id, a.status)));

const transport = new StdioServerTransport();
await server.connect(transport);
