import type { AiMessage, AiProvider } from "../types.js";
import { fetchWithTimeout } from "../util/http.js";
import { meter } from "../util/meter.js";

type CompleteOpts = { maxTokens?: number; temperature?: number; json?: boolean };

/** OpenAI-compatible chat completions (Groq, Together, OpenRouter, Ollama, etc.). */
class OpenAICompatProvider implements AiProvider {
  constructor(
    public name: string,
    private baseUrl: string,
    private apiKey: string,
    public model: string,
  ) {}
  async complete(messages: AiMessage[], opts: CompleteOpts = {}) {
    meter(this.name);
    const res = await fetchWithTimeout(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      timeoutMs: 60_000,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.4,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

class GeminiProvider implements AiProvider {
  name = "gemini";
  constructor(
    private apiKey: string,
    public model = "gemini-2.0-flash",
  ) {}
  async complete(messages: AiMessage[], opts: CompleteOpts = {}) {
    meter("gemini");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        timeoutMs: 60_000,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents,
          generationConfig: {
            maxOutputTokens: opts.maxTokens ?? 1024,
            temperature: opts.temperature ?? 0.4,
            ...(opts.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  }
}

class AnthropicProvider implements AiProvider {
  name = "anthropic";
  constructor(
    private apiKey: string,
    public model = "claude-3-5-haiku-latest",
  ) {}
  async complete(messages: AiMessage[], opts: CompleteOpts = {}) {
    meter("anthropic");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    if (opts.json) rest.push({ role: "assistant", content: "{" });
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      timeoutMs: 60_000,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.4,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = data.content.map((c) => c.text ?? "").join("");
    return opts.json ? `{${text}` : text;
  }
}

/** Deterministic fallback so the platform never hard-fails without an AI key. */
class NullProvider implements AiProvider {
  name = "none";
  model = "none";
  async complete(messages: AiMessage[], opts: CompleteOpts = {}) {
    if (opts.json) return "{}";
    return "";
  }
}

export interface AiConfig {
  provider?: string;
  groqApiKey?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  openaiCompatBaseUrl?: string;
  openaiCompatApiKey?: string;
  openaiCompatModel?: string;
  groqModel?: string;
  geminiModel?: string;
  anthropicModel?: string;
}

export function configFromEnv(env = process.env): AiConfig {
  return {
    provider: env.AI_PROVIDER || "auto",
    groqApiKey: env.GROQ_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiCompatBaseUrl: env.OPENAI_COMPAT_BASE_URL,
    openaiCompatApiKey: env.OPENAI_COMPAT_API_KEY,
    openaiCompatModel: env.OPENAI_COMPAT_MODEL,
    groqModel: env.GROQ_MODEL,
    geminiModel: env.GEMINI_MODEL,
    anthropicModel: env.ANTHROPIC_MODEL,
  };
}

export function createAiProvider(cfg: AiConfig = configFromEnv()): AiProvider {
  const want = (cfg.provider ?? "auto").toLowerCase();
  const groq = () =>
    cfg.groqApiKey && new OpenAICompatProvider("groq", "https://api.groq.com/openai/v1", cfg.groqApiKey, cfg.groqModel ?? "llama-3.3-70b-versatile");
  const gemini = () => cfg.geminiApiKey && new GeminiProvider(cfg.geminiApiKey, cfg.geminiModel);
  const anthropic = () => cfg.anthropicApiKey && new AnthropicProvider(cfg.anthropicApiKey, cfg.anthropicModel);
  const compat = () =>
    cfg.openaiCompatBaseUrl &&
    new OpenAICompatProvider("openai-compat", cfg.openaiCompatBaseUrl, cfg.openaiCompatApiKey ?? "none", cfg.openaiCompatModel ?? "gpt-4o-mini");

  const table: Record<string, () => AiProvider | undefined | "" > = { groq, gemini, anthropic, "openai-compat": compat };
  if (want !== "auto" && table[want]) {
    const p = table[want]();
    if (p) return p;
  }
  for (const f of [anthropic, groq, gemini, compat]) {
    const p = f();
    if (p) return p;
  }
  return new NullProvider();
}

export function hasAi(p: AiProvider) {
  return p.name !== "none";
}

/** Ask for JSON and parse defensively. */
export async function completeJson<T = Record<string, unknown>>(
  ai: AiProvider,
  messages: AiMessage[],
  opts: CompleteOpts = {},
): Promise<T | null> {
  const raw = await ai.complete(messages, { ...opts, json: true });
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
