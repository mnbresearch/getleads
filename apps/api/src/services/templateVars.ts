import { leads, sql, type Db } from "@prospex/db";

/**
 * Template variables a sequence step may use.
 *
 * The renderer replaces a variable it does not know with nothing, so a step written with
 * {{firstName}} or {{companyName}} (the spellings other tools use) went out as "Hi ," with a
 * blank where the company should be - and nobody was told. Steps are now checked when they
 * are saved and when they are previewed: an unknown variable is a 400 that lists the unknown
 * ones and the ones that exist. Steps already stored are not re-checked when they send, so a
 * running campaign is never stopped by this.
 *
 * Allowed: the names below (from leadVars in core), any custom field a lead in this
 * workspace actually has (CSV and CRM columns are spread into the variables), and any
 * variable written with a fallback - {{x | fallback:"..."}} never renders blank.
 */
export const TEMPLATE_VARIABLES = [
  "first_name",
  "last_name",
  "full_name",
  "title",
  "email",
  "location",
  "company",
  "company_domain",
  "industry",
  "company_description",
  "sender_name",
  "sender_company",
  "signature",
  // Written onto every lead a play finds (the one-sentence reason it was found).
  "relevant_because",
] as const;

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(\|\s*fallback:\s*"[^"]*")?\s*\}\}/g;

/** The variable names in a template that have no fallback, in order of first use. */
export function variablesWithoutFallback(template: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(template ?? "").matchAll(VAR_RE)) {
    if (m[2]) continue;
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Custom-field names present on this workspace's leads (bounded: the newest 5,000 leads). */
export async function customFieldNames(db: Db, orgId: string): Promise<string[]> {
  const r = await db.execute(sql`SELECT DISTINCT k FROM (SELECT custom FROM ${leads} WHERE org_id = ${orgId} AND custom IS NOT NULL AND custom <> '{}'::jsonb ORDER BY created_at DESC LIMIT 5000) l, jsonb_object_keys(l.custom) AS k LIMIT 500`);
  const rows = ((r as unknown as { rows?: { k: string }[] }).rows ?? (r as unknown as { k: string }[])) as { k: string }[];
  return rows.map((x) => x.k).filter((k) => typeof k === "string");
}

type StepText = { subjectTemplate?: string | null; bodyTemplate?: string | null; variants?: { subjectTemplate?: string | null; bodyTemplate?: string | null }[] | null };

/** Unknown variables across the given steps' subjects, bodies and variants. */
export function unknownVariables(steps: StepText[], custom: string[]): string[] {
  const known = new Set<string>([...TEMPLATE_VARIABLES, ...custom]);
  const out: string[] = [];
  for (const s of steps) {
    const texts = [s.subjectTemplate, s.bodyTemplate, ...(s.variants ?? []).flatMap((v) => [v.subjectTemplate, v.bodyTemplate])];
    for (const t of texts) for (const v of variablesWithoutFallback(t)) if (!known.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The sentence a customer reads when a step uses variables that would send blank. */
export function unknownVariablesMessage(unknown: string[]): string {
  const list = unknown.map((v) => `{{${v}}}`).join(", ");
  const allowed = TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ");
  return `${unknown.length === 1 ? "This variable is" : "These variables are"} not known, so ${unknown.length === 1 ? "it" : "they"} would send as blank text: ${list}. Use one of ${allowed}, a custom field your leads have, or add a fallback like {{${unknown[0]} | fallback:"there"}}.`;
}
