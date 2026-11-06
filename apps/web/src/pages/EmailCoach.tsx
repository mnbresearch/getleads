import { useState } from "react";
import { apiFetch } from "../lib/api";
import { Page } from "../components/ui";

interface CoachingFeedback {
  score: number;
  readingTimeSec: number;
  wordCount: number;
  charCount: number;
  grade: string;
  mobilePreview: {
    subjectTruncated: string;
    firstLinePreview: string;
    isMobileFriendly: boolean;
  };
  suggestions: {
    type: "critical" | "warning" | "positive";
    message: string;
  }[];
}

export function EmailCoachPage() {
  const [subject, setSubject] = useState("Quick question regarding outbound pipeline");
  const [body, setBody] = useState(
    "Hi Alex,\n\nSaw you're expanding the RevOps team at Scale. Most heads of sales we talk with struggle with decaying lists and reps wasting 4 hours daily researching prospects manually.\n\nScout connects waterfall data enrichment and an AI sales dialer so your reps can close twice as many meetings per week.\n\nOpen to exploring a brief 15-min walkthrough this Thursday?"
  );
  const [feedback, setFeedback] = useState<CoachingFeedback | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const analyzeEmail = async () => {
    setAnalyzing(true);
    try {
      const res = await apiFetch<CoachingFeedback>("POST", "/v1/scale/email-coach/score", { subject, body });
      setFeedback(res);
    } catch (e: any) {
      alert("Error scoring email: " + (e.message || "Unknown error"));
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <Page title="AI Email Coach & Grader" subtitle="Real-time sales email scoring, tone analysis, and mobile-optimization preview based on millions of outbound conversions.">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Email Composer (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="card p-6">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-400 mb-3">Draft Outbound Email</h3>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-ink-300">Subject Line</label>
                <input value={subject} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)} placeholder="e.g. Quick question" className="w-full mt-1 p-2 text-sm rounded-lg border border-black/10 bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>

              <div>
                <label className="text-xs font-medium text-ink-300">Email Body</label>
                <textarea
                  rows={9}
                  value={body}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBody(e.target.value)}
                  placeholder="Draft your cold outreach here..."
                  className="w-full mt-1 p-3 text-sm rounded-lg border border-black/10 bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500 font-sans"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-ink-400">
                  {body.trim().split(/\s+/).filter(Boolean).length} words · ~{Math.round((body.trim().split(/\s+/).filter(Boolean).length / 200) * 60)}s reading time
                </span>
                <button onClick={analyzeEmail} disabled={analyzing} className="btn-primary text-xs">
                  {analyzing ? "Evaluating Draft..." : "Grade & Optimize Draft"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Real-time Scoring & Mobile Preview (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          {feedback ? (
            <>
              {/* Score Header */}
              <div className="card p-5 border-l-4 border-brand-500">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Reply Probability Score</span>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className="text-3xl font-extrabold text-ink-50">{feedback.score}</span>
                      <span className="text-xs text-ink-400">/ 100</span>
                      <span className={`badge ml-2 font-bold ${feedback.score >= 90 ? "bg-emerald-100 text-emerald-800" : feedback.score >= 75 ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800"}`}>
                        Grade {feedback.grade}
                      </span>
                    </div>
                  </div>
                  <div className="text-right text-xs text-ink-400">
                    <div>{feedback.wordCount} words</div>
                    <div className="text-emerald-600 font-medium">{feedback.readingTimeSec}s read</div>
                  </div>
                </div>
              </div>

              {/* Actionable Feedback */}
              <div className="card p-5">
                <h4 className="text-xs uppercase tracking-wider text-ink-400 font-semibold mb-3">AI Coaching Suggestions</h4>
                <div className="space-y-2">
                  {feedback.suggestions.map((sug, i) => (
                    <div key={i} className={`p-2.5 rounded-lg text-xs flex items-start gap-2.5 ${sug.type === "critical" ? "bg-rose-50 text-rose-900 border border-rose-200" : sug.type === "warning" ? "bg-amber-50 text-amber-900 border border-amber-200" : "bg-emerald-50 text-emerald-900 border border-emerald-200"}`}>
                      <span className="font-bold">{sug.type === "critical" ? "✕" : sug.type === "warning" ? "!" : "✓"}</span>
                      <span>{sug.message}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Mobile Phone Simulation */}
              <div className="card p-5 bg-black/[0.02]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Smartphone Preview</span>
                  <span className="badge bg-black/5 text-[10px] text-ink-400">Lock Screen Notification</span>
                </div>
                <div className="rounded-xl border border-black/10 bg-surface p-3 shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="h-2 w-2 rounded-full bg-brand-600" />
                    <span className="text-xs font-bold text-ink-50">Mail</span>
                    <span className="text-[10px] text-ink-400">now</span>
                  </div>
                  <div className="text-xs font-semibold text-ink-50 truncate">{feedback.mobilePreview.subjectTruncated}</div>
                  <div className="text-[11px] text-ink-300 line-clamp-2 mt-0.5">{feedback.mobilePreview.firstLinePreview}</div>
                </div>
              </div>
            </>
          ) : (
            <div className="card p-8 text-center text-ink-400">
              <div className="text-2xl mb-2">✍️</div>
              <div className="text-sm font-semibold text-ink-50">No evaluation yet</div>
              <p className="text-xs mt-1">Type or paste your outbound message and click "Grade & Optimize Draft" to receive live deliverability and conversion tips.</p>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
