import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Logo, BRAND_NAME } from "../components/Logo";
import { apiFetch, auth } from "../lib/api";

type Plan = { id: string; name: string; priceUsd: number };

export function UpgradeRequestPage() {
  const [params] = useSearchParams();
  const planId = params.get("plan") ?? "growth";
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [form, setForm] = useState({ name: "", email: "", mobile: "", country: "", message: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [plansErr, setPlansErr] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);

  const loadPlans = () => {
    setPlansErr(null);
    apiFetch<{ plans: Plan[] }>("GET", "/v1/billing/plans")
      .then((r) => setPlans(r.plans))
      // Said, not swallowed: the heading fell back to a generic "Upgrade your plan" with
      // nothing to tell the visitor which plan they were asking for, or that it failed.
      .catch((e) => { setPlans([]); setPlansErr((e as Error).message); });
  };
  useEffect(() => { loadPlans(); }, []);

  // A signed-in customer should not have to retype who they are. Only fills empty fields,
  // so anything already typed wins.
  useEffect(() => {
    if (!auth.token) return;
    apiFetch<{ user: { name?: string; email?: string } | null; org: { name?: string } | null }>("GET", "/v1/auth/me")
      .then((r) => {
        setForm((f) => ({ ...f, name: f.name || r.user?.name || "", email: f.email || r.user?.email || "" }));
        if (r.org?.name) setWorkspace(r.org.name);
      })
      .catch(() => {});
  }, []);

  const plan = plans?.find((p) => p.id === planId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch("POST", "/v1/upgrade-requests", { ...form, planId });
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto mt-16 max-w-md p-6">
        <div className="mb-2 flex items-center justify-center">
          <Logo size={34} textClassName="text-2xl" />
        </div>
        <div className="card p-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-2xl text-brand-600">✓</div>
          <h1 className="mt-4 text-lg font-semibold text-ink-50">Got it — we're on it</h1>
          <p className="mt-2 text-sm text-ink-400">
            Someone from the {BRAND_NAME} team will reach out to {form.email || "you"} shortly to complete your upgrade to{" "}
            {plan ? `${plan.name} ($${plan.priceUsd}/mo)` : "your selected plan"} and take payment.
          </p>
          <Link to="/" className="btn-secondary mt-5 justify-center">Back to {BRAND_NAME}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md p-6">
      <div className="mb-2 flex items-center justify-center">
        <Logo size={34} textClassName="text-2xl" />
      </div>
      <p className="mb-6 text-center text-sm text-ink-400">Request your upgrade</p>
      <form onSubmit={submit} className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold text-ink-50">
          {plan ? `Upgrade to ${plan.name}` : "Upgrade your plan"}
          {plan && <span className="ml-2 text-sm font-normal text-ink-400">${plan.priceUsd}/mo</span>}
        </h1>
        {plansErr && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800" role="status">
            Plan details could not be loaded ({plansErr}). You can still send this request for the "{planId}" plan. <button type="button" className="underline" onClick={loadPlans}>Try again</button>
          </div>
        )}
        {workspace && <p className="text-xs text-ink-400">For workspace <span className="font-medium text-ink-200">{workspace}</span>.</p>}
        <p className="text-sm text-ink-400">
          Leave your details and we'll reach out to set up billing and switch your plan on our side — no card needed here.
        </p>
        <div><label className="label">Full name</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label className="label">Email</label><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label className="label">Mobile number</label><input className="input" type="tel" required value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></div>
        <div><label className="label">Country</label><input className="input" required value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></div>
        <div><label className="label">Anything else? (optional)</label><textarea className="input" rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></div>
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "…" : "Yes, I'm interested — upgrade me"}</button>
        <div className="text-center text-sm text-ink-400">
          <Link className="text-brand-600" to="/">Back to {BRAND_NAME}</Link>
        </div>
      </form>
    </div>
  );
}
