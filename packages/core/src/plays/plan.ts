/**
 * From a website to a set of suggested plays.
 *
 * Reads the site's home page once (and up to three of its own comparison pages) to learn
 * what is sold, who buys it and who it competes with, then proposes plays the customer can
 * create as they are or edit. Nothing here is saved, and nothing here is a claim about
 * anyone else: competitors found by a model are suggestions, labelled as such.
 */
import type { AiMessage } from "../types.js";
import { UNTRUSTED_RULE, fence, fenceBlock, plainString, stringList } from "../ai/untrusted.js";
import type { IcpCriteria } from "../icp/score.js";
import { extractDomain, rootDomain } from "../util/domain.js";
import { loadHtml } from "../util/html.js";
import { isPublicHost } from "../util/publicHost.js";
import { MAX_PAGE_CHARS, PlayRun, cleanCompanyName, escapeRegExp, isSameCompany, sameSite, slugToName } from "./shared.js";
import type { PlayEngineOptions, PlayRunTrace } from "./types.js";
import { cleanLine, normCompanyName } from "./util.js";

export interface PlayPlan {
  product: { domain: string; name?: string; description?: string };
  icp: IcpCriteria;
  titles: string[];
  competitors: { name: string; domain?: string; source: "saved" | "site" | "ai" }[];
  plays: { type: string; name: string; config: Record<string, unknown>; targetTitles: string[]; why: string }[];
  trace: PlayRunTrace;
}

const MAX_COMPARE_PAGES = 3;
const MAX_COMPETITORS = 12;
const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+"];

/**
 * Who buys, and which roles their team hires, by what the site says it does. Every row is
 * scored against the site's own description and headings and the best one wins (the earlier
 * of two equals); the last row is the default when nothing matches.
 */
const PERSONAS: { match: RegExp; titles: string[]; roles: string[] }[] = [
  { match: /\b(?:sales|outbound|prospect\w*|lead[- ]gen\w*|leads|buyers|deals|pipeline|crm|revenue|cold email|sdr|quota)\b/i, titles: ["VP Sales", "Head of Sales", "Sales Director", "Head of Growth", "Chief Revenue Officer", "Founder"], roles: ["Sales Development Representative", "Account Executive"] },
  { match: /\b(?:marketing|seo|content|campaigns?|brand|advertis\w*|ads|social media|newsletter|demand gen\w*)\b/i, titles: ["Chief Marketing Officer", "VP Marketing", "Head of Marketing", "Head of Growth", "Marketing Director"], roles: ["Marketing Manager", "Growth Marketer", "Content Marketer"] },
  { match: /\b(?:recruit\w*|hiring|talent|applicants?|payroll|people ops|human resources|hr|onboarding employees|employee)\b/i, titles: ["Chief People Officer", "VP People", "Head of HR", "Head of Talent", "HR Director"], roles: ["Recruiter", "HR Manager", "People Operations Manager"] },
  { match: /\b(?:customer support|helpdesk|help desk|tickets?|customer success|live chat|customer service|contact cent(?:er|re))\b/i, titles: ["Head of Customer Support", "VP Customer Success", "Director of Customer Experience", "Head of Customer Success"], roles: ["Customer Support Specialist", "Customer Success Manager"] },
  { match: /\b(?:security|compliance|soc 2|gdpr|iso 27001|vulnerabilit\w*|pentest\w*|threat)\b/i, titles: ["Chief Information Security Officer", "Head of Security", "VP Engineering", "Compliance Manager"], roles: ["Security Engineer", "Compliance Manager"] },
  { match: /\b(?:financ\w*|accounting|invoic\w*|expenses?|audit\w*|bookkeep\w*|tax|accounts payable|billing|treasury)\b/i, titles: ["Chief Financial Officer", "VP Finance", "Finance Director", "Controller", "Head of Finance"], roles: ["Accountant", "Finance Manager", "Financial Controller"] },
  { match: /\b(?:analytics|data warehouse|business intelligence|dashboards?|data pipeline\w*|etl|data team)\b/i, titles: ["Head of Data", "VP Analytics", "Director of Data", "Chief Data Officer"], roles: ["Data Analyst", "Data Engineer"] },
  { match: /\b(?:developers?|engineering|devops|api|infrastructure|deploy\w*|observability|kubernetes|code|ci\/cd|open[- ]source|sdk)\b/i, titles: ["Chief Technology Officer", "VP Engineering", "Head of Engineering", "Engineering Manager"], roles: ["Software Engineer", "DevOps Engineer", "Platform Engineer"] },
  { match: /\b(?:product management|roadmap|user research|prototyp\w*|design system|ux)\b/i, titles: ["Chief Product Officer", "VP Product", "Head of Product", "Head of Design"], roles: ["Product Manager", "Product Designer"] },
  { match: /\b(?:legal|contracts?|law firms?|lawyers?|attorneys?|litigation)\b/i, titles: ["General Counsel", "Head of Legal", "Managing Partner", "Legal Operations Manager"], roles: ["Legal Counsel", "Paralegal"] },
  { match: /\b(?:students?|schools?|universit\w*|admissions?|courses?|learning|education|study abroad|tutoring|coaching)\b/i, titles: ["Director of Admissions", "Head of Learning", "Principal", "Dean", "Head of Training"], roles: ["Admissions Counselor", "Academic Coordinator"] },
  { match: /\b(?:e-?commerce|online store|shopify|merchants?|retail\w*|checkout|inventory)\b/i, titles: ["Head of E-commerce", "E-commerce Director", "Founder", "Head of Operations"], roles: ["E-commerce Manager", "Operations Manager"] },
  { match: /./, titles: ["Founder", "Chief Executive Officer", "Chief Operating Officer", "Head of Operations"], roles: ["Operations Manager"] },
];

const CATEGORY_NOUN = "platform|software|tool|app|crm|solution|suite|system|service|api|marketplace|agency|consultancy|studio|engine|assistant|network";

/** What a site sells, by the words it uses for it, when it never says "X is a ... platform". First match wins. */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(?:e-?mail)\s+(?:verif\w+|validation|checker)\b|\bverif(?:y|ies|ying)\s+(?:e-?mail)(?:\s+address(?:es)?|s)?\b/i, "email verification tool"],
  [/\bcold\s+(?:e-?mail|outreach)\b|\bsales engagement\b|\boutbound\s+(?:sales|e-?mail|campaigns?|sequences?)\b|\be-?mail outreach\b|\bmultichannel outreach\b|\bsales sequences?\b/i, "sales engagement tool"],
  [/\blead[- ]gen\w*|\b(?:find|finds|finding|source|sources)\b[^.]{0,40}\b(?:leads|prospects)\b|\bb2b\s+(?:leads|contacts|contact data|data)\b|\bprospecting\b|\bverified contacts\b|\bcontact data\b|\blead (?:finder|database)\b/i, "lead generation tool"],
  [/\bcrm\b/i, "CRM"],
  [/\be-?mail marketing\b|\bnewsletters?\b/i, "email marketing tool"],
  [/\b(?:error|crash|performance|application)\s+(?:monitoring|tracking)\b|\bapplication performance\b|\bobservability\b/i, "application monitoring tool"],
  [/\bproduct analytics\b/i, "product analytics tool"],
  [/\bshared inbox\b|\bcustomer support\b|\bhelp ?desk\b|\bticketing\b|\bcustomer service\b/i, "customer support software"],
  [/\bperformance (?:management|reviews?)\b|\bpeople management\b|\bhr (?:and \w+ )?(?:software|platform|tools?)\b|\bhris\b|\bemployee engagement\b/i, "HR software"],
  [/\bapplicant tracking\b|\brecruiting software\b/i, "applicant tracking system"],
  [/\bproject management\b/i, "project management tool"],
  [/\baccounting\b|\binvoicing\b|\bbookkeeping\b/i, "accounting software"],
  [/\bseo\b|\bsearch engine optimi[sz]ation\b|\banswer engine optimi[sz]ation\b/i, "SEO tool"],
  [/\bappointment (?:booking|scheduling)\b|\bscheduling (?:software|tool|app|links?)\b/i, "scheduling tool"],
  [/\be-?signatures?\b|\bdocument signing\b/i, "e-signature tool"],
  [/\bdata warehouse\b|\betl\b|\bdata pipelines?\b/i, "data integration tool"],
  [/\blive chat\b|\bchatbots?\b/i, "live chat software"],
  [/\be-?mail\b[^.]{0,30}\b(?:tool|platform|software|app|client)\b/i, "email tool"],
];

/**
 * "Acme is a sales engagement platform for ..." gives "sales engagement platform". A site
 * that only says what it does ("finds and verifies B2B leads", "the CRM that ...") gets
 * the category those words belong to.
 */
export function categoryFrom(said: string): string | undefined {
  // What a site says it is, it says in a sentence or two: only the first few thousand characters are read.
  const text = String(said ?? "").slice(0, 4000);
  const m = new RegExp(`\\b(?:is|are)\\s+(?:an?|the|your)\\s+((?:[\\p{L}\\p{N}&/+-]+\\s+){0,4}?(?:${CATEGORY_NOUN}))\\b`, "iu").exec(text) ?? new RegExp(`\\b(?:the|an?)\\s+((?:[\\p{L}\\p{N}&/+-]+\\s+){1,4}?(?:${CATEGORY_NOUN}))\\s+(?:for|that|to|built)\\b`, "iu").exec(text);
  if (m) {
    const c = cleanLine(m[1], 80).replace(/^(?:all-in-one|best|leading|first|only|modern|simple|ultimate|complete|powerful|#1|number one|world's|new|next-generation|ai-powered|ai-first)\s+/i, "").toLowerCase();
    if (c.split(" ").length >= 2) return c;
    if (c === "crm") return "CRM";
  }
  for (const [re, category] of CATEGORY_WORDS) if (re.test(text)) return category;
  return undefined;
}

/** Words every site has that say nothing about what it sells: skip links, cookie banners, sign-in buttons. */
const BOILERPLATE = /\bskip to (?:the )?(?:main )?(?:content|navigation|footer)\b|\b(?:toggle|open|close|main) (?:navigation|menu)\b|\bmain content\b|\b(?:accept|reject|manage) (?:all )?cookies\b|\bcookie (?:policy|settings|preferences|notice)\b|\bwe use cookies\b[^.]{0,200}\.?|\bprivacy policy\b|\bterms (?:of (?:service|use)|and conditions)\b|\ball rights reserved\b|\b(?:sign|log) ?(?:in|up)\b|\bbook a demo\b|\bget started\b|\bstart (?:a |your )?free trial\b|\bcontact sales\b|\bsubscribe to our newsletter\b/gi;

const withoutBoilerplate = (text: string): string => text.replace(BOILERPLATE, " ").replace(/\s+/g, " ").trim();

/**
 * The buyer persona a site's own words point to. What the site says about itself in its
 * description counts three times, its main headline twice, its other headings and opening
 * text once - so one stray word ("content" in "Skip to main content") cannot decide it.
 */
export function pickPersona(site: { description?: string; headline?: string; headings?: string[]; text?: string }): { titles: string[]; roles: string[] } {
  const parts: [string, number][] = [
    [withoutBoilerplate((site.description ?? "").slice(0, 2000)), 3],
    [withoutBoilerplate((site.headline ?? "").slice(0, 1000)), 2],
    [withoutBoilerplate((site.headings ?? []).slice(0, 30).map((h) => String(h ?? "").slice(0, 400)).join(". ")), 1],
    [withoutBoilerplate((site.text ?? "").slice(0, 600)), 1],
  ];
  let best = PERSONAS[PERSONAS.length - 1];
  let bestScore = 0;
  for (const p of PERSONAS.slice(0, -1)) {
    const re = new RegExp(p.match.source, "gi");
    let score = 0;
    for (const [text, weight] of parts) score += Math.min(4, (text.match(re) ?? []).length) * weight;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

const COMPARE_PATH = /(?:^|[/-])(?:vs|versus|alternatives?|compare|comparison|comparisons|competitors?)(?:[/-]|$)/i;

const GLUED = /\p{Ll}(?:See|We|Read|Learn|Try|Get|Compare|Why|How|Our|View|More|Start|Switch|Book|Watch|Explore|Vs|Find|Discover|Check|Sign|Join|Use|Make|Build|Stop|Go)$/u;

/** Competitor names in one line of the site's own text: "Acme vs Rival", "Rival alternative", "alternative to Rival", "switch from Rival". */
export function competitorsInText(text: string, own: { name?: string; domain?: string }): string[] {
  const t = cleanLine(text, 240);
  if (!t) return [];
  const out: string[] = [];
  const NAME = "([\\p{Lu}\\p{N}][\\p{L}\\p{N}.&'\\u2019-]*(?:\\s+[\\p{Lu}\\p{N}][\\p{L}\\p{N}.&'\\u2019-]*){0,2})";
  const take = (raw: string | undefined): void => {
    const name = raw ? cleanCompanyName(raw.replace(/[.:,]+$/, ""), 3) : null;
    if (!name || !/^[\p{Lu}\p{N}]/u.test(name)) return;
    // "HubSpotSee", "PipedriveWe": a name with a button's first word stuck to it is not a name.
    if (name.split(" ").some((w) => GLUED.test(w))) return;
    if (isSameCompany(name, own)) return;
    if (/^(?:Competitors?|Others?|Alternatives?|Everyone|Them|Us|The Rest|Spreadsheets?|Excel|Email|Legacy|Traditional|Manual|In-house|DIY|Agencies|Freelancers|Consultants)$/i.test(name)) return;
    if (!out.some((o) => normCompanyName(o) === normCompanyName(name))) out.push(name);
  };
  for (const m of t.matchAll(new RegExp(`${NAME}\\s+(?:vs\\.?|versus|v\\.)\\s+${NAME}`, "gu"))) {
    take(m[1]);
    take(m[2]);
  }
  for (const m of t.matchAll(new RegExp(`${NAME}\\s+[Aa]lternatives?\\b`, "gu"))) take(m[1].replace(/^(?:Best|Top|The|A|An|Free|Cheaper|Better|Open[- ]Source)\s+/i, ""));
  for (const m of t.matchAll(new RegExp(`\\b[Aa]lternatives?\\s+to\\s+${NAME}`, "gu"))) take(m[1]);
  for (const m of t.matchAll(new RegExp(`\\b(?:[Ss]witch(?:ing)?|[Mm]igrat(?:e|ing)|[Mm]ov(?:e|ing))\\s+from\\s+${NAME}`, "gu"))) take(m[1]);
  for (const m of t.matchAll(new RegExp(`\\b[Cc]ompared?\\s+(?:to|with)\\s+${NAME}`, "gu"))) take(m[1]);
  for (const m of t.matchAll(new RegExp(`\\b[Cc]ompare\\s+${NAME}\\s+(?:to|with|and)\\s+${NAME}`, "gu"))) {
    take(m[1]);
    take(m[2]);
  }
  return out.slice(0, 6);
}

/** The other company in a comparison URL (`/compare/acme-vs-rival`, `/rival-alternative`), when the link's text spells it too. */
function competitorFromLink(pathname: string, text: string, own: { name?: string; domain?: string }): string | null {
  const seg = pathname.split("/").filter(Boolean).pop() ?? "";
  const tokens = seg.toLowerCase().replace(/\.(?:html?|php)$/, "").split(/[-_]+/).filter(Boolean);
  const ownTokens = new Set(cleanLine(own.name, 80).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const rest = tokens.filter((x) => !/^(?:vs|versus|alternatives?|alternative|compare|comparison|to|the|best|top|competitors?|and|or|a|an|for|with)$/.test(x) && !ownTokens.has(x));
  // A pattern is built from these words: a name is a few short ones.
  if (!rest.length || rest.length > 3 || rest.some((x) => x.length > 40)) return null;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${rest.map(escapeRegExp).join("[\\s\\-_.]{0,2}")}(?![\\p{L}\\p{N}])`, "iu").exec(text);
  const spelled = m ? m[0] : null;
  if (!spelled || !/^[\p{Lu}\p{N}]/u.test(spelled)) return null;
  const name = cleanCompanyName(spelled, 3);
  return name && !isSameCompany(name, own) ? name : null;
}

interface Node {
  type?: string;
  name?: string;
  data?: string;
  children?: Node[];
}

/** Never part of what a page says: code, styles and content the page does not show. */
const NOT_SHOWN = new Set(["script", "style", "noscript", "template", "iframe"]);
/** The site's own furniture, left out of the page's text (its headings are still read). */
const FURNITURE = new Set(["script", "style", "noscript", "template", "iframe", "nav", "footer", "header", "aside"]);

/**
 * The text of an element with a space between its pieces. A link built as
 * `<a><span>HubSpot</span><span>See how we compare</span></a>` reads "HubSpot See how we
 * compare", not "HubSpotSee how we compare". Elements named in `skip` are stepped over
 * with everything in them.
 */
function spacedText(el: Node | undefined, max = 400, skip?: Set<string>): string {
  if (!el) return "";
  const out: string[] = [];
  let size = 0;
  // Children are taken one at a time, so the first words of a huge element are read without touching the rest of it.
  const lists: Node[][] = [[el]];
  const at: number[] = [0];
  while (lists.length && size < max * 4) {
    const top = lists.length - 1;
    if (at[top] >= lists[top].length) {
      lists.pop();
      at.pop();
      continue;
    }
    const n = lists[top][at[top]++];
    if (n.type === "text") {
      const d = n.data ?? "";
      size += d.length;
      out.push(d);
      continue;
    }
    if (skip && n.name && skip.has(n.name)) continue;
    if (n.children?.length) {
      lists.push(n.children);
      at.push(0);
    }
  }
  return cleanLine(out.join(" "), max);
}

/**
 * The pieces of text in an element, each read on its own: a link's label ("Acme vs Rival")
 * and the button text under it ("See how we compare") are two pieces, so the second can
 * never be taken for part of a name in the first. Bold and italic words stay in their piece.
 */
function textPieces(el: Node, max = 200, skip?: Set<string>): string[] {
  const out: string[] = [];
  const lists: Node[][] = [[el]];
  const at: number[] = [0];
  // An element holds at most twenty pieces worth reading; one without any is not searched past its first few thousand elements.
  let looked = 0;
  while (lists.length && out.length < 20 && looked < 4000) {
    const top = lists.length - 1;
    if (at[top] >= lists[top].length) {
      lists.pop();
      at.pop();
      continue;
    }
    const n = lists[top][at[top]++];
    if ((n.type !== "tag" && n.type !== "root") || (skip && n.name && skip.has(n.name))) continue;
    looked++;
    const kids = n.children ?? [];
    if (kids.some((c) => c.type === "text" && /\S/.test(c.data ?? ""))) {
      const t = spacedText(n, max, skip);
      if (t) out.push(t);
      continue;
    }
    if (kids.length) {
      lists.push(kids);
      at.push(0);
    }
  }
  return out;
}

/**
 * The first `max` headings of a page (h1 to h3) in page order, and its first h1 wherever it
 * stands. One walk from the top; nothing inside code, styles or hidden content.
 */
function headingsOf(root: Node, max: number): { list: Node[]; h1?: Node } {
  const list: Node[] = [];
  let h1: Node | undefined;
  const lists: Node[][] = [[root]];
  const at: number[] = [0];
  while (lists.length && (list.length < max || !h1)) {
    const top = lists.length - 1;
    if (at[top] >= lists[top].length) {
      lists.pop();
      at.pop();
      continue;
    }
    const n = lists[top][at[top]++];
    if (n.type !== "tag" && n.type !== "root") continue;
    if (n.name && NOT_SHOWN.has(n.name)) continue;
    if (n.name === "h1" || n.name === "h2" || n.name === "h3") {
      if (list.length < max) list.push(n);
      if (n.name === "h1") h1 ??= n;
    }
    if (n.children?.length) {
      lists.push(n.children);
      at.push(0);
    }
  }
  return { list, h1 };
}

interface SiteRead {
  name?: string;
  description?: string;
  headline?: string;
  /** The page's section headings, in order. */
  headings: string[];
  text: string;
  competitors: string[];
  compareLinks: string[];
}

/** What one page of the site says, or null when the page is unreadable (see util/html.ts). */
function readPage(html: string, pageUrl: string, site: string, own: { name?: string; domain?: string }, first: boolean): SiteRead | null {
  const $ = loadHtml(html, MAX_PAGE_CHARS);
  if (!$) return null;
  let name: string | undefined;
  let description: string | undefined;
  if (first) {
    name = cleanLine($('meta[property="og:site_name"]').attr("content"), 80) || cleanLine($('meta[name="application-name"]').attr("content"), 80) || undefined;
    $("script[type='application/ld+json']").each((_, el) => {
      if (name) return;
      try {
        const j = JSON.parse($(el).text().slice(0, 100_000)) as unknown;
        const nodes = Array.isArray(j) ? j : j && typeof j === "object" && Array.isArray((j as { "@graph"?: unknown })["@graph"]) ? ((j as { "@graph": unknown[] })["@graph"] as unknown[]) : [j];
        for (const n of nodes.slice(0, 30)) {
          const o = n && typeof n === "object" ? (n as Record<string, unknown>) : {};
          if (/^(?:organization|corporation|softwareapplication|website)$/i.test(String(o["@type"] ?? "")) && typeof o.name === "string") {
            name = cleanLine(o.name, 80) || undefined;
            break;
          }
        }
      } catch {
        // not JSON: ignored
      }
    });
    const title = cleanLine($("title").first().text(), 200);
    if (!name && title) {
      // "Acme - Sales engagement for B2B teams" / "Sales engagement | Acme": the short side is the name.
      const parts = title.split(/\s+[|\u2013\u2014\u00B7:-]\s+/).map((p) => p.trim()).filter(Boolean);
      const label = rootDomain(site).split(".")[0];
      name = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "") === label.replace(/[^a-z0-9]/g, "")) ?? (parts.length > 1 ? parts.slice().sort((a, b) => a.length - b.length)[0] : undefined) ?? slugToName(label);
      if (name && name.length > 40) name = slugToName(label);
    }
    description = cleanLine($('meta[name="description"]').attr("content"), 400) || cleanLine($('meta[property="og:description"]').attr("content"), 400) || undefined;
  }
  const self = { name: name ?? own.name, domain: own.domain };

  const competitors: string[] = [];
  const addAll = (names: string[]): void => {
    for (const n of names) if (!competitors.some((c) => normCompanyName(c) === normCompanyName(n))) competitors.push(n);
  };
  const compareLinks: string[] = [];
  let compared = 0;
  $("a[href]").each((_, el) => {
    // Ten names and forty pages are all that is kept: past that, more links change nothing. Nor are more than 400 comparison links read on one page.
    if ((competitors.length >= 10 && compareLinks.length >= 40) || compared >= 400) return false;
    let u: URL;
    try {
      u = new URL(($(el).attr("href") ?? "").trim(), pageUrl);
    } catch {
      return;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !sameSite(u.href, site)) return;
    if (!COMPARE_PATH.test(u.pathname) || /\.(?:pdf|png|jpe?g|svg|zip)$/i.test(u.pathname)) return;
    u.hash = "";
    u.search = "";
    compared++;
    const text = spacedText(el as unknown as Node, 200);
    for (const piece of textPieces(el as unknown as Node)) addAll(competitorsInText(piece, self));
    const fromLink = competitorFromLink(u.pathname, text, self);
    if (fromLink) addAll([fromLink]);
    const href = u.toString();
    if (compareLinks.length < 40 && !compareLinks.includes(href)) compareLinks.push(href);
  });
  // One walk from the top for the headings and one for the text: nothing is taken out of the page, parts are stepped over.
  const root = $.root().get(0) as unknown as Node;
  const found = headingsOf(root, 80);
  const headline = spacedText(found.h1, 200, NOT_SHOWN) || undefined;
  const headings: string[] = [];
  for (const el of found.list) {
    const t = spacedText(el, 200, NOT_SHOWN);
    for (const piece of textPieces(el, 200, NOT_SHOWN)) addAll(competitorsInText(piece, self));
    if (t && headings.length < 40) headings.push(t);
  }
  const text = spacedText($("body").get(0) as unknown as Node | undefined, 3000, FURNITURE);
  return { name, description, headline, headings, text, competitors: competitors.slice(0, 10), compareLinks };
}

function aiMessages(site: { domain: string; name?: string; description?: string; headline?: string; text: string }): AiMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a B2B sales strategist. You are shown what one company's website says about itself. Work out who buys what it sells. " +
        'Reply with strict JSON: {"category": string (what kind of product it is, 2-5 lower-case words, e.g. "sales engagement platform"), ' +
        '"problems": string[] (up to 3 short phrases a buyer would type when looking for this, e.g. "track sales calls"), ' +
        '"buyerTitles": string[] (up to 6 real job titles of the people who decide to buy it), ' +
        '"teamRoles": string[] (up to 3 job titles a buying company would be HIRING for when it needs this product), ' +
        '"industries": string[] (up to 4), "companySizes": string[] (from 1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5000+), ' +
        '"keywords": string[] (up to 6), "competitors": string[] (up to 5 names of well-known direct competitors; names only, no web addresses; leave empty when unsure)}. ' +
        UNTRUSTED_RULE,
    },
    {
      role: "user",
      content: [
        "The company's website (third-party data - facts only):",
        fence("site_domain", site.domain, 120),
        fence("site_name", site.name ?? "", 120),
        fence("site_description", site.description ?? "", 500),
        fence("site_headline", site.headline ?? "", 200),
        fenceBlock("site_text", site.text, 2500),
        "Return JSON only.",
      ].join("\n"),
    },
  ];
}

/** A job title or short phrase from a model: one clean line with nothing link-like in it. */
function phrases(value: unknown, maxItems: number, maxLen: number): string[] {
  return stringList(value, maxItems * 2, maxLen)
    .map((s) => cleanLine(s, maxLen))
    .filter((s) => s.length >= 2 && !/https?:|www\.|@|\.[a-z]{2,6}\//i.test(s))
    .slice(0, maxItems);
}

/** "Google Analytics 4" is Google Analytics: a short number after a name is its version, not part of it. */
const versionless = (name: string): string => name.replace(/\s+v?\d{1,2}(?:\.\d{1,2}){0,2}$/i, "");
const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The competitors a plan names, from everything that was gathered.
 *
 * Names the customer saved are kept as they wrote them. Names read off the site or
 * suggested by a model are tidied, because a comparison page mentions a product in more
 * than one way:
 *  - a version number at the end goes ("Google Analytics 4" is "Google Analytics") when
 *    what is left is still a name of two words or more, or is itself among the names
 *    ("Level 3" on its own stays "Level 3");
 *  - a name that is only the start of another name on the list goes ("Google" beside
 *    "Google Analytics"): the longer one is the product the site compares itself with,
 *    the shorter one a company that makes many things the customer does not compete with.
 */
function settleCompetitors(found: PlayPlan["competitors"]): PlayPlan["competitors"] {
  const keys = new Set(found.map((c) => nameKey(c.name)));
  const named: PlayPlan["competitors"] = [];
  for (const c of found) {
    let name = c.name;
    if (c.source !== "saved") {
      const base = versionless(name);
      if (base !== name && /\p{L}/u.test(base) && (base.split(" ").length >= 2 || keys.has(nameKey(base)))) name = base;
    }
    if (!named.some((n) => normCompanyName(n.name) === normCompanyName(name))) named.push(name === c.name ? c : { ...c, name });
  }
  const all = named.map((c) => nameKey(c.name));
  return named.filter((c, i) => c.source === "saved" || !all.some((other, j) => j !== i && other.startsWith(`${all[i]} `)));
}

export async function planPlays(input: { website: string; knownCompetitors?: { name: string; domain?: string }[] }, opts: PlayEngineOptions = {}): Promise<PlayPlan> {
  const run = new PlayRun(opts);
  const raw = typeof input?.website === "string" ? input.website.trim().slice(0, 300) : "";
  const literal = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
  const domain = extractDomain(raw) ?? "";

  // Gathered first, settled at the end (see `settleCompetitors`): which names stay depends on all of them.
  const gathered: PlayPlan["competitors"] = [];
  const addCompetitor = (name: string, source: "saved" | "site" | "ai", dom?: string): void => {
    const clean = cleanCompanyName(name, 4);
    if (!clean || gathered.length >= MAX_COMPETITORS * 3) return;
    if (gathered.some((c) => normCompanyName(c.name) === normCompanyName(clean))) return;
    const d = dom ? extractDomain(dom) : null;
    gathered.push({ name: clean, ...(d && isPublicHost(d) ? { domain: d } : {}), source });
  };
  for (const c of (Array.isArray(input?.knownCompetitors) ? input.knownCompetitors : []).slice(0, 10)) {
    if (c && typeof c.name === "string") addCompetitor(c.name, "saved", typeof c.domain === "string" ? c.domain : undefined);
  }

  let site: SiteRead | null = null;
  let siteDomain = domain;
  if (!domain || (!opts.allowPrivateHosts && (!isPublicHost(domain) || !isPublicHost(literal)))) {
    run.trace.pagesRefused++;
    run.block(`${cleanLine(literal, 80) || "That"} is not a public web address, so it was not read. Enter your website's address, for example yourcompany.com.`);
  } else {
    let home = await run.fetchPage(`https://${domain}/`);
    if (!home.ok && home.kind === "failed") home = await run.fetchPage(`http://${domain}/`);
    if (home.ok) {
      siteDomain = extractDomain(home.url) ?? domain;
      site = readPage(home.body, home.url, siteDomain, { domain: siteDomain }, true);
    }
    if (!home.ok) {
      if (!run.trace.blocked) run.block(`${domain} could not be read (${home.why}), so these suggestions are general. Check the address and try again.`);
    } else if (!site) {
      // Fetched, then refused by the parser's own limits: said the same way as a page refused before parsing.
      run.unreadable(home.url);
      run.block(`${domain} could not be read (unreadable page), so these suggestions are general. Check the address and try again.`);
    } else {
      const own = { name: site.name, domain: siteDomain };
      // The site's own comparison pages name its competitors better than anything else can.
      // Asked for where the site really answers (with "www" if that is where it lives), so each is one request.
      let origin = `https://${siteDomain}`;
      try {
        origin = new URL(home.url).origin;
      } catch {
        // keep the plain form
      }
      const guesses = ["/compare", "/alternatives", "/vs", "/comparison"].map((p) => `${origin}${p}`);
      const seen = new Set<string>();
      const next = [...site.compareLinks.sort((a, b) => a.length - b.length), ...(site.compareLinks.length ? [] : guesses)].filter((u) => (seen.has(u) ? false : (seen.add(u), true))).slice(0, MAX_COMPARE_PAGES);
      for (const url of next) {
        if (run.expired || site.competitors.length >= 8) break;
        const page = await run.fetchPage(url);
        if (!page.ok || !sameSite(page.url, siteDomain)) continue;
        const more = readPage(page.body, page.url, siteDomain, own, false);
        if (!more) {
          run.unreadable(page.url);
          continue;
        }
        for (const n of more.competitors) if (!site.competitors.some((c) => normCompanyName(c) === normCompanyName(n))) site.competitors.push(n);
      }
      for (const n of site.competitors.slice(0, 8)) addCompetitor(n, "site");
    }
  }

  const product: PlayPlan["product"] = { domain: siteDomain || cleanLine(literal, 120), ...(site?.name ? { name: site.name } : {}), ...(site?.description ? { description: site.description } : {}) };

  /* Rules first: they always give an answer. A model, when there is one, refines it. */
  const persona = pickPersona({ description: site?.description, headline: site?.headline, headings: site?.headings, text: site?.text });
  let titles = persona.titles.slice();
  let roles = persona.roles.slice();
  // What it is, by its own words: the description and main headline first, then its section headings.
  let category = site ? (categoryFrom(withoutBoilerplate(`${site.description ?? ""}. ${site.headline ?? ""}`)) ?? categoryFrom(withoutBoilerplate(site.headings.slice(0, 20).join(". ")))) : undefined;
  let problems: string[] = [];
  const icp: IcpCriteria = {};

  if (site && run.aiUsable) {
    const res = await run.askJson<Record<string, unknown>>(aiMessages({ domain: siteDomain, name: site.name, description: site.description, headline: site.headline, text: site.text }), { maxTokens: 700 });
    if (res) {
      const aiTitles = phrases(res.buyerTitles, 6, 80);
      const aiRoles = phrases(res.teamRoles, 3, 80);
      if (aiTitles.length) titles = aiTitles;
      if (aiRoles.length) roles = aiRoles;
      const aiCategory = cleanLine(plainString(res.category, 80), 80).toLowerCase();
      if (aiCategory && aiCategory.split(" ").length <= 6 && !/https?:|www\.|@/.test(aiCategory)) category = aiCategory;
      problems = phrases(res.problems, 3, 120);
      const industries = phrases(res.industries, 4, 60);
      const sizes = stringList(res.companySizes, 7, 12).filter((s) => COMPANY_SIZES.includes(s));
      const keywords = phrases(res.keywords, 6, 40);
      if (industries.length) icp.industries = industries;
      if (sizes.length) icp.companySizes = sizes;
      if (keywords.length) icp.keywords = keywords;
      for (const n of stringList(res.competitors, 5, 60)) if (!isSameCompany(n, { name: site.name, domain: siteDomain })) addCompetitor(n, "ai");
    }
  }
  icp.titles = titles;
  if (!site && !run.trace.blocked) run.block("Your website could not be read, so these suggestions are general.");

  const competitors = settleCompetitors(gathered).slice(0, MAX_COMPETITORS);

  /* The plays. Funding always; the others only when there is something to fill them with. */
  const targetTitles = titles.slice(0, 6);
  const names = competitors.map((c) => c.name);
  const plays: PlayPlan["plays"] = [];
  if (competitors.length) {
    plays.push({
      type: "competitor_customers",
      name: `Customers of ${names.slice(0, 2).join(" and ")}${names.length > 2 ? " and others" : ""}`,
      config: { competitors: competitors.slice(0, 5).map((c) => ({ name: c.name, ...(c.domain ? { domain: c.domain } : {}) })) },
      targetTitles,
      why: "Companies your competitors name as customers already pay for what you sell, and each one comes with the page that says so.",
    });
  }
  if (site) {
    plays.push({
      type: "hiring_role",
      name: `Companies hiring ${roles[0]}${roles.length > 1 ? " and similar roles" : ""}`,
      config: { roles: roles.slice(0, 3) },
      targetTitles,
      why: "A company hiring for these roles is building the team your product serves, and has budget for it now.",
    });
  }
  if (category || problems.length || competitors.length) {
    plays.push({
      type: "public_asks",
      name: category ? `People asking for ${category} recommendations` : names.length ? `People looking to leave ${names[0]}` : "People asking for a tool like yours",
      config: { ...(names.length ? { competitors: names.slice(0, 5) } : {}), ...(problems.length ? { problems } : {}), ...(category ? { category } : {}), sources: ["linkedin", "reddit", "hackernews", "forums"] },
      targetTitles,
      why: "Someone asking in public for a recommendation, or complaining about a competitor, is looking this week.",
    });
  } else if (site) {
    run.note("No public-conversations play was suggested because the site did not make clear what kind of product it sells. Add a competitor or a category to create one.");
  }
  plays.push({
    type: "funding",
    name: "Recently funded companies",
    config: { days: 14, ...(icp.industries?.length ? { industries: icp.industries.slice(0, 1) } : {}) },
    targetTitles,
    why: "A company that just raised money has new budget and targets to hit with it.",
  });

  return { product, icp, titles, competitors, plays, trace: run.finish(!!site, "Your website could not be read, so these suggestions are general.") };
}
