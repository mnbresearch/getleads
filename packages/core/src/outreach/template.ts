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
  return {
    first_name: lead.firstName ?? lead.fullName?.split(" ")[0] ?? "",
    last_name: lead.lastName ?? "",
    full_name: lead.fullName ?? [lead.firstName, lead.lastName].filter(Boolean).join(" "),
    title: lead.title ?? "",
    email: lead.email ?? "",
    location: lead.location ?? "",
    company: lead.company?.name ?? lead.company?.domain ?? "",
    company_domain: lead.company?.domain ?? "",
    industry: lead.company?.industry ?? "",
    company_description: lead.company?.description ?? "",
    sender_name: sender.name ?? "",
    sender_company: sender.company ?? "",
    signature: sender.signature ?? "",
    ...(lead.custom ?? {}),
  };
}

export function textToHtml(text: string) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em 0;line-height:1.5">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
