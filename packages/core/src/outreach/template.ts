/** Tiny mustache-style renderer: {{first_name}}, {{company}}, {{title | fallback:"there"}} */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*fallback:\s*"([^"]*)")?\s*\}\}/g, (_, key: string, fallback?: string) => {
    const v = key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), vars);
    if (v === undefined || v === null || v === "") return fallback ?? "";
    return String(v);
  });
}

export function leadVars(lead: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  title?: string | null;
  email?: string | null;
  location?: string | null;
  company?: { name?: string | null; domain?: string | null; industry?: string | null; description?: string | null } | null;
  custom?: Record<string, unknown> | null;
}, sender: { name?: string; company?: string; signature?: string } = {}) {
  const custom = (lead.custom ?? {}) as Record<string, unknown>;
  /**
   * A lead's own field wins; a custom column of the same name only fills a gap. (Before, a
   * custom column always won, whatever it was called.)
   */
  const own = (key: string, value: string | null | undefined): string => {
    if (value) return value;
    const c = custom[key];
    return typeof c === "string" || typeof c === "number" ? String(c) : "";
  };
  /**
   * The company's name: the company record's (its name, else its address), else a custom
   * column called "company". A lead with no company record at all - one made from a play's
   * finding that named a company but no website - has the name it was found under in
   * `custom.company_name`, and that is used last, so a template can still say the company.
   */
  const companyName = (): string => {
    const named = own("company", lead.company?.name ?? lead.company?.domain);
    if (named || lead.company) return named;
    const found = custom.company_name;
    return typeof found === "string" || typeof found === "number" ? String(found) : "";
  };
  // Custom (CSV / CRM) columns FIRST, so the reserved names below always win. Spread last, a
  // CSV column called "sender_name" or "signature" replaced the sender's own identity in
  // every email sent to that lead. The three sender variables never come from lead data.
  return {
    ...custom,
    first_name: own("first_name", lead.firstName ?? lead.fullName?.split(" ")[0]),
    last_name: own("last_name", lead.lastName),
    full_name: own("full_name", lead.fullName ?? [lead.firstName, lead.lastName].filter(Boolean).join(" ")),
    title: own("title", lead.title),
    email: lead.email ?? "",
    location: own("location", lead.location),
    company: companyName(),
    company_domain: own("company_domain", lead.company?.domain),
    industry: own("industry", lead.company?.industry),
    company_description: own("company_description", lead.company?.description),
    sender_name: sender.name ?? "",
    sender_company: sender.company ?? "",
    signature: sender.signature ?? "",
  };
}

export function textToHtml(text: string) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em 0;line-height:1.5">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
