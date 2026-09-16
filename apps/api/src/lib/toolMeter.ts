import { recordToolUsage } from "@prospex/db";
import { setUsageMeter } from "@prospex/core";
import { env } from "../env.js";
import { sendMail } from "./mailer.js";

let wired = false;

/**
 * Wires packages/core's fire-and-forget meter(provider) hook to actually record usage in
 * Postgres, and emails the admin once a tool crosses its configured alert threshold for the
 * current period. Call once at process boot (api server + worker, so both count calls).
 */
export function wireToolMeter() {
  if (wired) return;
  wired = true;
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
