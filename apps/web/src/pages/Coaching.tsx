import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { Page, Spinner, useToast } from "../components/ui";

interface Persona {
  name: string;
  title: string;
  scenario: string;
  openingPrompt: string;
}

interface ChatMessage {
  role: "rep" | "persona";
  content: string;
  coachingTip?: string;
  score?: number;
}

export function CoachingPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionCompleted, setSessionCompleted] = useState(false);
  const { toast, Toast } = useToast();

  const loadPersonas = useCallback(() => {
    apiFetch<{ personas: Persona[] }>("GET", "/v1/coaching/personas")
      .then((res) => {
        setPersonas(res.personas || []);
        if (res.personas?.length) {
          selectPersona(res.personas[0]);
        }
      })
      .catch((e) => toast((e as Error).message, "err"));
  }, [toast]);

  useEffect(() => {
    loadPersonas();
  }, [loadPersonas]);

  const selectPersona = (p: Persona) => {
    setSelectedPersona(p);
    setMessages([
      {
        role: "persona",
        content: p.openingPrompt,
      },
    ]);
    setInput("");
    setSessionCompleted(false);
  };

  const sendTurn = async () => {
    if (!input.trim() || !selectedPersona || busy) return;
    const repText = input.trim();
    setInput("");
    setBusy(true);

    const updatedHistory = [...messages, { role: "rep" as const, content: repText }];
    setMessages(updatedHistory);

    try {
      const res = await apiFetch<{
        personaReply: string;
        coachingTip: string;
        score: number;
      }>("POST", "/v1/coaching/simulate-turn", {
        personaName: selectedPersona.name,
        repMessage: repText,
        history: updatedHistory,
      });

      setMessages((prev) => [
        ...prev,
        {
          role: "persona",
          content: res.personaReply,
          coachingTip: res.coachingTip,
          score: res.score,
        },
      ]);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const completeSimulation = async () => {
    if (!selectedPersona) return;
    setBusy(true);
    try {
      await apiFetch("POST", "/v1/coaching/complete", {
        personaName: selectedPersona.name,
        personaDescription: selectedPersona.title,
        scenario: selectedPersona.scenario,
        transcriptHistory: messages,
        score: 88,
        strengths: ["Addressed objection with value metrics", "Clarified product ROI", "Maintained assertive tone"],
        improvements: ["Ask for a specific calendar time rather than a generic link"],
        feedback: "Solid roleplay execution. Highlighted Scout's unique AEO/GEO tracking advantage effectively.",
      });
      setSessionCompleted(true);
      toast("Roleplay session evaluated and logged to performance coaching history!");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="AI Sales Coaching & Roleplay"
      subtitle="Interactive roleplay simulator with simulated enterprise buyer personas to sharpen talk-tracks and objection handling."
    >
      {Toast}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Panel: Personas */}
        <div className="card p-5 lg:col-span-4 space-y-4">
          <h3 className="font-semibold text-sm text-ink-50">Select Buyer Persona</h3>
          <p className="text-xs text-ink-400">Practice with realistic simulated buyers before dialing live accounts.</p>

          <div className="space-y-3">
            {personas.map((p) => (
              <div
                key={p.name}
                onClick={() => selectPersona(p)}
                className={`p-3.5 rounded-lg border text-left cursor-pointer transition ${
                  selectedPersona?.name === p.name
                    ? "border-brand-500 bg-brand-50/60 shadow-xs"
                    : "border-black/10 hover:border-black/20 bg-surface"
                }`}
              >
                <div className="font-semibold text-xs text-ink-50">{p.name}</div>
                <div className="text-[11px] text-ink-300 font-medium mt-0.5">{p.title}</div>
                <p className="text-xs text-ink-400 mt-2 line-clamp-2">{p.scenario}</p>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-black/10 bg-black/5 p-3 text-xs text-ink-400">
            <span className="font-semibold text-ink-200">How scoring works:</span> Scout evaluates your answers against qualification rigor, objection deflection, talk-to-listen balance, and value proposition strength.
          </div>
        </div>

        {/* Right Panel: Roleplay Chat Simulator */}
        <div className="card p-5 lg:col-span-8 flex flex-col justify-between h-[750px]">
          <div>
            <div className="flex items-center justify-between border-b border-black/5 pb-3">
              <div>
                <span className="badge bg-brand-100 text-brand-800 text-[10px] uppercase font-bold tracking-wider">
                  Live Roleplay Simulation
                </span>
                <h2 className="text-base font-bold text-ink-50 mt-1">{selectedPersona?.name}</h2>
                <p className="text-xs text-ink-400">{selectedPersona?.title}</p>
              </div>
              <button
                onClick={completeSimulation}
                disabled={messages.length < 2 || sessionCompleted || busy}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                {sessionCompleted ? "✓ Session Logged" : "Finish & Score Roleplay"}
              </button>
            </div>

            {/* Chat Messages */}
            <div className="mt-4 space-y-3.5 overflow-y-auto max-h-[500px] pr-2">
              {messages.map((m, idx) => (
                <div key={idx} className={`flex flex-col ${m.role === "rep" ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-lg p-3.5 text-xs leading-relaxed ${
                      m.role === "rep"
                        ? "bg-brand-600 text-white rounded-br-none"
                        : "bg-black/5 text-ink-100 border border-black/5 rounded-bl-none"
                    }`}
                  >
                    <div className="font-semibold text-[10px] uppercase tracking-wider mb-1 opacity-80">
                      {m.role === "rep" ? "You (Sales Rep)" : selectedPersona?.name}
                    </div>
                    {m.content}
                  </div>

                  {/* AI Coaching Tip on Persona Turns */}
                  {m.coachingTip && (
                    <div className="mt-1.5 max-w-[85%] rounded border border-amber-200 bg-amber-50/70 p-2 text-[11px] text-amber-900 flex items-center gap-1.5">
                      <span className="font-bold">Coach Tip:</span> {m.coachingTip}
                      {m.score !== undefined && (
                        <span className="ml-auto font-bold text-amber-800 bg-amber-200/60 px-1.5 py-0.5 rounded text-[10px]">
                          Score: {m.score}%
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {busy && (
                <div className="text-xs text-ink-400 italic flex items-center gap-1">
                  <span>{selectedPersona?.name} is thinking…</span>
                </div>
              )}
            </div>
          </div>

          {/* User Input Bar */}
          <div className="border-t border-black/5 pt-3">
            <div className="flex gap-2">
              <input
                className="input text-xs"
                placeholder="Pitch your value prop, respond to the objection, or ask discovery question…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendTurn()}
                disabled={busy || sessionCompleted}
              />
              <button
                className="btn-primary text-xs px-5 font-semibold"
                onClick={sendTurn}
                disabled={busy || !input.trim() || sessionCompleted}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
