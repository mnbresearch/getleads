/** Hand-maintained OpenAPI 3.1 document. Served at /openapi.json and rendered at /docs. */
export function openapi(apiUrl: string) {
  const sec = [{ bearerAuth: [] }, { apiKey: [] }];
  const j = (schema: unknown) => ({ content: { "application/json": { schema } } });
  const ok = (schema: unknown = { type: "object" }) => ({ "200": { description: "OK", ...j(schema) } });
  const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
  const arr = (items: unknown = { type: "string" }) => ({ type: "array", items });
  const str = { type: "string" };
  const num = { type: "number" };
  const bool = { type: "boolean" };

  const searchBody = obj({
    query: { ...str, description: "Natural-language description, e.g. 'Heads of Sales at Series A fintechs in Bengaluru'" },
    titles: arr(),
    industries: arr(),
    locations: arr(),
    companySizes: arr(),
    keywords: arr(),
    companyDomains: arr(),
    limit: { type: "integer", default: 25, maximum: 200 },
    findEmails: { ...bool, default: true },
    icpId: str,
    listId: str,
    country: { ...str, description: "ISO 2-letter, biases search" },
  });
  const leadBody = obj({ firstName: str, lastName: str, fullName: str, title: str, email: str, linkedinUrl: str, phone: str, location: str, country: str, companyDomain: str, companyName: str, icpId: str, tags: arr(), custom: { type: "object" } });

  return {
    openapi: "3.1.0",
    info: {
      title: "GetLeads API",
      version: "1.0.0",
      description:
        "Lead generation infrastructure for sales teams and AI agents: real-time B2B discovery, company enrichment, email finding + verification, ICP lookalike scoring, AI-personalized outreach, sequences, tracking, webhooks and CRM sync.\n\nAuthenticate with `x-api-key: gl_live_...` (recommended for agents) or `Authorization: Bearer <jwt>`.\n\nLong-running operations return `202` with a `jobId`; poll `GET /v1/search/{id}` or `GET /v1/search/jobs/{jobId}`.",
    },
    servers: [{ url: apiUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    security: sec,
    paths: {
      "/v1/auth/signup": { post: { tags: ["Auth"], security: [], summary: "Create workspace + user; returns JWT and an API key", requestBody: j(obj({ email: str, password: str, name: str, orgName: str, inviteCode: str }, ["email", "password"])), responses: ok() } },
      "/v1/auth/login": { post: { tags: ["Auth"], security: [], summary: "Login", requestBody: j(obj({ email: str, password: str }, ["email", "password"])), responses: ok() } },
      "/v1/auth/me": { get: { tags: ["Auth"], summary: "Current identity + plan limits", responses: ok() } },
      "/v1/auth/api-keys": { get: { tags: ["Auth"], summary: "List API keys", responses: ok() }, post: { tags: ["Auth"], summary: "Create API key", requestBody: j(obj({ name: str }, ["name"])), responses: ok() } },
      "/v1/search": {
        post: { tags: ["Discovery"], summary: "Start a lead search (async). Discovers people, enriches companies, finds + verifies emails, scores against ICP, saves leads.", requestBody: j(searchBody), responses: { "202": { description: "Queued", ...j(obj({ search: { type: "object" }, jobId: str, poll: str })) } } },
        get: { tags: ["Discovery"], summary: "Recent searches", responses: ok() },
      },
      "/v1/search/{id}": { get: { tags: ["Discovery"], summary: "Search status + resulting lead ids", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok(obj({ search: { type: "object" }, job: { type: "object" }, leadIds: arr() })) } },
      "/v1/search/quick": { post: { tags: ["Discovery"], summary: "Synchronous quick prospect (≤10 results, 5-40s). Ideal for agents.", requestBody: j({ ...searchBody, properties: { ...searchBody.properties, limit: { type: "integer", default: 5, maximum: 10 }, save: { ...bool, default: false } } }), responses: ok(obj({ results: arr({ type: "object" }) })) } },
      "/v1/search/parse": { post: { tags: ["Discovery"], summary: "Parse natural-language query into structured filters", requestBody: j(obj({ query: str }, ["query"])), responses: ok() } },
      "/v1/search/people": { post: { tags: ["Discovery"], summary: "Find people at a company", requestBody: j(obj({ companyName: str, companyDomain: str, titles: arr(), locations: arr(), limit: { type: "integer", default: 10 } })), responses: ok() } },
      "/v1/search/companies": { post: { tags: ["Discovery"], summary: "Find companies matching a description", requestBody: j(obj({ query: str, industries: arr(), locations: arr(), keywords: arr(), limit: { type: "integer", default: 20 }, resolveDomains: { ...bool, default: true } })), responses: ok() } },
      "/v1/search/company/enrich": { post: { tags: ["Enrichment"], summary: "Enrich a company by domain (website crawl: description, emails, tech stack, team, socials)", requestBody: j(obj({ domain: str }, ["domain"])), responses: ok() } },
      "/v1/search/verify": { post: { tags: ["Enrichment"], summary: "Verify email(s): syntax, disposable, MX, SMTP handshake, catch-all", requestBody: j(obj({ email: str, emails: arr() })), responses: ok() } },
      "/v1/search/find-email": { post: { tags: ["Enrichment"], summary: "Find a work email from name + domain", requestBody: j(obj({ firstName: str, lastName: str, domain: str }, ["firstName", "lastName", "domain"])), responses: ok() } },
      "/v1/search/jobs/{jobId}": { get: { tags: ["Discovery"], summary: "Job status", parameters: [{ name: "jobId", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/leads": {
        get: { tags: ["Leads"], summary: "List leads with filters", parameters: ["q", "emailStatus", "minScore", "tag", "icpId", "listId", "companyDomain", "seniority", "department", "hasEmail", "sort", "order", "limit", "offset"].map((n) => ({ name: n, in: "query", schema: str })), responses: ok() },
        post: { tags: ["Leads"], summary: "Create/upsert a lead", requestBody: j(leadBody), responses: ok() },
      },
      "/v1/leads/import": { post: { tags: ["Leads"], summary: "Bulk import (JSON array or CSV body)", requestBody: { content: { "application/json": { schema: arr(leadBody) }, "text/csv": { schema: str } } }, responses: ok() } },
      "/v1/leads/export.csv": { get: { tags: ["Leads"], summary: "Export CSV (same filters as list)", responses: { "200": { description: "CSV" } } } },
      "/v1/leads/{id}": {
        get: { tags: ["Leads"], summary: "Get lead with company", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() },
        patch: { tags: ["Leads"], summary: "Update lead", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(leadBody), responses: ok() },
        delete: { tags: ["Leads"], summary: "Delete lead", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() },
      },
      "/v1/leads/{id}/enrich": { post: { tags: ["Enrichment"], summary: "Queue enrichment (company crawl + email find/verify + rescore)", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: { "202": { description: "Queued" } } } },
      "/v1/leads/{id}/verify": { post: { tags: ["Enrichment"], summary: "Verify lead email now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/leads/{id}/find-email": { post: { tags: ["Enrichment"], summary: "Find lead email now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/leads/bulk/enrich": { post: { tags: ["Enrichment"], summary: "Queue enrichment for many leads", requestBody: j(obj({ ids: arr() }, ["ids"])), responses: { "202": { description: "Queued" } } } },
      "/v1/leads/bulk/tag": { post: { tags: ["Leads"], summary: "Add/remove tags", requestBody: j(obj({ ids: arr(), add: arr(), remove: arr() }, ["ids"])), responses: ok() } },
      "/v1/leads/lists/all": { get: { tags: ["Lists"], summary: "List lists", responses: ok() } },
      "/v1/leads/lists": { post: { tags: ["Lists"], summary: "Create list", requestBody: j(obj({ name: str, description: str }, ["name"])), responses: ok() } },
      "/v1/leads/lists/{listId}/leads": { post: { tags: ["Lists"], summary: "Add leads to list", parameters: [{ name: "listId", in: "path", required: true, schema: str }], requestBody: j(obj({ ids: arr() }, ["ids"])), responses: ok() } },
      "/v1/icps": {
        get: { tags: ["ICP"], summary: "List ideal customer profiles", responses: ok() },
        post: { tags: ["ICP"], summary: "Create ICP; AI builds lookalike criteria from description + seed customer domains", requestBody: j(obj({ name: str, description: str, product: str, seedDomains: arr(), criteria: { type: "object" }, buildWithAi: { ...bool, default: true } }, ["name"])), responses: ok() },
      },
      "/v1/icps/{id}/score": { post: { tags: ["ICP"], summary: "Score leads against ICP (rules + optional AI re-rank)", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ leadIds: arr(), assign: bool, aiRerankTop: { type: "integer", default: 0 } })), responses: ok() } },
      "/v1/campaigns": {
        get: { tags: ["Outreach"], summary: "List campaigns", responses: ok() },
        post: { tags: ["Outreach"], summary: "Create campaign with sequence steps", requestBody: j(obj({ name: str, icpId: str, listId: str, emailAccountId: str, settings: { type: "object" }, steps: arr(obj({ delayDays: num, subjectTemplate: str, bodyTemplate: str, aiPersonalize: bool, aiInstructions: str })) }, ["name"])), responses: ok() },
      },
      "/v1/campaigns/generate": { post: { tags: ["Outreach"], summary: "Generate an AI-personalized email for a lead (no campaign needed)", requestBody: j(obj({ leadId: str, lead: { type: "object" }, sender: obj({ name: str, company: str, title: str, valueProp: str, signature: str, tone: str }, ["name", "company", "valueProp"]), instructions: str, stepNo: num, language: str }, ["sender"])), responses: ok(obj({ subject: str, body: str, personalized: bool })) } },
      "/v1/campaigns/inbound": { post: { tags: ["Outreach"], summary: "Ingest an inbound reply (stops sequence, classifies intent)", requestBody: j(obj({ from: str, text: str, subject: str }, ["from"])), responses: ok() } },
      "/v1/campaigns/email-accounts": { get: { tags: ["Outreach"], summary: "List sender accounts", responses: ok() }, post: { tags: ["Outreach"], summary: "Add sender (Resend / SMTP / system)", requestBody: j(obj({ provider: { ...str, enum: ["resend", "smtp", "system"] }, fromName: str, fromEmail: str, replyTo: str, signature: str, dailyLimit: num, config: { type: "object" } }, ["provider", "fromName", "fromEmail"])), responses: ok() } },
      "/v1/campaigns/{id}/enroll": { post: { tags: ["Outreach"], summary: "Enroll leads", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ leadIds: arr(), fromList: bool, minScore: num })), responses: ok() } },
      "/v1/campaigns/{id}/start": { post: { tags: ["Outreach"], summary: "Start campaign", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/campaigns/{id}/pause": { post: { tags: ["Outreach"], summary: "Pause campaign", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/campaigns/{id}/preview": { post: { tags: ["Outreach"], summary: "Preview personalized copy for a lead", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ leadId: str, stepNo: num }, ["leadId"])), responses: ok() } },
      "/v1/campaigns/{id}/stats": { get: { tags: ["Outreach"], summary: "Campaign stats", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/usage": { get: { tags: ["Account"], summary: "Monthly usage vs plan limits", responses: ok() } },
      "/v1/analytics/overview": { get: { tags: ["Account"], summary: "Dashboard analytics", responses: ok() } },
      "/v1/events": { get: { tags: ["Account"], summary: "Event log", responses: ok() } },
      "/v1/webhooks": { get: { tags: ["Account"], summary: "List webhooks", responses: ok() }, post: { tags: ["Account"], summary: "Create webhook (HMAC-signed; events: lead.created, lead.enriched, lead.verified, lead.replied, search.completed, message.sent/opened/clicked, campaign.started, *)", requestBody: j(obj({ url: str, events: arr() }, ["url"])), responses: ok() } },
      "/v1/integrations": { get: { tags: ["Account"], summary: "List CRM integrations", responses: ok() } },
      "/v1/integrations/{provider}": { put: { tags: ["Account"], summary: "Configure CRM integration (hubspot | pipedrive | zoho | cortex | webhook | sheets)", parameters: [{ name: "provider", in: "path", required: true, schema: str }], requestBody: j(obj({ config: { type: "object" }, autoSync: bool }, ["config"])), responses: ok() } },
      "/v1/integrations/{provider}/sync": { post: { tags: ["Account"], summary: "Push leads to CRM", parameters: [{ name: "provider", in: "path", required: true, schema: str }], requestBody: j(obj({ leadIds: arr() }, ["leadIds"])), responses: { "202": { description: "Queued" } } } },
      "/px/{key}.js": { get: { tags: ["Visitors"], security: [], summary: "Website visitor pixel script (embed on your site)", parameters: [{ name: "key", in: "path", required: true, schema: str }], responses: { "200": { description: "JavaScript" } } } },
      "/v1/visitors/pixels": { get: { tags: ["Visitors"], summary: "List pixels + embed snippets", responses: ok() }, post: { tags: ["Visitors"], summary: "Create a pixel for a website", requestBody: j(obj({ name: str, allowedDomains: arr() }, ["name"])), responses: ok() } },
      "/v1/visitors": { get: { tags: ["Visitors"], summary: "Identified visiting companies sorted by intent (ISPs/hosting filtered)", parameters: [{ name: "days", in: "query", schema: num }, { name: "status", in: "query", schema: str }], responses: ok() } },
      "/v1/visitors/{domain}/decision-makers": { post: { tags: ["Visitors"], summary: "Find + save decision makers at a visiting company", parameters: [{ name: "domain", in: "path", required: true, schema: str }], requestBody: j(obj({ titles: arr(), limit: num, save: bool })), responses: ok() } },
      "/v1/signals": { get: { tags: ["Signals"], summary: "Intent signal feed (funding, acquisition, hiring, leadership, expansion, launch, partnership)", parameters: ["type", "q", "matched", "days", "limit"].map((n) => ({ name: n, in: "query", schema: str })), responses: ok() } },
      "/v1/signals/scan": { post: { tags: ["Signals"], summary: "Scan news now for signals", requestBody: j(obj({ types: arr(), keywords: arr(), industries: arr(), locations: arr(), days: num })), responses: ok() } },
      "/v1/signals/subscriptions": { get: { tags: ["Signals"], summary: "List subscriptions", responses: ok() }, post: { tags: ["Signals"], summary: "Subscribe: scan every 6h, auto-create decision-maker leads, optionally enroll in a campaign", requestBody: j(obj({ name: str, types: arr(), keywords: arr(), industries: arr(), locations: arr(), targetTitles: arr(), autoCreateLeads: bool, icpId: str, campaignId: str }, ["name", "types"])), responses: ok() } },
      "/v1/signals/subscriptions/{id}/run": { post: { tags: ["Signals"], summary: "Run a subscription now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/signals/monitors": { get: { tags: ["Signals"], summary: "List monitors", responses: ok() }, post: { tags: ["Signals"], summary: "Create monitor: linkedin_post (engagers → leads) | keyword | competitor | company_news | jobs", requestBody: j(obj({ type: str, name: str, target: str, config: { type: "object" }, intervalMinutes: num }, ["type", "name", "target"])), responses: ok() } },
      "/v1/signals/monitors/{id}/run": { post: { tags: ["Signals"], summary: "Run monitor now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/signals/monitors/{id}/results": { get: { tags: ["Signals"], summary: "Monitor results", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/tools/linkedin-to-email": { post: { tags: ["Tools"], summary: "LinkedIn URLs → person + verified work email", requestBody: j(obj({ urls: arr(), save: bool }, ["urls"])), responses: ok() } },
      "/v1/tools/email-to-linkedin": { post: { tags: ["Tools"], summary: "Emails → LinkedIn profiles", requestBody: j(obj({ emails: arr() }, ["emails"])), responses: ok() } },
      "/v1/tools/colleagues": { post: { tags: ["Tools"], summary: "Colleagues of a lead / people at a domain", requestBody: j(obj({ leadId: str, companyDomain: str, titles: arr(), limit: num, save: bool })), responses: ok() } },
      "/v1/tools/decision-makers": { post: { tags: ["Tools"], summary: "Decision makers at a company by persona, with emails", requestBody: j(obj({ companyDomain: str, companyName: str, personas: arr(), limit: num, findEmails: bool, save: bool })), responses: ok() } },
      "/v1/tools/personas": { get: { tags: ["Tools"], summary: "Persona → title mappings", responses: ok() } },
      "/v1/tools/company-intel": { post: { tags: ["Tools"], summary: "Company intelligence: hiring by function, recent news signals, intent score", requestBody: j(obj({ domain: str }, ["domain"])), responses: ok() } },
      "/v1/tools/domain-health": { get: { tags: ["Tools"], summary: "Sender domain SPF/DKIM/DMARC/MX check", parameters: [{ name: "domain", in: "query", required: true, schema: str }], responses: ok() } },
      "/v1/tools/verify-batch": { post: { tags: ["Tools"], summary: "Verify up to 500 emails", requestBody: j(obj({ emails: arr() }, ["emails"])), responses: ok() } },
      "/v1/tools/batch-enrich": { post: { tags: ["Tools"], summary: "Queue enrichment for many leads / a list", requestBody: j(obj({ leadIds: arr(), listId: str, onlyMissingEmail: bool, limit: num })), responses: { "202": { description: "Queued" } } } },
      "/v1/tools/saved-searches": { get: { tags: ["Tools"], summary: "Saved searches", responses: ok() }, post: { tags: ["Tools"], summary: "Save a search (optionally daily alert + list)", requestBody: j(obj({ name: str, query: { type: "object" }, alert: bool, alertEmail: str, listId: str }, ["name", "query"])), responses: ok() } },
      "/v1/tools/tasks": { get: { tags: ["Tools"], summary: "Tasks (manual sequence steps)", parameters: [{ name: "status", in: "query", schema: str }], responses: ok() }, post: { tags: ["Tools"], summary: "Create task", requestBody: j(obj({ leadId: str, type: str, title: str, body: str, dueAt: str }, ["title"])), responses: ok() } },
      "/v1/tools/tasks/{id}/complete": { post: { tags: ["Tools"], summary: "Complete/skip a task; advances the sequence", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ outcome: str, note: str })), responses: ok() } },
      "/v1/tools/team": { get: { tags: ["Account"], summary: "Team members + seats", responses: ok() } },
      "/v1/tools/team/invite": { post: { tags: ["Account"], summary: "Invite a teammate", requestBody: j(obj({ email: str, role: str }, ["email"])), responses: ok() } },
      "/v1/tools/autopilots": { get: { tags: ["Autopilot"], summary: "List autopilots", responses: ok() }, post: { tags: ["Autopilot"], summary: "Create an autonomous daily prospecting agent", requestBody: j(obj({ name: str, query: { type: "object" }, icpId: str, listId: str, campaignId: str, dailyLeads: num, minScore: num, requireValidEmail: bool, autoEnroll: bool, runHourUtc: num }, ["name", "query"])), responses: ok() } },
      "/v1/tools/autopilots/{id}/run": { post: { tags: ["Autopilot"], summary: "Run now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: { "202": { description: "Queued" } } } },
      "/v1/tools/leads/{id}/status": { post: { tags: ["Leads"], summary: "Set pipeline status (new|contacted|engaged|replied|qualified|customer|lost)", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ status: str }, ["status"])), responses: ok() } },
      "/v1/agent/prospect": { post: { tags: ["Agents"], summary: "One-call agent workflow: describe who you want → verified leads + optional personalized emails", requestBody: j(obj({ query: str, limit: { type: "integer", default: 5, maximum: 10 }, generateEmails: bool, sender: { type: "object" }, save: bool }, ["query"])), responses: ok() } },
    },
  };
}

export const docsHtml = (specUrl: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>GetLeads API Docs</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:${JSON.stringify(specUrl)},dom_id:'#ui',persistAuthorization:true})</script>
</body></html>`;
