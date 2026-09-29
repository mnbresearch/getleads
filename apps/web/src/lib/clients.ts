/** Shapes returned by /v1/clients. Kept in one place so every page reads them the same way. */

export interface ClientStats {
  leads: number;
  deliveredThisMonth: number;
  new7d: number;
  withEmail: number;
  verified: number;
  contacted: number;
  replied: number;
  qualified: number;
  customers: number;
  lastActivity: string | null;
}

export interface ClientAttention {
  noEmail: number;
  unverified: number;
  badEmail: number;
  readyButIdle: number;
}

export interface TargetProgress {
  target: number;
  delivered: number;
  share: number;
  expectedByNow: number;
  onTrack: boolean;
}

export interface ClientRow {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  status: "active" | "paused" | "archived";
  color: string | null;
  icpId: string | null;
  monthlyLeadTarget: number | null;
  notes: string | null;
  sharing: boolean;
  reportShowTarget: boolean;
  stats: ClientStats;
  attention: ClientAttention;
  target: TargetProgress | null;
}

export interface Overview {
  clients: ClientRow[];
  totals: {
    activeClients: number;
    assignedLeads: number;
    deliveredThisMonth: number;
    targetThisMonth: number;
    verified: number;
    replied: number;
    qualified: number;
    needsAttention: number;
    behindTarget: number;
  };
  pool: { leads: number; withEmail: number; verified: number; attention: ClientAttention };
}

export const CLIENT_COLORS = ["#c15f37", "#2f6f5e", "#3d5a99", "#8a4f9e", "#b8862b", "#4b7f99", "#9e4f5c", "#5c6b3a"];

export const attentionTotal = (a: ClientAttention) => a.noEmail + a.unverified + a.badEmail + a.readyButIdle;

/** What each bucket means, and what fixing it does. One source for every page. */
export const BUCKET_COPY: Record<keyof ClientAttention, { title: string; why: string; action: "enrich" | "verify" | "list"; actionLabel: string; leadsQuery: string }> = {
  noEmail: {
    title: "No email yet",
    why: "Found, but not reachable. Enrichment looks for their work address.",
    action: "enrich",
    actionLabel: "Find emails",
    leadsQuery: "hasEmail=false",
  },
  unverified: {
    title: "Never verified",
    why: "Sending to an unchecked address is how a domain gets burned.",
    action: "verify",
    actionLabel: "Verify now",
    leadsQuery: "emailStatus=unknown",
  },
  badEmail: {
    title: "Known-bad address",
    why: "The person may still be right. Enrichment looks for a working address instead.",
    action: "enrich",
    actionLabel: "Find a working address",
    leadsQuery: "emailStatus=invalid",
  },
  readyButIdle: {
    title: "Ready, but nobody's contacting them",
    why: "Verified, over a week old, in no campaign. Paid for and unused.",
    action: "list",
    actionLabel: "Gather into a list",
    leadsQuery: "status=new&emailStatus=valid,catch_all",
  },
};
