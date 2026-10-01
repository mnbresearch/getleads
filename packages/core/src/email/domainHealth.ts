/** Sender domain deliverability check: MX, SPF, DKIM (common selectors), DMARC. Free, DNS only. */
import { promises as dns } from "node:dns";

export interface DomainHealth {
  domain: string;
  /**
   * False when the resolver never answered, whatever the rest of this object says.
   *
   * Every lookup here used to swallow its error and return `[]`, so a resolver outage
   * produced a fully-formed report saying "No SPF record", "No DMARC record", score 0, and
   * a list of confident recommendations to publish records the domain very probably already
   * has. A user acting on that would change live DNS on the strength of a network blip.
   */
  resolved: boolean;
  /** `ok` means the domain can receive mail. `nullMx`: it publishes "MX 0 ." (RFC 7505), an
   * explicit statement that it accepts no mail - not a working MX. */
  mx: { ok: boolean; hosts: string[]; nullMx?: boolean };
  spf: { ok: boolean; record?: string; issues: string[] };
  dkim: { ok: boolean; selectorsFound: string[] };
  dmarc: { ok: boolean; record?: string; policy?: string; issues: string[] };
  score: number; // 0..100
  recommendations: string[];
}

const DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "k1", "k2", "k3", "mail", "dkim", "s1", "s2", "resend", "zoho", "zmail", "brevo", "mandrill", "mailo", "smtp", "em", "sendgrid", "amazonses", "mxvault"];

/** Codes that mean "there is no such record", as opposed to "we could not ask". */
const DNS_SAYS_NO = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "NODATA"]);

interface TxtLookup {
  records: string[];
  answered: boolean;
}

async function txt(name: string): Promise<TxtLookup> {
  try {
    return { records: (await dns.resolveTxt(name)).map((r) => r.join("")), answered: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? "";
    return { records: [], answered: DNS_SAYS_NO.has(code) };
  }
}

export async function checkDomainHealth(domain: string): Promise<DomainHealth> {
  const rec: string[] = [];
  let mxHosts: string[] = [];
  let mxAnswered = false;
  let nullMx = false;
  try {
    const raw = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
    // A null MX comes back as an exchange of "" (or "."). Counting it as a host reported
    // "mail setup OK" for domains like example.com that refuse all mail.
    mxHosts = raw.filter((h) => h && h !== ".");
    nullMx = raw.length > 0 && mxHosts.length === 0;
    mxAnswered = true;
  } catch (e) {
    mxAnswered = DNS_SAYS_NO.has((e as NodeJS.ErrnoException)?.code ?? "");
  }

  const apex = await txt(domain);
  const spfRec = apex.records.find((t) => t.toLowerCase().startsWith("v=spf1"));
  const spfIssues: string[] = [];
  if (!spfRec && apex.answered) spfIssues.push("No SPF record");
  else if (spfRec) {
    if (/\+all/.test(spfRec)) spfIssues.push("SPF uses +all (allows anyone)");
    if (!/[-~]all/.test(spfRec)) spfIssues.push("SPF should end with ~all or -all");
    const lookups = (spfRec.match(/\b(include|a|mx|ptr|exists|redirect)[:=]/g) ?? []).length;
    if (lookups > 10) spfIssues.push(`SPF has ${lookups} lookups (max 10)`);
  }

  const selectorsFound: string[] = [];
  let dkimAnswered = false;
  await Promise.all(DKIM_SELECTORS.map(async (sel) => {
    const r = await txt(`${sel}._domainkey.${domain}`);
    // One selector answering is enough to know the resolver is reachable; absent selectors
    // are the normal case and say nothing on their own.
    if (r.answered) dkimAnswered = true;
    // A record with an empty key ("p=;" or "p=" at the end) is a revoked key (RFC 6376 3.6.1):
    // it publishes that this selector must NOT verify, so it is not a working DKIM setup.
    const live = r.records.filter((t) => /v=DKIM1|k=rsa|p=/i.test(t) && !/(^|;)\s*p=\s*(;|$)/i.test(t));
    if (live.length) selectorsFound.push(sel);
  }));

  const dmarc = await txt(`_dmarc.${domain}`);
  const dmarcRec = dmarc.records.find((t) => t.toLowerCase().startsWith("v=dmarc1"));
  const dmarcIssues: string[] = [];
  const policy = dmarcRec?.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase();
  if (!dmarcRec && dmarc.answered) dmarcIssues.push("No DMARC record");
  else if (dmarcRec && policy === "none") dmarcIssues.push("DMARC policy is p=none (monitoring only)");
  if (dmarcRec && !/rua=/.test(dmarcRec)) dmarcIssues.push("DMARC has no rua= reporting address");

  const resolved = mxAnswered && apex.answered && dkimAnswered && dmarc.answered;

  // A report built on lookups that never completed is not a report. Say so once, loudly,
  // and do not hand back a score or a to-do list that would read as a finding.
  if (!resolved) {
    return {
      domain,
      resolved,
      mx: { ok: mxHosts.length > 0, hosts: mxHosts, nullMx },
      // Same meaning as the resolved branch below: "present AND without problems". It read
      // `!!spfRec` here, so the same field meant two different things depending on whether
      // DNS had answered - and the branch where it meant less is the one nobody reads
      // carefully.
      spf: { ok: !!spfRec && spfIssues.length === 0, record: spfRec, issues: spfIssues },
      dkim: { ok: selectorsFound.length > 0, selectorsFound },
      dmarc: { ok: !!dmarcRec && policy !== "none", record: dmarcRec, policy, issues: dmarcIssues },
      score: 0,
      recommendations: ["DNS lookups for this domain did not complete, so nothing below is a finding. Try again in a few minutes."],
    };
  }

  let score = 0;
  if (mxHosts.length) score += 25;
  else if (nullMx) rec.push("This domain publishes a null MX (RFC 7505): it refuses all mail, so it cannot receive replies. Replace it with real MX records before sending from it.");
  else rec.push("Add MX records - the domain cannot receive replies");
  if (spfRec && spfIssues.length === 0) score += 25; else if (spfRec) score += 15;
  if (selectorsFound.length) score += 25; else rec.push("Set up DKIM signing in your email provider (Google Workspace, Zoho, Resend, Brevo)");
  if (dmarcRec && policy !== "none") score += 25; else if (dmarcRec) score += 15;
  if (!spfRec) rec.push("Publish an SPF record, e.g. v=spf1 include:_spf.google.com ~all");
  if (!dmarcRec) rec.push("Publish _dmarc TXT: v=DMARC1; p=quarantine; rua=mailto:dmarc@" + domain);
  if (score >= 90) rec.push("Domain is well configured. Warm up gradually: 10/day -> 50/day over 3 weeks for a new mailbox.");
  return { domain, resolved, mx: { ok: mxHosts.length > 0, hosts: mxHosts, nullMx }, spf: { ok: !!spfRec && spfIssues.length === 0, record: spfRec, issues: spfIssues }, dkim: { ok: selectorsFound.length > 0, selectorsFound }, dmarc: { ok: !!dmarcRec && policy !== "none", record: dmarcRec, policy, issues: dmarcIssues }, score, recommendations: rec };
}
