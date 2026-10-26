import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./index.css";
import { rememberReturnPath, useAuthToken } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Shell } from "./components/Shell";
import { AuthPage } from "./pages/Auth";
import { LandingPage } from "./pages/Landing";
import { PrivacyPage, TermsPage } from "./pages/Legal";
import { NotFoundPage } from "./pages/NotFound";

// Code-split internal app pages and admin dashboards so the public landing page stays lean and fast
const Dashboard = React.lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const LeadsPage = React.lazy(() => import("./pages/Leads").then((m) => ({ default: m.LeadsPage })));
const PlaysPage = React.lazy(() => import("./pages/Plays").then((m) => ({ default: m.PlaysPage })));
const SearchPage = React.lazy(() => import("./pages/Search").then((m) => ({ default: m.SearchPage })));
const IcpPage = React.lazy(() => import("./pages/Icps").then((m) => ({ default: m.IcpPage })));
const CampaignsPage = React.lazy(() => import("./pages/Campaigns").then((m) => ({ default: m.CampaignsPage })));
const CampaignDetail = React.lazy(() => import("./pages/Campaigns").then((m) => ({ default: m.CampaignDetail })));
const SettingsPage = React.lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const AgentPage = React.lazy(() => import("./pages/Agent").then((m) => ({ default: m.AgentPage })));
const VisitorsPage = React.lazy(() => import("./pages/Visitors").then((m) => ({ default: m.VisitorsPage })));
const SignalsPage = React.lazy(() => import("./pages/Signals").then((m) => ({ default: m.SignalsPage })));
const VisibilityPage = React.lazy(() => import("./pages/Visibility").then((m) => ({ default: m.VisibilityPage })));
const TasksPage = React.lazy(() => import("./pages/Tasks").then((m) => ({ default: m.TasksPage })));
const AutopilotPage = React.lazy(() => import("./pages/Autopilot").then((m) => ({ default: m.AutopilotPage })));
const ToolsPage = React.lazy(() => import("./pages/Tools").then((m) => ({ default: m.ToolsPage })));
const AnalyticsPage = React.lazy(() => import("./pages/Analytics").then((m) => ({ default: m.AnalyticsPage })));
const AutomationPage = React.lazy(() => import("./pages/Automation").then((m) => ({ default: m.AutomationPage })));
const JoinPage = React.lazy(() => import("./pages/Join").then((m) => ({ default: m.JoinPage })));
const UpgradeRequestPage = React.lazy(() => import("./pages/UpgradeRequest").then((m) => ({ default: m.UpgradeRequestPage })));
const AdminLoginPage = React.lazy(() => import("./pages/AdminLogin").then((m) => ({ default: m.AdminLoginPage })));
const GoogleCallbackPage = React.lazy(() => import("./pages/GoogleCallback").then((m) => ({ default: m.GoogleCallbackPage })));
const AdminDashboardPage = React.lazy(() => import("./pages/AdminDashboard").then((m) => ({ default: m.AdminDashboardPage })));
const ClientsPage = React.lazy(() => import("./pages/Clients").then((m) => ({ default: m.ClientsPage })));
const ClientDetailPage = React.lazy(() => import("./pages/ClientDetail").then((m) => ({ default: m.ClientDetailPage })));
const ClientReportPage = React.lazy(() => import("./pages/ClientReport").then((m) => ({ default: m.ClientReportPage })));
const ForgotPasswordPage = React.lazy(() => import("./pages/ForgotPassword").then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = React.lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPasswordPage })));
const VerifyEmailPage = React.lazy(() => import("./pages/VerifyEmail").then((m) => ({ default: m.VerifyEmailPage })));

function PageLoader() {
  return (
    <div className="flex min-h-[320px] items-center justify-center p-8">
      <div className="flex items-center gap-2.5 text-sm text-ink-400">
        <svg className="h-4 w-4 animate-spin text-brand-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        <span>Loading view…</span>
      </div>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuthToken();
  const loc = useLocation();
  // A signed-out deep link (an emailed /leads?... link, a bookmark) comes back here after
  // sign-in instead of landing on the overview.
  if (!token) rememberReturnPath(loc.pathname + loc.search);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

/**
 * The first path segment of every page that lives behind sign-in.
 *
 * Used to tell "a real page you need an account for" (redirect to sign-in, then come back)
 * apart from "an address that does not exist" (say so). Before this, every unknown path
 * was treated as the first kind, so a typo sent a signed-out visitor to a password prompt.
 * Add the segment here when a new signed-in page is added below.
 */
const APP_SECTIONS = [
  "plays", "clients", "leads", "search", "icps", "campaigns", "agent", "visitors", "signals",
  "visibility", "tasks", "autopilot", "tools", "analytics", "automation", "settings",
];

function isAppPath(pathname: string): boolean {
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  return APP_SECTIONS.includes(first);
}

/** Unknown path: a 404 page, inside the app shell when signed in. */
function NotFoundRoute() {
  const token = useAuthToken();
  return token ? <Shell><NotFoundPage inApp /></Shell> : <NotFoundPage />;
}

function Root() {
  const token = useAuthToken();
  const loc = useLocation();
  return (
    <ErrorBoundary resetKey={loc.pathname}>
      <React.Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/join" element={<JoinPage />} />
          <Route path="/upgrade" element={<UpgradeRequestPage />} />
          <Route path="/auth/google" element={<GoogleCallbackPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* Public: opened from the confirmation email, usually in a browser that is not signed in. */}
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route path="/admin" element={<AdminDashboardPage />} />
          {/* Public: an agency's client opens this from a shared link, with no account. */}
          <Route path="/r/:token" element={<ClientReportPage />} />
          <Route path="/" element={token ? <Protected><Shell><Dashboard /></Shell></Protected> : <LandingPage />} />
          <Route
            path="/*"
            element={
              !isAppPath(loc.pathname) ? <NotFoundRoute /> :
              <Protected>
                <Shell>
                  <Routes>
                    <Route path="/plays" element={<PlaysPage />} />
                    <Route path="/clients" element={<ClientsPage />} />
                    <Route path="/clients/:id" element={<ClientDetailPage />} />
                    <Route path="/leads" element={<LeadsPage />} />
                    <Route path="/search" element={<SearchPage />} />
                    <Route path="/icps" element={<IcpPage />} />
                    <Route path="/campaigns" element={<CampaignsPage />} />
                    <Route path="/campaigns/:id" element={<CampaignDetail />} />
                    <Route path="/agent" element={<AgentPage />} />
                    <Route path="/visitors" element={<VisitorsPage />} />
                    <Route path="/signals" element={<SignalsPage />} />
                    <Route path="/visibility" element={<VisibilityPage />} />
                    <Route path="/tasks" element={<TasksPage />} />
                    <Route path="/autopilot" element={<AutopilotPage />} />
                    <Route path="/tools" element={<ToolsPage />} />
                    <Route path="/analytics" element={<AnalyticsPage />} />
                    <Route path="/automation" element={<AutomationPage />} />
                    <Route path="/settings/*" element={<SettingsPage />} />
                    <Route path="*" element={<NotFoundPage inApp />} />
                  </Routes>
                </Shell>
              </Protected>
            }
          />
        </Routes>
      </React.Suspense>
    </ErrorBoundary>
  );
}

const rootEl = document.getElementById("root")!;
const app = (
  <React.StrictMode>
    {/* Outer boundary catches a crash in the router itself; the inner one in Root resets on navigation. */}
    <ErrorBoundary>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);

// If the page was pre-rendered (SSR/SSG) and the user has no active session,
// hydrate the DOM in-place for instant First Contentful Paint.
// If the user is signed in, mount freshly with createRoot to render the dashboard immediately.
if (rootEl.hasChildNodes() && !localStorage.getItem("gl.token")) {
  ReactDOM.hydrateRoot(rootEl, app);
} else {
  ReactDOM.createRoot(rootEl).render(app);
}
