import { and, companies, eq, getDb, integrations, leads, type Integration, type Lead } from "@prospex/db";
import { decryptJson } from "../lib/crypto.js";

/**
 * Outbound CRM sync. Each provider maps a Prospex lead to its contact object.
 * All of these have free tiers: HubSpot (free CRM), Pipedrive (trial), Zoho (free 3 users),
 * Google Sheets (via Apps Script webhook), Cortex / any custom endpoint (generic webhook).
 */

type Cfg = Record<string, string>;

async function hubspot(cfg: Cfg, lead: Lead, company: { name?: string | null; domain?: string | null } | null) {
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
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ properties: props }),
  });
  if (res.status === 409) {
    // exists → update
    const body = (await res.json()) as { message?: string };
    const id = body.message?.match(/ID: (\d+)/)?.[1];
    if (id) {
      const u = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ properties: props }) });
      return { ok: u.ok, externalId: id };
    }
  }
  const data = (await res.json()) as { id?: string; message?: string };
  return { ok: res.ok, externalId: data.id, error: data.message };
}

async function pipedrive(cfg: Cfg, lead: Lead, company: { name?: string | null } | null) {
  const base = `https://${cfg.companyDomain ?? "api"}.pipedrive.com/v1`;
  let orgId: number | undefined;
  if (company?.name) {
    const o = await fetch(`${base}/organizations?api_token=${cfg.apiToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: company.name }) });
    orgId = ((await o.json()) as { data?: { id: number } }).data?.id;
  }
  const res = await fetch(`${base}/persons?api_token=${cfg.apiToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: lead.fullName, email: lead.email ? [{ value: lead.email, primary: true }] : [], org_id: orgId, job_title: lead.title }),
  });
  const data = (await res.json()) as { data?: { id: number }; error?: string };
  return { ok: res.ok, externalId: data.data?.id ? String(data.data.id) : undefined, error: data.error };
}

async function zoho(cfg: Cfg, lead: Lead, company: { name?: string | null } | null) {
  const res = await fetch(`${cfg.apiDomain ?? "https://www.zohoapis.in"}/crm/v2/Leads`, {
    method: "POST",
    headers: { authorization: `Zoho-oauthtoken ${cfg.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ data: [{ Last_Name: lead.lastName ?? lead.fullName ?? "Unknown", First_Name: lead.firstName, Email: lead.email, Company: company?.name ?? "Unknown", Designation: lead.title, Lead_Source: "Prospex" }] }),
  });
  const data = (await res.json()) as { data?: { details?: { id: string }; message?: string }[] };
  return { ok: res.ok, externalId: data.data?.[0]?.details?.id, error: data.data?.[0]?.message };
}

/** Generic JSON POST (Cortex, Zapier/Make webhooks, Google Apps Script, n8n...). */
async function webhook(cfg: Cfg, lead: Lead, company: unknown) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.authHeader ? { authorization: cfg.authHeader } : {}) },
    body: JSON.stringify({ source: "prospex", lead, company }),
  });
  return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
}

const providers: Record<string, (cfg: Cfg, lead: Lead, company: { name?: string | null; domain?: string | null } | null) => Promise<{ ok: boolean; externalId?: string; error?: string }>> = {
  hubspot,
  pipedrive,
  zoho,
  cortex: webhook,
  webhook,
  sheets: webhook,
};

export const INTEGRATION_PROVIDERS = Object.keys(providers);

export async function syncLead(integration: Integration, leadId: string) {
  const { db } = getDb();
  const cfg = decryptJson<Cfg>(integration.configEncrypted) ?? {};
  const lead = await db.query.leads.findFirst({ where: and(eq(leads.id, leadId), eq(leads.orgId, integration.orgId)) });
  if (!lead) return { ok: false, error: "lead not found" };
  const company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
  const fn = providers[integration.provider];
  if (!fn) return { ok: false, error: `unknown provider ${integration.provider}` };
  const r = await fn(cfg, lead, company ?? null);
  if (r.ok) {
    await db.update(leads).set({ custom: { ...(lead.custom ?? {}), [`${integration.provider}_id`]: r.externalId ?? true } }).where(eq(leads.id, lead.id));
    await db.update(integrations).set({ lastSyncAt: new Date() }).where(eq(integrations.id, integration.id));
  }
  return r;
}
