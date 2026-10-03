/**
 * What each integration is called on screen.
 *
 * The API speaks in slugs ("hubspot", "sheets"). Printed as they are, the app's own
 * sentences read "Queued 3 leads to hubspot" and the Push-to-CRM menu listed "zoho".
 */
const INTEGRATION_NAMES: Record<string, string> = {
  hubspot: "HubSpot",
  pipedrive: "Pipedrive",
  zoho: "Zoho CRM",
  sheets: "Google Sheets",
  cortex: "Cortex",
  webhook: "Webhook",
  whatsapp: "WhatsApp",
  apollo: "Apollo",
  hunter: "Hunter",
  slack: "Slack",
  salesforce: "Salesforce",
};

export function integrationName(slug: string | null | undefined): string {
  const s = String(slug ?? "").trim();
  if (!s) return "the integration";
  const known = INTEGRATION_NAMES[s.toLowerCase()];
  if (known) return known;
  // An integration this build does not know still reads as a name, not as a code.
  return s.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}
