import { useCallback, useEffect, useState } from "react";
import { apiFetch, fmtDate } from "../lib/api";
import { Empty, Page, Spinner, useToast } from "../components/ui";

interface Task { id: string; type: string; title: string; body: string | null; dueAt: string; status: string; campaignId: string | null; lead: { id: string; fullName: string | null; title: string | null; email: string | null; linkedinUrl: string | null; phone: string | null; whatsapp: string | null; company: { name: string | null; domain: string } | null } | null }

const ICON: Record<string, string> = { linkedin_connect: "in+", linkedin_message: "in✉", call: "☎", whatsapp: "wa", task: "☐" };

export function TasksPage() {
  const [rows, setRows] = useState<Task[]>([]);
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const { toast, Toast } = useToast();
  const load = useCallback(() => { apiFetch<{ tasks: Task[] }>("GET", `/v1/tools/tasks?status=${status}`).then((r) => setRows(r.tasks)).finally(() => setLoading(false)); }, [status]);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const done = async (t: Task, outcome: "done" | "skipped") => {
    try { await apiFetch("POST", `/v1/tools/tasks/${t.id}/complete`, { outcome }); toast(outcome === "done" ? "Done - sequence continues" : "Skipped"); load(); } catch (e) { toast((e as Error).message, "err"); }
  };
  return (
    <Page title="Tasks" subtitle="Human steps from your multichannel sequences: LinkedIn connects and messages, calls, WhatsApp. Complete a task and the sequence moves to the next step." actions={<select className="input w-36" value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="done">Done</option><option value="skipped">Skipped</option><option value="all">All</option></select>}>
      {Toast}
      {loading ? <Spinner /> : rows.length === 0 ? <Empty title="No tasks" hint="Add a LinkedIn, call or WhatsApp step to a campaign and tasks will appear here as contacts reach that step." /> : (
        <div className="space-y-3">
          {rows.map((t) => (
            <div key={t.id} className="card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-xs font-bold text-brand-600">{ICON[t.type] ?? "☐"}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.title}</div>
                  {t.lead && <div className="text-xs text-ink-400">{t.lead.title} · {t.lead.company?.name ?? t.lead.company?.domain} {t.lead.linkedinUrl && <a className="ml-2 text-brand-600" href={t.lead.linkedinUrl} target="_blank" rel="noreferrer">Open LinkedIn ↗</a>}{t.lead.phone && <span className="ml-2">{t.lead.phone}</span>}{t.type === "whatsapp" && (t.lead.whatsapp ?? t.lead.phone) && <a className="ml-2 text-emerald-600" href={`https://wa.me/${(t.lead.whatsapp ?? t.lead.phone ?? "").replace(/\D/g, "")}?text=${encodeURIComponent(t.body ?? "")}`} target="_blank" rel="noreferrer">Open WhatsApp ↗</a>}</div>}
                  {t.body && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-base p-3 font-sans text-sm text-ink-200">{t.body}</pre>}
                  <div className="mt-1 text-xs text-ink-500">Due {fmtDate(t.dueAt)}</div>
                </div>
                {t.status === "pending" && <div className="flex gap-2"><button className="btn-secondary" onClick={() => t.body && navigator.clipboard.writeText(t.body).then(() => toast("Copied"))}>Copy</button><button className="btn-secondary" onClick={() => done(t, "skipped")}>Skip</button><button className="btn-primary" onClick={() => done(t, "done")}>Mark done</button></div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
