import { fetchPublic, isPublicHost, parseHttpUrl, readCapped } from "@prospex/core";
import { and, companies, eq, getDb, integrations, leads, type Integration, type Lead } from "@prospex/db";
import { CredentialUnreadableError, decryptJsonStrict } from "../lib/crypto.js";

/**
 * Outbound CRM sync. Each provider maps a Prospex lead to its contact object.
 * All of these have free tiers: HubSpot (free CRM), Pipedrive (trial), Zoho (free 3 users),
 * Google Sheets (via Apps Script webhook), Cortex / any custom endpoint (generic webhook).
 *
 * Every request here goes to a destination a tenant chose or influenced, from inside our
 * network, carrying a lead record. The rules that follow from that:
 *
 *   - the destination is validated when the connection is SAVED (`validateIntegrationConfig`,
 *     called by the route) and again when it is USED (`syncLead`), because rows saved before
 *     the validation existed are still in the table;
 *   - a tenant-influenced host is reached through `fetchPublic`, which refuses anything
 *     that is not a public address - by literal, by what the name resolves to, at connect
 *     time;
 *   - redirects are never followed with the payload;
 *   - a response is read up to a small cap, within a deadline, and never echoed back: an
 *     error carries a status code and a category, not the first bytes of whatever answered.
 */

type Cfg = Record<string, string>;
type SyncResult = { ok: boolean; externalId?: string; error?: string };

/** How long a CRM or webhook gets to answer, and how much of its answer is read. */
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/* ───────────────────────────────── config validation ───────────────────────────────── */

/** Zoho CRM's API hosts, one per data centre. `api_domain` in Zoho's OAuth response is one of these. */
const ZOHO_API_HOSTS = new Set([
  "www.zohoapis.com",
  "www.zohoapis.eu",
  "www.zohoapis.in",
  "www.zohoapis.com.au",
  "www.zohoapis.jp",
  "www.zohoapis.ca",
  "www.zohoapis.sa",
  "www.zohoapis.com.cn",
  "www.zohoapis.uk",
]);
const ZOHO_DEFAULT_API_DOMAIN = "https://www.zohoapis.in";

/** The config keys each lead-sync provider reads. Anything else is dropped on save. */
const KNOWN_KEYS: Record<string, string[]> = {
  hubspot: ["accessToken"],
  pipedrive: ["apiToken", "companyDomain"],
  zoho: ["accessToken", "apiDomain"],
  cortex: ["url", "authHeader"],
  webhook: ["url", "authHeader"],
  sheets: ["url", "authHeader"],
};

/** Zoho `apiDomain` -> canonical "https://www.zohoapis.xx", or null when it is not one of Zoho's. */
function normalizeZohoApiDomain(raw: string): string | null {
  const v = raw.trim();
  if (/^http:\/\//i.test(v)) return null; // the access token is a bearer credential: https only
  const u = parseHttpUrl(/^https:\/\//i.test(v) ? v : `https://${v}`);
  if (!u || u.protocol !== "https:" || u.port || u.search) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  let host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (/^zohoapis\./.test(host)) host = `www.${host}`;
  return ZOHO_API_HOSTS.has(host) ? `https://${host}` : null;
}

/** Pipedrive `companyDomain` -> the bare subdomain label, or null. Accepts a pasted full host or URL. */
function normalizePipedriveDomain(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.pipedrive\.com$/, "");
  if (!/^[a-z0-9-]{1,63}$/.test(v) || v.startsWith("-") || v.endsWith("-")) return null;
  return v;
}

/** A URL without its credentials, query or fragment - safe to put in an error or a log. */
function displayUrl(raw: string): string {
  const u = parseHttpUrl(raw, { allowUserinfo: true });
  if (!u) return String(raw).replace(/\/\/[^/@]*@/, "//").slice(0, 120);
  return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 160);
}

/**
 * Check, and canonicalise, the config for an integration before it is stored or used.
 *
 * The request host of two providers used to come straight from this config with no check:
 * Zoho's `apiDomain` was prefixed onto the path as typed, and Pipedrive's `companyDomain`
 * was interpolated into a hostname - so `apiDomain: "http://169.254.169.254"` or
 * `companyDomain: "127.0.0.1:8080/x?"` turned "sync this lead" into a request to our own
 * network, with the first bytes of the response stored in the job error for the tenant to
 * read back.
 *
 * Returns the config to store (`config`), or a message fit to show the person saving it.
 *   - zoho: `apiDomain`, when given, must be one of Zoho's API hosts over https, no path.
 *   - pipedrive: `companyDomain`, when given, must be a single subdomain label.
 *   - any provider: `url`, when given, must be http(s) and a public address.
 *   - cortex / webhook / sheets: `url` is required.
 *   - known providers: keys the provider does not read are dropped. Other providers
 *     (the channel/data providers that share this table) keep every key.
 * Values are trimmed; non-string values are dropped. Whether a required credential is
 * present is the route's check, not this one's.
 */
export function validateIntegrationConfig(provider: string, config: unknown): { ok: true; config: Record<string, string> } | { ok: false; message: string } {
  if (!config || typeof config !== "object" || Array.isArray(config)) return { ok: false, message: "The connection settings are missing." };
  const known = KNOWN_KEYS[provider];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    if (known && !known.includes(k)) continue;
    out[k] = v.trim();
  }

  if (provider === "zoho") {
    if (out.apiDomain) {
      const d = normalizeZohoApiDomain(out.apiDomain);
      if (!d) return { ok: false, message: `The Zoho API domain must be one of Zoho's own API addresses, for example https://www.zohoapis.in or https://www.zohoapis.com - with https:// and nothing after the domain.` };
      out.apiDomain = d;
    } else delete out.apiDomain;
  }

  if (provider === "pipedrive") {
    if (out.companyDomain) {
      const d = normalizePipedriveDomain(out.companyDomain);
      if (!d) return { ok: false, message: `The Pipedrive company subdomain is the first part of your Pipedrive address - "mycompany" for mycompany.pipedrive.com. Letters, digits and hyphens only.` };
      out.companyDomain = d;
    } else delete out.companyDomain;
  }

  if (provider === "cortex" || provider === "webhook" || provider === "sheets") {
    if (!out.url) return { ok: false, message: "Enter the URL to send leads to." };
  }

  if (out.url !== undefined && out.url !== "") {
    if (out.url.length > 2048) return { ok: false, message: "That URL is too long." };
    const u = parseHttpUrl(out.url, { allowUserinfo: true });
    if (!u) return { ok: false, message: "The URL must be a full http:// or https:// address." };
    if (!isPublicHost(u.href, { allowUserinfo: true })) {
      return { ok: false, message: `${displayUrl(out.url)} is not a public address (localhost, private network or internal host), so Scout cannot send to it. Use a URL reachable from the internet.` };
    }
    // Stored without its fragment, which is never sent.
    out.url = u.href;
  }

  if (out.authHeader !== undefined && /[\r\n\0]/.test(out.authHeader)) return { ok: false, message: "The Authorization header value must be a single line." };

  return { ok: true, config: out };
}

/* ─────────────────────────────────── HTTP plumbing ─────────────────────────────────── */

type Answer = { status: number; ok: boolean; json: unknown } | { failed: string };

function describeFailure(e: unknown, what: string): string {
  const name = (e as { name?: string })?.name ?? "";
  // Deliberately not the driver's message: "ECONNREFUSED 10.0.0.5:6379" versus "timed out"
  // is a description of our network, not of the customer's problem.
  return name === "AbortError" || name === "TimeoutError" ? `${what} did not answer in time` : `${what} could not be reached`;
}

/** Read a capped response body as JSON. null when it is not JSON - the bytes are not kept. */
async function readJson(res: Response): Promise<unknown> {
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(await readCapped(res, MAX_RESPONSE_BYTES));
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * A JSON call to a host a tenant influenced (Zoho's data centre, a Pipedrive subdomain).
 *
 * The URL is built by the caller with `new URL()`, and its host is asserted here against
 * the exact name the caller meant to reach - so nothing typed into a config field can turn
 * into a different host, a port, a path or a userinfo trick. It then goes out through
 * `fetchPublic`: public addresses only, no redirects followed.
 */
async function tenantHostCall(what: string, url: URL, expectHost: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Answer> {
  if (url.protocol !== "https:" || url.hostname !== expectHost || url.port || url.username || url.password) return { failed: `${what} address is not valid` };
  try {
    const res = await fetchPublic(url.toString(), { ...init, timeoutMs: TIMEOUT_MS, maxRedirects: 0, maxBytes: MAX_RESPONSE_BYTES, noDefaultHeaders: true });
    if (!res) return { failed: `${what} address is not a public address, so nothing was sent to it` };
    if (res.status >= 300 && res.status < 400) return { failed: `${what} answered with a redirect (HTTP ${res.status}); redirects are not followed` };
    return { status: res.status, ok: res.ok, json: await readJson(res) };
  } catch (e) {
    return { failed: describeFailure(e, what) };
  }
}

/** A JSON call to a constant host of ours to choose (HubSpot). No redirects, bounded time and size. */
async function fixedHostCall(what: string, url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Answer> {
  try {
    const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, ok: res.ok, json: await readJson(res) };
  } catch (e) {
    return { failed: describeFailure(e, what) };
  }
}

/** A short, single-line message from a CRM's own error body. Only ever used for hosts that ARE the CRM. */
function crmMessage(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Google Apps Script answers a web-app POST with a 302 to this host, where the script's output is served. */
const APPS_SCRIPT_HOSTS = new Set(["script.google.com", "script.googleusercontent.com"]);

/**
 * POST a JSON payload to a URL a customer typed (generic webhook, Cortex, Apps Script).
 *
 * - Public addresses only, checked on the literal and again on what the name resolves to
 *   when the connection is made.
 * - `user:pass@` in the URL is sent as HTTP Basic (fetch itself refuses such a URL, which
 *   is why those webhooks used to save fine and then never deliver).
 * - A redirect is a FAILED delivery, reported as one. It is not followed: following would
 *   re-send a lead to an address the customer never typed, or - for 301/302/303 - quietly
 *   turn the POST into a GET and report the resulting 200 as a delivery that never happened.
 *   The one exception is Google Apps Script, whose web apps answer every successful POST
 *   with a 302 to script.googleusercontent.com: the script has already run, and the result
 *   is fetched with a GET (no payload) that may only stay on Google's two script hosts.
 * - The response body is never returned: `error` is a status code or a short category.
 *
 * Never throws.
 */
export async function postJsonToTenantUrl(rawUrl: string, init: { body: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ ok: boolean; status: number; error?: string }> {
  const shown = displayUrl(rawUrl);
  const u = parseHttpUrl(String(rawUrl ?? ""), { allowUserinfo: true });
  if (!u) return { ok: false, status: 0, error: `${shown} is not an http(s) URL, so nothing was sent to it` };
  if (!isPublicHost(u.href, { allowUserinfo: true })) return { ok: false, status: 0, error: `${shown} is not a public address, so nothing was sent to it` };
  const timeoutMs = init.timeoutMs ?? TIMEOUT_MS;
  const done = async (res: Response) => {
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
  };
  try {
    const res = await fetchPublic(u.href, {
      method: "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: init.body,
      allowUserinfo: true,
      maxRedirects: 0,
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      noDefaultHeaders: true,
    });
    if (!res) return { ok: false, status: 0, error: `${shown} does not resolve to a public address, so nothing was sent to it` };
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      const next = location ? parseHttpUrl(new URL(location, u).toString()) : null;
      const appsScript = u.protocol === "https:" && u.hostname === "script.google.com" && (res.status === 302 || res.status === 303) && next?.protocol === "https:" && APPS_SCRIPT_HOSTS.has(next.hostname);
      if (appsScript && next) {
        const out = await fetchPublic(next.href, { method: "GET", maxRedirects: 3, hostAllow: (h) => APPS_SCRIPT_HOSTS.has(h), timeoutMs, maxBytes: MAX_RESPONSE_BYTES, noDefaultHeaders: true });
        if (!out) return { ok: false, status: res.status, error: "the Apps Script web app redirected somewhere unexpected" };
        return done(out);
      }
      return { ok: false, status: res.status, error: `${shown} answered with a redirect (HTTP ${res.status}). Redirects are not followed - enter the final address of the endpoint` };
    }
    return done(res);
  } catch (e) {
    return { ok: false, status: 0, error: describeFailure(e, shown) };
  }
}

/* ───────────────────────────────────── providers ───────────────────────────────────── */

async function hubspot(cfg: Cfg, lead: Lead, company: { name?: string | null; domain?: string | null } | null): Promise<SyncResult> {
  const props: Record<string, string> = {
    email: lead.email ?? "",
    firstname: lead.firstName ?? "",
    lastname: lead.lastName ?? "",
    jobtitle: lead.title ?? "",
    company: company?.name ?? "",
    website: company?.domain ? `https://${company.domain}` : "",
    hs_linkedin_url: lead.linkedinUrl ?? "",
    lifecyclestage: "lead",
  };
  const headers = { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" };
  const res = await fixedHostCall("HubSpot", "https://api.hubapi.com/crm/v3/objects/contacts", { method: "POST", headers, body: JSON.stringify({ properties: props }) });
  if ("failed" in res) return { ok: false, error: res.failed };
  const data = (res.json ?? {}) as { id?: string; message?: string };
  if (res.status === 409) {
    // exists → update
    const id = typeof data.message === "string" ? data.message.match(/ID: (\d+)/)?.[1] : undefined;
    if (id) {
      const u = await fixedHostCall("HubSpot", `https://api.hubapi.com/crm/v3/objects/contacts/${id}`, { method: "PATCH", headers, body: JSON.stringify({ properties: props }) });
      if ("failed" in u) return { ok: false, externalId: id, error: u.failed };
      return { ok: u.ok, externalId: id, error: u.ok ? undefined : `HubSpot HTTP ${u.status}` };
    }
  }
  return { ok: res.ok, externalId: typeof data.id === "string" ? data.id : undefined, error: res.ok ? undefined : crmMessage(data.message) ?? `HubSpot HTTP ${res.status}` };
}

async function pipedrive(cfg: Cfg, lead: Lead, company: { name?: string | null } | null): Promise<SyncResult> {
  const label = cfg.companyDomain || "api";
  const host = `${label}.pipedrive.com`;
  const endpoint = (path: string) => {
    const u = new URL(`https://${host}/v1/${path}`);
    u.searchParams.set("api_token", cfg.apiToken ?? "");
    return u;
  };
  const headers = { "content-type": "application/json" };
  let orgId: number | undefined;
  if (company?.name) {
    const o = await tenantHostCall("Pipedrive", endpoint("organizations"), host, { method: "POST", headers, body: JSON.stringify({ name: company.name }) });
    if ("failed" in o) return { ok: false, error: o.failed };
    const id = (o.json as { data?: { id?: unknown } } | null)?.data?.id;
    orgId = typeof id === "number" ? id : undefined;
  }
  const res = await tenantHostCall("Pipedrive", endpoint("persons"), host, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: lead.fullName, email: lead.email ? [{ value: lead.email, primary: true }] : [], org_id: orgId, job_title: lead.title }),
  });
  if ("failed" in res) return { ok: false, error: res.failed };
  const data = (res.json ?? {}) as { data?: { id?: number }; error?: string };
  return { ok: res.ok, externalId: data.data?.id ? String(data.data.id) : undefined, error: res.ok ? undefined : crmMessage(data.error) ?? `Pipedrive HTTP ${res.status}` };
}

async function zoho(cfg: Cfg, lead: Lead, company: { name?: string | null } | null): Promise<SyncResult> {
  const base = new URL(cfg.apiDomain || ZOHO_DEFAULT_API_DOMAIN);
  // Belt and braces: the config was validated a moment ago, and the host is checked against
  // the allowlist again at the point a URL is built from it.
  if (!ZOHO_API_HOSTS.has(base.hostname)) return { ok: false, error: "The Zoho API domain is not one of Zoho's API addresses, so nothing was sent to it" };
  const url = new URL("/crm/v2/Leads", `https://${base.hostname}`);
  const res = await tenantHostCall("Zoho", url, base.hostname, {
    method: "POST",
    headers: { authorization: `Zoho-oauthtoken ${cfg.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ data: [{ Last_Name: lead.lastName ?? lead.fullName ?? "Unknown", First_Name: lead.firstName, Email: lead.email, Company: company?.name ?? "Unknown", Designation: lead.title, Lead_Source: "Scout" }] }),
  });
  if ("failed" in res) return { ok: false, error: res.failed };
  const data = (res.json ?? {}) as { data?: { details?: { id?: string }; message?: string }[]; message?: string };
  const row = Array.isArray(data.data) ? data.data[0] : undefined;
  return { ok: res.ok, externalId: typeof row?.details?.id === "string" ? row.details.id : undefined, error: res.ok ? undefined : crmMessage(row?.message) ?? crmMessage(data.message) ?? `Zoho HTTP ${res.status}` };
}

/** Generic JSON POST (Cortex, Zapier/Make webhooks, Google Apps Script, n8n...). */
async function webhook(cfg: Cfg, lead: Lead, company: unknown): Promise<SyncResult> {
  // The URL is whatever the customer typed into Settings, and this POSTs a full lead
  // record to it from inside our network. A private address here is OUR private network,
  // never theirs, so it is refused with a reason rather than attempted.
  const r = await postJsonToTenantUrl(cfg.url, {
    headers: cfg.authHeader ? { authorization: cfg.authHeader } : {},
    body: JSON.stringify({ source: "prospex", lead, company }),
  });
  return { ok: r.ok, error: r.error };
}

const providers: Record<string, (cfg: Cfg, lead: Lead, company: { name?: string | null; domain?: string | null } | null) => Promise<SyncResult>> = {
  hubspot,
  pipedrive,
  zoho,
  cortex: webhook,
  webhook,
  sheets: webhook,
};

export const INTEGRATION_PROVIDERS = Object.keys(providers);

export async function syncLead(integration: Integration, leadId: string): Promise<SyncResult> {
  const { db } = getDb();
  // Strict: a blob that cannot be decrypted (key rotated, row damaged) used to read as an
  // empty config, which then failed in confusing ways. It is its own, sayable, error.
  let stored: Cfg;
  try {
    stored = decryptJsonStrict<Cfg>(integration.configEncrypted) ?? {};
  } catch (e) {
    if (e instanceof CredentialUnreadableError) return { ok: false, error: "This connection's saved credentials could not be read. Reconnect it in Settings, Integrations." };
    throw e;
  }
  const lead = await db.query.leads.findFirst({ where: and(eq(leads.id, leadId), eq(leads.orgId, integration.orgId)) });
  if (!lead) return { ok: false, error: "lead not found" };
  const company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
  const fn = providers[integration.provider];
  if (!fn) return { ok: false, error: `unknown provider ${integration.provider}` };
  // Validated again here, not only when saved: connections stored before this check existed
  // are still in the table, and one of those must be refused, not connected to.
  const checked = validateIntegrationConfig(integration.provider, stored);
  if (!checked.ok) return { ok: false, error: `${checked.message} Nothing was sent. Update this connection in Settings, Integrations.` };
  let r: SyncResult;
  try {
    r = await fn(checked.config, lead, company ?? null);
  } catch {
    // Nothing a provider throws is passed on verbatim: it can carry bytes of the response.
    r = { ok: false, error: `${integration.provider} sync failed unexpectedly` };
  }
  if (r.ok) {
    await db.update(leads).set({ custom: { ...(lead.custom ?? {}), [`${integration.provider}_id`]: r.externalId ?? true } }).where(eq(leads.id, lead.id));
    await db.update(integrations).set({ lastSyncAt: new Date() }).where(eq(integrations.id, integration.id));
  }
  return r;
}
