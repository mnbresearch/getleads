import React, { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";

export interface CommandItem {
  id: string;
  category: "Actions" | "Navigation";
  title: string;
  subtitle: string;
  icon: string;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const commands: CommandItem[] = [
    // Core AI Moat Actions
    {
      id: "action-waterfall",
      category: "Actions",
      title: "Run Waterfall Cascade Enrichment",
      subtitle: "The verification chain this workspace runs, and a live email-finder test",
      icon: "💧",
      run: () => {
        navigate("/waterfall");
        onClose();
      },
    },
    {
      id: "action-dialer",
      category: "Actions",
      title: "Open the call queue",
      subtitle: "Call queue with talk tracks; calls are placed from your phone",
      icon: "📞",
      shortcut: "D",
      run: () => {
        navigate("/dialer");
        onClose();
      },
    },
    {
      id: "action-workers",
      category: "Actions",
      title: "Run an AI SDR on Autopilot",
      subtitle: "Finds, scores and enrolls new leads every night from a saved search",
      icon: "🤖",
      run: () => {
        navigate("/autopilot");
        onClose();
      },
    },
    {
      id: "action-coach",
      category: "Actions",
      title: "Grade & Optimize Outbound Email",
      subtitle: "AI email tone, spam risk, and mobile preview scoring",
      icon: "✉",
      run: () => {
        navigate("/email-coach");
        onClose();
      },
    },
    {
      id: "action-surges",
      category: "Actions",
      title: "Open the signals feed",
      subtitle: "Hiring, funding and news signals for the accounts you track",
      icon: "⚡",
      run: () => {
        navigate("/signals");
        onClose();
      },
    },
    {
      id: "action-rooms",
      category: "Actions",
      title: "Create Digital Sales Room & Mutual Action Plan",
      subtitle: "Branded collaborative deal hub for target buying champions",
      icon: "🤝",
      run: () => {
        navigate("/rooms");
        onClose();
      },
    },
    {
      id: "action-gtm",
      category: "Actions",
      title: "Plan intent plays",
      subtitle: "Competitor customers, hiring, funding and job changes, with the proof",
      icon: "🎯",
      run: () => {
        navigate("/plays");
        onClose();
      },
    },

    // Navigation Items
    {
      id: "nav-command-center",
      category: "Navigation",
      title: "Home",
      subtitle: "What needs you today, and your numbers",
      icon: "▦",
      shortcut: "H",
      run: () => {
        navigate("/");
        onClose();
      },
    },
    {
      id: "nav-pipeline",
      category: "Navigation",
      title: "Deals & CRM Pipeline",
      subtitle: "Active pipeline board and deal health radar",
      icon: "📊",
      run: () => {
        navigate("/pipeline");
        onClose();
      },
    },
    {
      id: "nav-leads",
      category: "Navigation",
      title: "Search & Discover Leads",
      subtitle: "Describe who you want; get people and companies with verified emails",
      icon: "⌕",
      run: () => {
        navigate("/search");
        onClose();
      },
    },
    {
      id: "nav-campaigns",
      category: "Navigation",
      title: "Outbound Campaigns",
      subtitle: "Email cadences, sequences and reply tracking",
      icon: "📨",
      run: () => {
        navigate("/campaigns");
        onClose();
      },
    },
    {
      id: "nav-salesfloor",
      category: "Navigation",
      title: "Virtual Salesfloor",
      subtitle: "Live team presence, call blitzes and leaderboard",
      icon: "👥",
      run: () => {
        navigate("/salesfloor");
        onClose();
      },
    },
    {
      id: "nav-autopilot",
      category: "Navigation",
      title: "Autopilot & Workflows",
      subtitle: "Event-driven autonomous triggers and actions",
      icon: "∞",
      run: () => {
        navigate("/autopilot");
        onClose();
      },
    },
    {
      id: "nav-settings",
      category: "Navigation",
      title: "Workspace Settings",
      subtitle: "API keys, team seats, integrations, and preferences",
      icon: "⚙",
      run: () => {
        navigate("/settings");
        onClose();
      },
    },

  ];

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.title.toLowerCase().includes(query.toLowerCase()) ||
          c.subtitle.toLowerCase().includes(query.toLowerCase()) ||
          c.category.toLowerCase().includes(query.toLowerCase())
      )
    : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1 < filtered.length ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].run();
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 bg-black/60 backdrop-blur-sm animate-rise">
      <div className="fixed inset-0" onClick={onClose} />
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-surface dark:bg-slate-900 shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 border-b border-black/10 dark:border-white/10 px-4 py-3.5 bg-black/[0.02] dark:bg-white/[0.02]">
          <span className="text-lg text-ink-400">⌕</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages and actions (esc to close)…"
            className="flex-1 bg-transparent text-sm text-ink-50 dark:text-white placeholder:text-ink-400 dark:placeholder:text-slate-400 focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-xs text-ink-400 hover:text-ink-50 dark:hover:text-white"
            >
              Clear
            </button>
          )}
          <span className="rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-ink-400 dark:text-slate-300">
            ESC
          </span>
        </div>

        <div className="flex items-center justify-end px-4 py-2 text-[11px] border-b border-black/5 dark:border-white/5 text-ink-400 dark:text-slate-400">
          Use ↑↓ to move, ↵ to open
        </div>

        {/* Results List */}
        <div className="max-h-96 overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-ink-400 dark:text-slate-400">
              No matching actions or commands found for &ldquo;{query}&rdquo;
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  onClick={() => item.run()}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-xs transition cursor-pointer ${
                    isSelected
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-ink-100 dark:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-base flex-shrink-0">{item.icon}</span>
                    <div className="truncate">
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold ${isSelected ? "text-white" : "text-ink-50 dark:text-white"}`}>
                          {item.title}
                        </span>
                        <span
                          className={`badge text-[9px] uppercase px-1.5 py-0.2 ${
                            isSelected
                              ? "bg-white/20 text-white"
                              : "bg-black/5 dark:bg-white/10 text-ink-400 dark:text-slate-400"
                          }`}
                        >
                          {item.category}
                        </span>
                      </div>
                      <div
                        className={`text-[11px] truncate mt-0.5 ${
                          isSelected ? "text-white/80" : "text-ink-400 dark:text-slate-400"
                        }`}
                      >
                        {item.subtitle}
                      </div>
                    </div>
                  </div>

                  {item.shortcut && (
                    <span
                      className={`text-[10px] font-mono rounded px-1.5 py-0.5 ml-2 flex-shrink-0 ${
                        isSelected ? "bg-white/20 text-white" : "bg-black/5 dark:bg-white/10 text-ink-400 dark:text-slate-400"
                      }`}
                    >
                      {item.shortcut}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts */}
        <div className="flex items-center justify-between border-t border-black/10 dark:border-white/10 px-4 py-2 text-[10px] text-ink-400 dark:text-slate-400 bg-black/[0.02] dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="rounded bg-black/5 dark:bg-white/10 px-1 py-0.5 font-mono">↵</kbd> Select
            </span>
            <span>
              <kbd className="rounded bg-black/5 dark:bg-white/10 px-1 py-0.5 font-mono">↑↓</kbd> Navigate
            </span>
            <span>
              <kbd className="rounded bg-black/5 dark:bg-white/10 px-1 py-0.5 font-mono">esc</kbd> Dismiss
            </span>
          </div>
          <span>Scout SuperApp Intelligence Omnibar</span>
        </div>
      </div>
    </div>
  );
}
