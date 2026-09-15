/** WhatsApp Cloud API (Meta) - free tier: 1,000 service conversations/month. Template messages required for outbound-first. */
import { fetchWithTimeout } from "../util/http.js";

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion?: string;
}

export interface WhatsAppSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export function normalizePhone(raw: string, defaultCountryCode = "91") {
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10) d = defaultCountryCode + d;
  return d;
}

/** Send a plain text message (only works inside a 24h customer-service window) or a template. */
export async function sendWhatsApp(cfg: WhatsAppConfig, to: string, msg: { text?: string; template?: { name: string; language?: string; params?: string[] } }): Promise<WhatsAppSendResult> {
  const body = msg.template
    ? { messaging_product: "whatsapp", to, type: "template", template: { name: msg.template.name, language: { code: msg.template.language ?? "en" }, components: msg.template.params?.length ? [{ type: "body", parameters: msg.template.params.map((p) => ({ type: "text", text: p })) }] : [] } }
    : { messaging_product: "whatsapp", to, type: "text", text: { body: msg.text ?? "", preview_url: true } };
  try {
    const res = await fetchWithTimeout(`https://graph.facebook.com/${cfg.apiVersion ?? "v20.0"}/${cfg.phoneNumberId}/messages`, {
      method: "POST",
      timeoutMs: 15_000,
      headers: { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
    if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
