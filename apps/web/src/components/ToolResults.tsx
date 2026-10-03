import type { ReactNode } from "react";
import { ExtLink } from "./ExtLink";

/**
 * Readable views of the two single-object tool results (company intelligence, sender domain
 * health). Both used to be dumped as raw JSON - internal ids, nulls and all - which is a
 * debugging view, not an answer a customer can act on.
 */

type Obj = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-black/10 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</div>
      {children}
    </div>
  );
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!shown.length) return <div className="text-sm text-ink-400">Nothing found.</div>;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-400">{k}</dt>
          <dd className="min-w-0 text-ink-100 [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// Tool output is whatever a crawled site, a search result or a news feed said. A value that
// is not an http(s) URL is shown as text, never as a link.
const ext = (href: string, label?: string) => (
  <ExtLink className="text-brand-600 hover:underline" href={href} fallback={label ?? href}>{label ?? href} ↗</ExtLink>
);

const SOURCE_LABEL: Record<string, string> = { ok: "checked", unreachable: "site not reachable", failed: "lookup failed" };

export function CompanyIntelView({ data }: { data: Obj }) {
  const c = obj(data.company);
  const hiring = data.hiring ? obj(data.hiring) : null;
  const news = arr(data.news).map(obj);
  const sources = obj(data.sources);
  const socials = obj(obj(c.raw).socials);
  const socialLinks = Object.entries(socials).filter(([, v]) => typeof v === "string") as [string, string][];
  if (str(c.linkedinUrl) && !socials.linkedin) socialLinks.unshift(["linkedin", c.linkedinUrl as string]);
  const tech = arr(c.techStack).map(String).filter(Boolean);
  const byFunction = Object.entries(obj(hiring?.byFunction)).filter(([, n]) => typeof n === "number" && n > 0) as [string, number][];
  const titles = arr(hiring?.titles).map(String).filter(Boolean);
  const signals = news.filter((n) => n.type !== "news");
  const headlines = news.filter((n) => n.type === "news");
  const domain = str(c.domain);

  const NewsList = ({ items }: { items: Obj[] }) => (
    <ul className="space-y-1.5 text-sm">
      {items.map((n, i) => (
        <li key={i} className="[overflow-wrap:anywhere]">
          {str(n.type) && n.type !== "news" && <span className="badge mr-1 bg-brand-50 capitalize text-brand-700">{String(n.type).replace(/_/g, " ")}</span>}
          {str(n.url) ? <ExtLink className="text-ink-100 hover:underline" href={n.url} fallback={str(n.title) ?? String(n.url)}>{str(n.title) ?? String(n.url)}</ExtLink> : str(n.title)}
          <span className="ml-1 text-xs text-ink-400">{[str(n.source), n.occurredAt ? new Date(String(n.occurredAt)).toLocaleDateString() : null].filter(Boolean).join(" · ")}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-3">
      <Section title="Company">
        <KV
          rows={[
            ["Name", str(c.name)],
            ["Domain", domain ? ext(`https://${domain}`, domain) : null],
            ["Description", str(c.description)],
            ["Industry", str(c.industry)],
            ["Size", str(c.size) ?? (typeof c.headcount === "number" ? `${c.headcount} employees` : null)],
            ["Location", str(c.location)],
            ["Founded", str(c.foundedYear)],
            ["Email pattern", str(c.emailPattern) ? <code>{String(c.emailPattern)}</code> : null],
            ["Intent score", typeof c.intentScore === "number" ? `${Math.round(c.intentScore)}/100${sources.intentScoreUpdated === false ? " (not refreshed this time - an input lookup failed)" : ""}` : null],
            ["Tech", tech.length ? <div className="flex flex-wrap gap-1">{tech.map((t) => <span key={t} className="badge bg-black/[0.05] text-ink-300">{t}</span>)}</div> : null],
            ["Socials", socialLinks.length ? <div className="flex flex-wrap gap-x-3 gap-y-1">{socialLinks.map(([k, v]) => <span key={k}>{ext(v, k[0].toUpperCase() + k.slice(1))}</span>)}</div> : null],
          ]}
        />
      </Section>
      <Section title="Hiring">
        {!hiring ? (
          <div className="text-sm text-amber-700">Hiring lookup failed - this is not a finding that they are not hiring.</div>
        ) : hiring.reached === false ? (
          <div className="text-sm text-amber-700">Could not reach their careers pages or a job search, so open roles are unknown (not zero).</div>
        ) : (
          <KV
            rows={[
              ["Open roles", typeof hiring.openRoles === "number" ? String(hiring.openRoles) : null],
              ["By function", byFunction.length ? byFunction.map(([f, n]) => `${f} ${n}`).join(", ") : null],
              ["Careers page", str(hiring.careersUrl) ? ext(String(hiring.careersUrl)) : null],
              ["Roles", titles.length ? <ul className="list-inside list-disc">{titles.slice(0, 10).map((t, i) => <li key={i}>{t}</li>)}</ul> : null],
            ]}
          />
        )}
      </Section>
      <Section title="Signals">
        {sources.news === "failed" ? (
          <div className="text-sm text-amber-700">News search failed - no signals could be checked this time.</div>
        ) : signals.length ? <NewsList items={signals} /> : <div className="text-sm text-ink-400">No funding, launch or leadership signals in the last 60 days.</div>}
      </Section>
      {headlines.length > 0 && (
        <Section title="Recent news">
          <NewsList items={headlines.slice(0, 10)} />
        </Section>
      )}
      {Object.keys(sources).length > 0 && (
        <div className="text-xs text-ink-400">
          Sources: hiring {SOURCE_LABEL[String(sources.hiring)] ?? String(sources.hiring ?? "-")} · news {SOURCE_LABEL[String(sources.news)] ?? String(sources.news ?? "-")}
        </div>
      )}
    </div>
  );
}

function Check({ label, ok, unknown, children }: { label: string; ok: boolean; unknown?: boolean; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`badge w-14 shrink-0 justify-center ${unknown ? "bg-black/[0.05] text-ink-400" : ok ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-red-50 text-red-700 ring-1 ring-red-200"}`}>
        {unknown ? "?" : ok ? "Pass" : "Fail"}
      </span>
      <div className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
        <div className="font-medium">{label}</div>
        {children}
      </div>
    </div>
  );
}

export function DomainHealthView({ data }: { data: Obj }) {
  const mx = obj(data.mx);
  const spf = obj(data.spf);
  const dkim = obj(data.dkim);
  const dmarc = obj(data.dmarc);
  const resolved = data.resolved !== false;
  const recs = arr(data.recommendations).map(String);
  const score = typeof data.score === "number" ? data.score : null;
  const issues = (v: unknown) => arr(v).map(String);
  const rec = (r: unknown) => (str(r) ? <code className="mt-0.5 block text-xs text-ink-300">{String(r)}</code> : null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium [overflow-wrap:anywhere]">{str(data.domain)}</div>
        {resolved && score !== null && (
          <span className={`badge ${score >= 80 ? "bg-emerald-50 text-emerald-700" : score >= 50 ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700"}`}>Score {score}/100</span>
        )}
      </div>
      {!resolved && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">DNS lookups did not complete, so the rows below are not findings.</div>}
      <div className="divide-y divide-black/[0.06] rounded-lg border border-black/10 px-3">
        <Check label="MX (can receive mail)" ok={!!mx.ok} unknown={!resolved}>
          {arr(mx.hosts).length > 0 && <div className="text-xs text-ink-400">{arr(mx.hosts).map(String).join(", ")}</div>}
        </Check>
        <Check label="SPF" ok={!!spf.ok} unknown={!resolved}>
          {rec(spf.record) ?? (resolved && <div className="text-xs text-ink-400">No SPF record</div>)}
          {issues(spf.issues).map((x, i) => <div key={i} className="text-xs text-red-700">{x}</div>)}
        </Check>
        <Check label="DKIM" ok={!!dkim.ok} unknown={!resolved}>
          <div className="text-xs text-ink-400">{arr(dkim.selectorsFound).length ? `Selectors found: ${arr(dkim.selectorsFound).map(String).join(", ")}` : "No key found at the common selectors (yours may use a custom one)"}</div>
        </Check>
        <Check label="DMARC" ok={!!dmarc.ok} unknown={!resolved}>
          {str(dmarc.policy) && <div className="text-xs text-ink-400">Policy: {String(dmarc.policy)}</div>}
          {rec(dmarc.record) ?? (resolved && <div className="text-xs text-ink-400">No DMARC record</div>)}
          {issues(dmarc.issues).map((x, i) => <div key={i} className="text-xs text-red-700">{x}</div>)}
        </Check>
      </div>
      {recs.length > 0 && (
        <Section title="Recommendations">
          <ul className="list-inside list-disc space-y-1 text-sm [overflow-wrap:anywhere]">{recs.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}
