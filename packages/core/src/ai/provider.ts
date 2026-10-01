import type { AiMessage, AiProvider } from "../types.js";
import { fetchWithTimeout } from "../util/http.js";
import { meter } from "../util/meter.js";

type CompleteOpts = { maxTokens?: number; temperature?: number; json?: boolean };

/**
 * Pick a usable chat model from an OpenAI-compatible /models listing.
 *
 * Exported for testing because the selection rules are the fiddly part: these listings
 * mix speech, embedding, moderation and TTS models in with chat models, and picking one
 * of those produces a confusing runtime failure rather than an obvious one.
 *
 * Prefers small/fast variants, which is the right default for this app's high-volume,
 * low-complexity calls.
 */
export function pickChatModel(ids: string[]): string | null {
  const NON_CHAT = /(whisper|tts|embed|embedding|moderation|guard|rerank|vision-only|image|dall|sora|audio)/i;
  const candidates = ids.filter((id) => id && !NON_CHAT.test(id));
  if (candidates.length === 0) return null;
  const score = (id: string) => {
    let s = 0;
    if (/instant|mini|small|flash|fast|8b|20b|lite/i.test(id)) s += 10;
    if (/llama/i.test(id)) s += 3;
    if (/preview|deprecated|beta/i.test(id)) s -= 8;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a) || a.length - b.length)[0];
}

/** Does this error body mean "that model is not available to this key"? */
function isModelNotFound(status: number, body: string): boolean {
  return (status === 404 || status === 400) && /model_not_found|does not exist|do not have access/i.test(body);
}

/**
 * OpenAI-compatible chat completions (Groq, Together, OpenRouter, Ollama, etc.).
 *
 * Self-heals against catalogue drift. Provider model catalogues move fast and a pinned
 * default rots: this codebase has already been broken twice by Groq retiring a model, and
 * a key can also simply lack access to a model that still exists. Rather than pin a third
 * name and wait for it to fail, a model_not_found response triggers one lookup of the
 * provider's own /models list, picks a usable chat model, retries, and remembers it for
 * the life of the process.
 *
 * An explicitly configured model is still tried first, so this never silently overrides
 * a deliberate choice. It only rescues a call that would otherwise have failed outright.
 */
class OpenAICompatProvider implements AiProvider {
  constructor(
    public name: string,
    private baseUrl: string,
    private apiKey: string,
    public model: string,
  ) {}

  private async listModels(): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl.replace(/\/$/, "")}/models`, {
        method: "GET",
        timeoutMs: 20_000,
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id?: string }[] };
      return (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
    } catch {
      return [];
    }
  }

  private async post(model: string, messages: AiMessage[], opts: CompleteOpts) {
    return fetchWithTimeout(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      timeoutMs: 60_000,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.4,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  }

  async complete(messages: AiMessage[], opts: CompleteOpts = {}) {
    meter(this.name);
    let res = await this.post(this.model, messages, opts);

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (!isModelNotFound(res.status, body)) throw new Error(`${this.name} ${res.status}: ${body}`);

      const available = await this.listModels();
      const next = pickChatModel(available);
      if (!next || next === this.model) {
        throw new Error(
          `${this.name} ${res.status}: ${body}` +
            (available.length ? ` (no usable chat model among: ${available.slice(0, 8).join(", ")})` : " (could not list available models)"),
        );
      }
      // Remember it: the original default is dead for this key, so retrying it every call
      // would double the latency and the error rate for no reason.
      this.model = next;
      res = await this.post(next, messages, opts);
      if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

class GeminiProvider implements AiProvider {
  name = "gemini";
  constructor(
    private apiKey: string,
    // gemini-2.0-flash was retired as of Sep 2026. gemini-3.6-flash (Google's own suggested
    // replacement) is GA but was returning 503 "high demand" under free-tier load when this
    // was checked; gemini-3.5-flash-lite is Google's purpose-built high-volume/low-cost tier,
    // a better fit here and less capacity-constrained. Override via GEMINI_MODEL if needed.
    public model = "gemini-3.5-flash-lite",
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

/**
 * Try each configured engine in order until one answers.
 *
 * render.yaml has always promised "second one is automatic fallback if the first is
 * rate-limited", and createAiProvider returned exactly one engine - so a Groq 429 failed the
 * whole call (and, through parseQuery, the whole search) while a working Gemini key sat
 * unused. Every error falls through, not just 429/5xx: a rejected Groq key is no reason to
 * refuse a request Gemini can serve, and if the request itself is bad every engine will say
 * so and the last error is what the caller sees.
 *
 * Reports itself under the primary's name and model so existing `hasAi()` checks and logs
 * read the same as before; `lastAnsweredBy` says which engine actually answered.
 */
export class FallbackAiProvider implements AiProvider {
  /** Engine that answered the most recent successful call. */
  lastAnsweredBy: string | null = null;
  /** Errors from engines skipped on the most recent call, oldest first. */
  lastFailures: { provider: string; message: string }[] = [];

  constructor(public readonly chain: AiProvider[]) {
    if (!chain.length) throw new Error("FallbackAiProvider needs at least one provider");
  }

  get name() {
    return this.chain[0].name;
  }

  get model() {
    return this.chain[0].model;
  }

  async complete(messages: AiMessage[], opts: CompleteOpts = {}) {
    const failures: { provider: string; message: string }[] = [];
    for (const p of this.chain) {
      try {
        const out = await p.complete(messages, opts);
        this.lastAnsweredBy = p.name;
        this.lastFailures = failures;
        if (failures.length) console.warn(`[ai] ${p.name} answered after ${failures.map((f) => `${f.provider} failed (${f.message.slice(0, 80)})`).join(", ")}`);
        return out;
      } catch (e) {
        failures.push({ provider: p.name, message: ((e as Error).message ?? String(e)).slice(0, 300) });
      }
    }
    this.lastFailures = failures;
    throw new Error(failures.map((f) => f.message).join(" | "));
  }
}

/** One engine as itself, several as a fallback chain, none as the deterministic NullProvider. */
function chainOf(list: AiProvider[]): AiProvider {
  if (!list.length) return new NullProvider();
  if (list.length === 1) return list[0];
  return new FallbackAiProvider(list);
}

export function createAiProvider(cfg: AiConfig = configFromEnv()): AiProvider {
  const want = (cfg.provider ?? "auto").toLowerCase();
  const groq = () =>
    // llama-3.3-70b-versatile returned 404 model_not_found as of Sep 2026 - Groq's catalog
    // moves fast. llama-3.1-8b-instant is a stable, currently-supported fallback default;
    // override via GROQ_MODEL if Groq adds back a stronger default worth pinning to.
    cfg.groqApiKey && new OpenAICompatProvider("groq", "https://api.groq.com/openai/v1", cfg.groqApiKey, cfg.groqModel ?? "llama-3.1-8b-instant");
  const gemini = () => cfg.geminiApiKey && new GeminiProvider(cfg.geminiApiKey, cfg.geminiModel);
  const anthropic = () => cfg.anthropicApiKey && new AnthropicProvider(cfg.anthropicApiKey, cfg.anthropicModel);
  const compat = () =>
    cfg.openaiCompatBaseUrl &&
    new OpenAICompatProvider("openai-compat", cfg.openaiCompatBaseUrl, cfg.openaiCompatApiKey ?? "none", cfg.openaiCompatModel ?? "gpt-4o-mini");

  const table: Record<string, () => AiProvider | undefined | "" > = { groq, gemini, anthropic, "openai-compat": compat };
  // An explicitly chosen engine goes first; every other configured engine follows in the
  // usual priority order as fallback.
  const order: (() => AiProvider | undefined | "")[] = [anthropic, groq, gemini, compat];
  const first = want !== "auto" ? table[want] : undefined;
  const chain: AiProvider[] = [];
  for (const f of first ? [first, ...order.filter((f) => f !== first)] : order) {
    const p = f();
    if (p) chain.push(p);
  }
  return chainOf(chain);
}

/**
 * Plan-aware provider selection: free/pilot/starter plans never touch the paid Anthropic
 * provider (mirrors the premiumLeadsPerMonth pattern in plans.ts - free-tier providers stay
 * free until there's a paying customer to fund the paid tier). Growth+ plans get the normal
 * priority order (anthropic first when configured, for best quality).
 */
const FREE_TIER_ONLY_PLANS = new Set(["free", "pilot", "starter"]);

export function createAiProviderForPlan(plan: string, cfg: AiConfig = configFromEnv()): AiProvider {
  if (FREE_TIER_ONLY_PLANS.has((plan || "free").toLowerCase())) {
    const { anthropicApiKey, ...rest } = cfg;
    void anthropicApiKey;
    return createAiProvider({ ...rest, provider: cfg.provider === "anthropic" ? "auto" : cfg.provider });
  }
  return createAiProvider(cfg);
}

/**
 * Every provider that is actually configured, not just the winner of the priority order.
 *
 * createAiProvider() picks one engine, which is right for generating a single email or
 * brief. AI visibility is the opposite problem: engines genuinely disagree about who they
 * recommend, so measuring one and calling it "what AI says" is wrong. This returns all of
 * them so a prompt can be sampled across the whole set.
 */
export function availableAiProviders(cfg: AiConfig = configFromEnv()): AiProvider[] {
  const out: AiProvider[] = [];
  if (cfg.anthropicApiKey) out.push(new AnthropicProvider(cfg.anthropicApiKey, cfg.anthropicModel));
  if (cfg.groqApiKey) out.push(new OpenAICompatProvider("groq", "https://api.groq.com/openai/v1", cfg.groqApiKey, cfg.groqModel ?? "llama-3.1-8b-instant"));
  if (cfg.geminiApiKey) out.push(new GeminiProvider(cfg.geminiApiKey, cfg.geminiModel));
  if (cfg.openaiCompatBaseUrl) {
    out.push(new OpenAICompatProvider("openai-compat", cfg.openaiCompatBaseUrl, cfg.openaiCompatApiKey ?? "none", cfg.openaiCompatModel ?? "gpt-4o-mini"));
  }
  return out;
}

/** Same free-tier-first gating as createAiProviderForPlan: paid engines need a paying plan. */
export function availableAiProvidersForPlan(plan: string, cfg: AiConfig = configFromEnv()): AiProvider[] {
  if (FREE_TIER_ONLY_PLANS.has((plan || "free").toLowerCase())) {
    const { anthropicApiKey, ...rest } = cfg;
    void anthropicApiKey;
    return availableAiProviders(rest);
  }
  return availableAiProviders(cfg);
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
