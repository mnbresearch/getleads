import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiProvider, createAiProviderForPlan, FallbackAiProvider } from "./provider.js";
import type { AiProvider } from "../types.js";

const fake = (name: string, fn: () => Promise<string>): AiProvider => ({ name, model: `${name}-m`, complete: fn });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI fallback", () => {
  it("tries the next engine when the first is rate limited", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ai = new FallbackAiProvider([fake("groq", async () => { throw new Error("groq 429: slow down"); }), fake("gemini", async () => "hello")]);
    expect(ai.name).toBe("groq");
    expect(await ai.complete([{ role: "user", content: "hi" }])).toBe("hello");
    expect(ai.lastAnsweredBy).toBe("gemini");
    expect(ai.lastFailures[0].provider).toBe("groq");
  });

  it("throws every engine's error when none answers", async () => {
    const ai = new FallbackAiProvider([fake("groq", async () => { throw new Error("groq 503"); }), fake("gemini", async () => { throw new Error("gemini 500"); })]);
    await expect(ai.complete([])).rejects.toThrow(/groq 503 \| gemini 500/);
  });

  it("createAiProvider chains Groq then Gemini (mocked fetch)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string | URL) =>
        String(u).includes("groq.com")
          ? new Response("rate limited", { status: 429 })
          : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "from gemini" }] } }] }), { status: 200 }),
      ),
    );
    const ai = createAiProvider({ provider: "auto", groqApiKey: "g", geminiApiKey: "m" });
    expect(ai.name).toBe("groq");
    expect(await ai.complete([{ role: "user", content: "x" }])).toBe("from gemini");
  });

  it("returns a single engine unwrapped, and the null provider with none", () => {
    expect(createAiProvider({ groqApiKey: "g" })).not.toBeInstanceOf(FallbackAiProvider);
    expect(createAiProvider({}).name).toBe("none");
  });

  it("free, pilot and starter plans never get Anthropic, even as a fallback", () => {
    for (const plan of ["free", "pilot", "starter", ""]) {
      const ai = createAiProviderForPlan(plan, { provider: "anthropic", anthropicApiKey: "a", groqApiKey: "g", geminiApiKey: "m" });
      expect(ai).toBeInstanceOf(FallbackAiProvider);
      expect((ai as FallbackAiProvider).chain.map((p) => p.name)).toEqual(["groq", "gemini"]);
    }
    const growth = createAiProviderForPlan("growth", { anthropicApiKey: "a", groqApiKey: "g" }) as FallbackAiProvider;
    expect(growth.chain.map((p) => p.name)).toEqual(["anthropic", "groq"]);
  });
});
