/** Sender domain deliverability check: MX, SPF, DKIM (common selectors), DMARC. Free, DNS only. */
import { promises as dns } from "node:dns";

export interface DomainHealth {
  domain: string;
  mx: { ok: boolean; hosts: string[] };
  spf: { ok: boolean; record?: string; issues: string[] };
  dkim: { ok: boolean; selectorsFound: string[] };
  dmarc: { ok: boolean; record?: string; policy?: string; issues: string[] };
  score: number; // 0..100
  recommendations: string[];
}

const DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "k1", "k2", "k3", "mail", "dkim", "s1", "s2", "resend", "zoho", "zmail", "brevo", "mandrill", "mailo", "smtp", "em", "sendgrid", "amazonses", "mxvault"];

async function txt(name: string) {
  try {
    return (await dns.resolveTxt(name)).map((r) => r.join(""));
  } catch {
    return [];
  }
}

export async function checkDomainHealth(domain: string): Promise<DomainHealth> {
  const rec: string[] = [];
  let mxHosts: string[] = [];
  try {
    mxHosts = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch {}
  const spfRec = (await txt(domain)).find((t) => t.toLowerCase().startsWith("v=spf1"));
  const spfIssues: string[] = [];
  if (!spfRec) spfIssues.push("No SPF record");
  else {
    if (/\+all/.test(spfRec)) spfIssues.push("SPF uses +all (allows anyone)");
    if (!/[-~]all/.test(spfRec)) spfIssues.push("SPF should end with ~all or -all");
    const lookups = (spfRec.match(/\b(include|a|mx|ptr|exists|redirect)[:=]/g) ?? []).length;
    if (lookups > 10) spfIssues.push(`SPF has ${lookups} lookups (max 10)`);
  }
  const selectorsFound: string[] = [];
  await Promise.all(DKIM_SELECTORS.map(async (s) => {
    const r = await txt(`${s}._domainkey.${domain}`);
    if (r.some((t) => /v=DKIM1|k=rsa|p=/i.test(t))) selectorsFound.push(s);
  }));
  const dmarcRec = (await txt(`_dmarc.${domain}`)).find((t) => t.toLowerCase().startsWith("v=dmarc1"));
  const dmarcIssues: string[] = [];
  const policy = dmarcRec?.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase();
  if (!dmarcRec) dmarcIssues.push("No DMARC record");
  else if (policy === "none") dmarcIssues.push("DMARC policy is p=none (monitoring only)");
  if (dmarcRec && !/rua=/.test(dmarcRec)) dmarcIssues.push("DMARC has no rua= reporting address");

  let score = 0;
  if (mxHosts.length) score += 25; else rec.push("Add MX records - the domain cannot receive replies");
  if (spfRec && spfIssues.length === 0) score += 25; else if (spfRec) score += 15;
  if (selectorsFound.length) score += 25; else rec.push("Set up DKIM signing in your email provider (Google Workspace, Zoho, Resend, Brevo)");
  if (dmarcRec && policy !== "none") score += 25; else if (dmarcRec) score += 15;
  if (!spfRec) rec.push("Publish an SPF record, e.g. v=spf1 include:_spf.google.com ~all");
  if (!dmarcRec) rec.push("Publish _dmarc TXT: v=DMARC1; p=quarantine; rua=mailto:dmarc@" + domain);
  if (score >= 90) rec.push("Domain is well configured. Warm up gradually: 10/day → 50/day over 3 weeks for a new mailbox.");
  return { domain, mx: { ok: mxHosts.length > 0, hosts: mxHosts }, spf: { ok: !!spfRec && spfIssues.length === 0, record: spfRec, issues: spfIssues }, dkim: { ok: selectorsFound.length > 0, selectorsFound }, dmarc: { ok: !!dmarcRec && policy !== "none", record: dmarcRec, policy, issues: dmarcIssues }, score, recommendations: rec };
}
