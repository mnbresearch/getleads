/**
 * "1 lead", "2 leads", "0 leads" - a count with its noun, agreed.
 *
 * Counts were interpolated next to a hard-coded plural all over the app ("Enrolled 1 leads",
 * "1 errors"). One helper, so the next toast that prints a number cannot get it wrong.
 *
 *   plural(1, "lead")                 -> "1 lead"
 *   plural(2, "lead")                 -> "2 leads"
 *   plural(1200, "lead")              -> "1,200 leads"
 *   plural(2, "company", "companies") -> "2 companies"
 *   plural(2, "address")              -> "2 addresses"   (s/x/z/ch/sh take "es")
 */
export function plural(n: number | null | undefined, singular: string, pluralForm?: string): string {
  const count = Number.isFinite(n as number) ? (n as number) : 0;
  return `${count.toLocaleString()} ${pluralWord(count, singular, pluralForm)}`;
}

/** Only the noun, for sentences where the number is printed elsewhere ("was"/"were" etc.). */
export function pluralWord(n: number | null | undefined, singular: string, pluralForm?: string): string {
  if (n === 1) return singular;
  if (pluralForm) return pluralForm;
  if (/(s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  return `${singular}s`;
}
