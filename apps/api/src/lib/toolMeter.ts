import { recordProviderHealth, recordToolUsage } from "@prospex/db";
import { isActionable, setProviderHealthHook, setUsageMeter, type ProviderCall } from "@prospex/core";
import { env } from "../env.js";
import { sendMail } from "./mailer.js";

let wired = false;

/**
 * One alert per provider per outcome per hour.
 *
 * A rejected key fails on every single call, so without this a broken Apollo key during a
 * bulk search would send hundreds of identical emails and the real signal would be lost in
 * the flood. In-memory by design: a restart re-alerting once is the correct behaviour.
 */
const ALERT_WINDOW_MS = 60 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

function shouldAlert(provider: string, outcome: string): boolean {
  const key = `${provider}:${outcome}`;
  const now = Date.now();
  const prev = lastAlertAt.get(key);
  if (prev && now - prev < ALERT_WINDOW_MS) return false;
  lastAlertAt.set(key, now);
  return true;
}

/**
 * Wires packages/core's fire-and-forget meter(provider) hook to actually record usage in
 * Postgres, and emails the admin once a tool crosses its configured alert threshold for the
 * current period. Call once at process boot (api server + worker, so both count calls).
 */
export function wireToolMeter() {
  if (wired) return;
  wired = true;

  // Provider health: what the provider actually said, as opposed to whether a key is set.
  // Deliberately separate from usage metering - a call that was rejected still consumed a
  // request, so both hooks fire for the same call and neither replaces the other.
  setProviderHealthHook((call: ProviderCall) => {
    recordProviderHealth(call)
      .then(() => {
        // Only an actionable outcome is worth an email. A 5xx or a timeout is usually the
        // provider having a minute, and alerting on those trains people to ignore alerts.
        if (!isActionable(call.outcome) || !env.leadNotifyEmail) return;
        if (!shouldAlert(call.provider, call.outcome)) return;
        sendMail(null, {
          from: env.mailFrom,
          to: env.leadNotifyEmail,
          subject: `Scout admin alert: ${call.provider} returned ${call.outcome}`,
          text: `${call.provider} last responded with "${call.outcome}"${call.status ? ` (HTTP ${call.status})` : ""}.\n\n${call.detail ?? ""}\n\nA rejected key needs replacing. A "forbidden" result usually means the key is fine and the plan does not include that endpoint, in which case a new key will not help.\n\n${env.appUrl}/admin`,
        }).catch(() => {});
      })
      .catch(() => {
        // health reporting is best-effort; never let it affect the request that triggered it
      });
  });
  setUsageMeter((provider) => {
    recordToolUsage(provider)
      .then((r) => {
        if (r?.thresholdCrossed && env.leadNotifyEmail) {
          const pct = r.limit ? Math.round((r.count / r.limit) * 100) : null;
          sendMail(null, {
            from: env.mailFrom,
            to: env.leadNotifyEmail,
            subject: `Scout admin alert: ${r.label} is at ${pct ?? "?"}% of its usage limit`,
            text: `${r.label} has been called ${r.count} time(s) this period${r.limit ? ` out of a limit of ${r.limit}` : ""}.\n\nCheck the Tools & limits tab in the admin dashboard to raise the limit, add a paid key, or otherwise upgrade this tool before it runs out.\n\n${env.appUrl}/admin`,
          }).catch(() => {});
        }
      })
      .catch(() => {
        // metering is best-effort; never let it affect the request that triggered it
      });
  });
}
