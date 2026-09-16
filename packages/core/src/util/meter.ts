/**
 * Lightweight usage-metering hook. packages/core has no DB dependency by design, so it can't
 * write usage counts itself - instead every external-API call site here calls meter(provider)
 * and apps/api wires setUsageMeter(...) at boot to a function that increments tool_usage in
 * Postgres (see packages/db/src/tools.ts) and emails an alert once a free-tier threshold is
 * crossed. Provider ids here must match the seed rows in packages/db/migrations/0004_tools.sql.
 * Never let a metering failure break the actual request: the hook is called fire-and-forget
 * and any error it throws is swallowed.
 */
type MeterHook = (provider: string) => void;

let hook: MeterHook = () => {};

export function setUsageMeter(fn: MeterHook) {
  hook = fn;
}

export function meter(provider: string) {
  try {
    hook(provider);
  } catch {
    // metering must never break the caller
  }
}
