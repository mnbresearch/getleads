import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export type OnboardingObjective =
  | "decision_makers"
  | "niche_companies"
  | "intent_buyers"
  | "agency"
  | "sales_execution";

interface ObjectiveDetail {
  id: OnboardingObjective;
  title: string;
  badge: string;
  summary: string;
  solutionSteps: Array<{
    step: string;
    title: string;
    description: string;
  }>;
  proTip: string;
  suggestedPrompt: string;
  sampleCriteria: {
    titles: string[];
    industries: string[];
    keywords: string[];
    locations: string[];
  };
}

const OBJECTIVES: Record<OnboardingObjective, ObjectiveDetail> = {
  decision_makers: {
    id: "decision_makers",
    title: "Find B2B Decision-Makers & Founders",
    badge: "People Discovery",
    summary:
      "Target senior executives, founders, C-suite leaders, and department heads who have budget and signing authority.",
    solutionSteps: [
      {
        step: "01",
        title: "Natural Language Role Matching",
        description:
          "Describe your target titles (e.g., 'VP Sales at Series A fintech') or select specific seniority tiers. Scout parses exact LinkedIn designations.",
      },
      {
        step: "02",
        title: "Live Company & Account Context",
        description:
          "Scout crawls each company's live website to extract real-time headcount, tech stack, and verified business activities.",
      },
      {
        step: "03",
        title: "Waterfall Deliverability Verification",
        description:
          "Every work email goes through deep SMTP handshake checks and multi-provider verification, ensuring zero domain bounce penalties.",
      },
      {
        step: "04",
        title: "Actionable Dossier & Outreach",
        description:
          "Export verified contacts to CSV, push directly to HubSpot or Pipedrive, or draft AI-researched emails.",
      },
    ],
    proTip:
      "Use our ICP scoring feature to benchmark discovered leads against your existing best customer profile.",
    suggestedPrompt: "Founders and CEOs of B2B SaaS companies with 20-200 employees in the US",
    sampleCriteria: {
      titles: ["Founder", "Co-Founder", "Chief Executive Officer", "Managing Director"],
      industries: ["Software", "Internet", "Information Technology"],
      keywords: ["B2B SaaS", "cloud platform", "enterprise software"],
      locations: ["United States"],
    },
  },
  niche_companies: {
    id: "niche_companies",
    title: "Discover Companies in a Specific Niche or Industry",
    badge: "Company Discovery",
    summary:
      "Find specialized manufacturers, brands, suppliers, or regional businesses matching custom product categories and requirements.",
    solutionSteps: [
      {
        step: "01",
        title: "Niche Semantic Decomposition",
        description:
          "Enter your niche (e.g., 'rice meals', 'commercial solar', 'ayurvedic skincare'). Scout automatically extracts relevant product keywords and industrial categories.",
      },
      {
        step: "02",
        title: "Real-Time Registry & Web Discovery",
        description:
          "Scout queries business registries, trade directories, and live web sources, discovering operating companies without relying on outdated dumps.",
      },
      {
        step: "03",
        title: "Key Decision-Maker Identification",
        description:
          "For every matching company, Scout automatically discovers the key leadership roles: Founders, Owners, Managing Directors, and Heads of Sourcing.",
      },
      {
        step: "04",
        title: "Continuous Autopilot Monitoring",
        description:
          "Save your niche search to Autopilot so Scout continuously monitors the web and alerts you whenever new matching businesses emerge.",
      },
    ],
    proTip:
      "For product queries like 'rice meals', specify the target country or region to discover domestic manufacturers and export houses.",
    suggestedPrompt: "Rice meal manufacturers and ready-to-eat food brands in India",
    sampleCriteria: {
      titles: ["Founder", "Managing Director", "Owner", "Head of Sourcing", "Director of Operations"],
      industries: ["Food & Beverage", "FMCG", "Packaged Foods", "Food Processing"],
      keywords: ["rice meals", "ready to eat", "food processing", "packaged food", "FMCG"],
      locations: ["India"],
    },
  },
  intent_buyers: {
    id: "intent_buyers",
    title: "Find Potential Customers & High-Intent Buyers",
    badge: "Intent Signals & Plays",
    summary:
      "Identify organizations actively entering buying windows based on hiring sprees, funding rounds, competitor customer references, or website visitor signals.",
    solutionSteps: [
      {
        step: "01",
        title: "Intent Signal Triggers (Plays)",
        description:
          "Activate automated Plays that track published case studies of competitors, fresh funding events, and specific open job requisitions.",
      },
      {
        step: "02",
        title: "Evidence-Backed Relevance",
        description:
          "Every candidate arrives in your review queue with a verified reason sentence and a link to the exact public page demonstrating active need.",
      },
      {
        step: "03",
        title: "Visitor Deanonymization",
        description:
          "Reveal anonymous B2B website visitors and identify which buying committee stakeholders are actively researching your product.",
      },
      {
        step: "04",
        title: "Fast-Track Approval Queue",
        description:
          "Approve high-intent prospects with a single keystroke (press A to approve) and automatically initiate contextual outreach.",
      },
    ],
    proTip:
      "Check the Plays tab in your navigation bar to review fresh intent candidates discovered across the open web.",
    suggestedPrompt: "Companies hiring Heads of Sales or RevOps who recently raised Series A funding",
    sampleCriteria: {
      titles: ["Chief Executive Officer", "Founder", "VP Sales", "Head of People"],
      industries: ["Software", "Fintech", "Healthtech"],
      keywords: ["Series A", "hiring sales", "expansion"],
      locations: ["United States", "United Kingdom"],
    },
  },
  agency: {
    id: "agency",
    title: "Agency Multi-Client Lead Generation",
    badge: "Agency Workspace",
    summary:
      "Run lead sourcing for multiple clients from a unified console with separate client profiles, pacing targets, and shareable client reporting links.",
    solutionSteps: [
      {
        step: "01",
        title: "Partitioned Client Workspaces",
        description:
          "Create distinct client profiles with independent ICP criteria, custom search presets, and isolated lead pools inside one team account.",
      },
      {
        step: "02",
        title: "Monthly Targets & Pace Tracking",
        description:
          "Set lead delivery quotas per client. Scout tracks delivery velocity in real time so your account managers always stay ahead of targets.",
      },
      {
        step: "03",
        title: "Bulk Lead Routing & Assignment",
        description:
          "Route discovered leads straight to client queues or reassign them in bulk with full deduplication across client lists.",
      },
      {
        step: "04",
        title: "White-Labeled Shareable Reports",
        description:
          "Generate tokenized, read-only report links your clients can open anytime to view verified deliverable counts and proof.",
      },
    ],
    proTip:
      "Share client reports with your clients without giving them access to your raw prospect databases or workspace settings.",
    suggestedPrompt: "Chief Marketing Officers at mid-market retail companies for client outreach",
    sampleCriteria: {
      titles: ["Chief Marketing Officer", "VP Marketing", "Head of Digital Growth"],
      industries: ["Retail", "Apparel & Fashion", "Consumer Goods"],
      keywords: ["digital marketing", "omnichannel", "e-commerce"],
      locations: ["United States", "Canada"],
    },
  },
  sales_execution: {
    id: "sales_execution",
    title: "Autonomous Sales Outreach & Sequences",
    badge: "Sales Execution",
    summary:
      "Transform discovered prospects into qualified pipeline with AI-coached outreach, buying committee multi-threading, and CRM synchronization.",
    solutionSteps: [
      {
        step: "01",
        title: "Research-Driven AI Email Drafting",
        description:
          "Scout reads what was actually discovered about the prospect's company to draft bespoke cold messages, never generic boilerplate.",
      },
      {
        step: "02",
        title: "Buying Committee Multi-Threading",
        description:
          "Map all 6-10 stakeholders (Economic Buyer, Technical Champion, SecOps, Legal) to eliminate single-threaded deal failure risks.",
      },
      {
        step: "03",
        title: "Integrated WebRTC Dialer & Battlecards",
        description:
          "Call hot prospects straight from your browser with real-time AI objection handling and live battlecard assistance.",
      },
      {
        step: "04",
        title: "CRM Synchronization",
        description:
          "Automatically sync verified leads, stage progression, and reply outcomes into HubSpot, Pipedrive, Zoho, or Google Sheets.",
      },
    ],
    proTip:
      "Review the Email Coach inside Scout to evaluate your message length, reading time, and mobile notification score.",
    suggestedPrompt: "VP Engineering and CTOs at cybersecurity companies for outbound sequencing",
    sampleCriteria: {
      titles: ["VP Engineering", "Chief Technology Officer", "Head of Security"],
      industries: ["Computer & Network Security", "Information Technology"],
      keywords: ["cybersecurity", "cloud security", "DevSecOps"],
      locations: ["United States", "European Union"],
    },
  },
};

export const ONBOARDING_STORAGE_KEY = "mnb_scout_onboarding_completed_v2";

export function openOnboardingTour() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("mnb_scout_open_onboarding"));
  }
}

export function OnboardingModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedObjective, setSelectedObjective] = useState<OnboardingObjective>("decision_makers");
  const [customSearchQuery, setCustomSearchQuery] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    // Open if not completed yet
    const completed = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!completed) {
      setIsOpen(true);
    }

    const handleOpen = () => {
      setIsOpen(true);
      setStep(1);
    };

    window.addEventListener("mnb_scout_open_onboarding", handleOpen);
    return () => window.removeEventListener("mnb_scout_open_onboarding", handleOpen);
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    setIsOpen(false);
  };

  const handleProceedToStep2 = (obj: OnboardingObjective) => {
    setSelectedObjective(obj);
    setCustomSearchQuery(OBJECTIVES[obj].suggestedPrompt);
    setStep(2);
  };

  const handleLaunchSearch = () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    setIsOpen(false);
    const detail = OBJECTIVES[selectedObjective];
    const params = new URLSearchParams();
    params.set("query", customSearchQuery.trim() || detail.suggestedPrompt);
    if (detail.sampleCriteria.titles.length) {
      params.set("titles", detail.sampleCriteria.titles.join(","));
    }
    if (detail.sampleCriteria.industries.length) {
      params.set("industries", detail.sampleCriteria.industries.join(","));
    }
    if (detail.sampleCriteria.locations.length) {
      params.set("locations", detail.sampleCriteria.locations.join(","));
    }
    if (detail.sampleCriteria.keywords.length) {
      params.set("keywords", detail.sampleCriteria.keywords.join(","));
    }
    navigate(`/search?${params.toString()}`);
  };

  if (!isOpen) return null;

  const currentDetail = OBJECTIVES[selectedObjective];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs transition-opacity duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-black/10 bg-surface shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-black/5 bg-cream/70 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-xs font-bold text-brand-700 border border-brand-200">
              {step}/3
            </span>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-ink-400">
                MNB Scout Onboarding Tour
              </div>
              <h2 id="onboarding-title" className="text-base font-bold text-ink-50">
                {step === 1 && "What is your primary objective?"}
                {step === 2 && "How Scout solves your specific objective"}
                {step === 3 && "Configure and launch your first real search"}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss tour"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 hover:bg-black/5 hover:text-ink-50"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-ink-300">
                Welcome to MNB Scout. To give you the highest precision and configure your targeting parameters, select what you want to achieve:
              </p>
              <div className="grid gap-3 sm:grid-cols-1">
                {(Object.keys(OBJECTIVES) as OnboardingObjective[]).map((key) => {
                  const item = OBJECTIVES[key];
                  const isSelected = selectedObjective === key;
                  return (
                    <div
                      key={key}
                      onClick={() => setSelectedObjective(key)}
                      className={`cursor-pointer rounded-xl border p-4 transition-all ${
                        isSelected
                          ? "border-brand-500 bg-brand-50/30 ring-1 ring-brand-500 shadow-xs"
                          : "border-black/10 hover:border-black/20 hover:bg-black/[0.01]"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-ink-50">{item.title}</span>
                          <span className="rounded bg-black/[0.05] px-2 py-0.5 text-[10px] font-semibold text-ink-400 uppercase tracking-wide">
                            {item.badge}
                          </span>
                        </div>
                        <input
                          type="radio"
                          name="objective"
                          checked={isSelected}
                          onChange={() => setSelectedObjective(key)}
                          className="h-4 w-4 accent-brand-600"
                        />
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-300">{item.summary}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="rounded-xl border border-brand-200 bg-brand-50/30 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-brand-700">
                    Selected Objective
                  </div>
                  <span className="rounded bg-brand-100 px-2 py-0.5 text-[10px] font-bold text-brand-800">
                    {currentDetail.badge}
                  </span>
                </div>
                <h3 className="mt-1 text-base font-bold text-ink-50">{currentDetail.title}</h3>
                <p className="mt-1 text-xs text-ink-300">{currentDetail.summary}</p>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-ink-400 mb-3">
                  How Scout solves this step by step:
                </h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  {currentDetail.solutionSteps.map((s) => (
                    <div
                      key={s.step}
                      className="rounded-xl border border-black/10 bg-surface p-4 flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono text-xs font-bold text-brand-600">{s.step}</span>
                        </div>
                        <h5 className="text-sm font-semibold text-ink-50">{s.title}</h5>
                        <p className="mt-1 text-xs text-ink-300 leading-relaxed">{s.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-emerald-800 mb-1">
                  Pro-Tip for Maximum Results
                </div>
                <p className="text-xs text-emerald-900 leading-relaxed">{currentDetail.proTip}</p>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-base font-bold text-ink-50">
                  Ready to discover real prospects?
                </h3>
                <p className="mt-1 text-xs text-ink-300">
                  Type your prospecting requirement or edit the suggested search below. Scout will translate it into structured criteria and search live sources.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-400 mb-1.5 uppercase tracking-wide">
                  Describe what you are looking for
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customSearchQuery}
                    onChange={(e) => setCustomSearchQuery(e.target.value)}
                    placeholder="e.g. Rice meal manufacturers in India, or SaaS founders in US"
                    className="input flex-1 px-3.5 py-2.5 text-sm border-black/15 bg-white shadow-xs"
                  />
                </div>
              </div>

              {/* Extracted Criteria Preview */}
              <div className="rounded-xl border border-black/10 bg-cream/50 p-4">
                <div className="text-xs font-bold uppercase tracking-wider text-ink-400 mb-3">
                  How Scout targets this query:
                </div>
                <div className="grid gap-3 sm:grid-cols-2 text-xs">
                  <div>
                    <span className="font-semibold text-ink-400 block mb-1">Target Roles & Titles</span>
                    <div className="flex flex-wrap gap-1">
                      {currentDetail.sampleCriteria.titles.map((t) => (
                        <span key={t} className="rounded bg-black/[0.05] px-2 py-0.5 font-medium text-ink-200">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="font-semibold text-ink-400 block mb-1">Industries & Categories</span>
                    <div className="flex flex-wrap gap-1">
                      {currentDetail.sampleCriteria.industries.map((i) => (
                        <span key={i} className="rounded bg-brand-50 text-brand-700 px-2 py-0.5 font-medium">
                          {i}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="font-semibold text-ink-400 block mb-1">Keywords & Offerings</span>
                    <div className="flex flex-wrap gap-1">
                      {currentDetail.sampleCriteria.keywords.map((k) => (
                        <span key={k} className="rounded bg-black/[0.05] px-2 py-0.5 font-medium text-ink-200">
                          {k}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="font-semibold text-ink-400 block mb-1">Locations</span>
                    <div className="flex flex-wrap gap-1">
                      {currentDetail.sampleCriteria.locations.map((l) => (
                        <span key={l} className="rounded bg-black/[0.05] px-2 py-0.5 font-medium text-ink-200">
                          {l}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-black/5 text-[11px] text-ink-400">
                  Zero fake data: all results are pulled live from public registries, verified company websites, and MX handshakes.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-black/5 bg-cream/70 px-6 py-4">
          <div>
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s - 1) as 1 | 2)}
                className="btn-secondary text-xs px-3.5 py-2 font-medium"
              >
                Back
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDismiss}
                className="text-xs text-ink-400 hover:text-ink-100"
              >
                Skip tour
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {step === 1 && (
              <button
                type="button"
                onClick={() => handleProceedToStep2(selectedObjective)}
                className="btn-primary text-xs px-5 py-2 font-semibold"
              >
                Continue to Solution Breakdown →
              </button>
            )}
            {step === 2 && (
              <button
                type="button"
                onClick={() => setStep(3)}
                className="btn-primary text-xs px-5 py-2 font-semibold"
              >
                Set Up First Search →
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                onClick={handleLaunchSearch}
                className="btn-primary text-xs px-6 py-2.5 font-semibold shadow-xs"
              >
                Launch Real Search Now →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
