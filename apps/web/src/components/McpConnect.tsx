import { useState } from "react";
import { API_URL } from "../lib/api";

/**
 * How to point an AI assistant at Scout's hosted MCP endpoint (POST /mcp on the API).
 *
 * The key is never filled in here: the snippets carry a placeholder, and the person pastes
 * the key they were shown once when they created it. A page that printed a live key into a
 * copyable block would put it on every screenshot of this screen.
 */
const CLIENTS = ["Claude Code", "Cursor / Claude Desktop", "Any HTTP client"] as const;
type Client = (typeof CLIENTS)[number];

export function mcpSnippets(apiUrl: string): Record<Client, string> {
  const url = `${apiUrl}/mcp`;
  return {
    "Claude Code": `claude mcp add --transport http scout ${url} \\\n  --header "Authorization: Bearer px_live_YOUR_KEY"`,
    "Cursor / Claude Desktop": JSON.stringify({ mcpServers: { scout: { url, headers: { Authorization: "Bearer px_live_YOUR_KEY" } } } }, null, 2),
    "Any HTTP client": `curl ${url} \\\n  -H "Authorization: Bearer px_live_YOUR_KEY" \\\n  -H "content-type: application/json" \\\n  -H "accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  };
}

export function McpConnect({ compact = false }: { compact?: boolean }) {
  const [client, setClient] = useState<Client>("Claude Code");
  const [copied, setCopied] = useState(false);
  const snippet = mcpSnippets(API_URL)[client];
  const copy = () =>
    navigator.clipboard?.writeText(snippet).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  return (
    <div data-testid="mcp-connect" className="min-w-0">
      {!compact && (
        <p className="text-ink-300">
          Scout's tools - prospect, find and verify emails, enrich companies, build sequences, read signals and website visitors - are served to AI assistants at{" "}
          <code className="[overflow-wrap:anywhere]">{API_URL}/mcp</code>. Nothing to install: add it with an API key. A read-only key can search and read; every write needs a full-access key.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Assistant">
        {CLIENTS.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={client === c}
            onClick={() => setClient(c)}
            className={`rounded-full border px-3 py-1 text-xs ${client === c ? "border-brand-600 bg-brand-600 text-white" : "border-black/10 text-ink-300 hover:border-black/20"}`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="relative mt-2">
        <pre className="max-w-full overflow-x-auto rounded-lg bg-black p-3 pr-16 text-[11px] leading-relaxed text-emerald-200">{snippet}</pre>
        <button type="button" onClick={copy} className="absolute right-2 top-2 rounded-md bg-white/10 px-2 py-1 text-[11px] text-white hover:bg-white/20">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-400">Replace px_live_YOUR_KEY with a key from Settings &rarr; API keys. Tool calls count against the same plan limits as the app.</p>
    </div>
  );
}
