import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./index.css";
import { rememberReturnPath, useAuthToken } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Shell } from "./components/Shell";
import { AuthPage } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { LeadsPage } from "./pages/Leads";
import { SearchPage } from "./pages/Search";
import { IcpPage } from "./pages/Icps";
import { CampaignsPage, CampaignDetail } from "./pages/Campaigns";
import { SettingsPage } from "./pages/Settings";
import { AgentPage } from "./pages/Agent";
import { VisitorsPage } from "./pages/Visitors";
import { SignalsPage } from "./pages/Signals";
import { VisibilityPage } from "./pages/Visibility";
import { TasksPage } from "./pages/Tasks";
import { AutopilotPage } from "./pages/Autopilot";
import { ToolsPage } from "./pages/Tools";
import { AnalyticsPage } from "./pages/Analytics";
import { AutomationPage } from "./pages/Automation";
import { JoinPage } from "./pages/Join";
import { LandingPage } from "./pages/Landing";
import { UpgradeRequestPage } from "./pages/UpgradeRequest";
import { AdminLoginPage } from "./pages/AdminLogin";
import { GoogleCallbackPage } from "./pages/GoogleCallback";
import { AdminDashboardPage } from "./pages/AdminDashboard";
import { ClientsPage } from "./pages/Clients";
import { ClientDetailPage } from "./pages/ClientDetail";
import { ClientReportPage } from "./pages/ClientReport";
import { ForgotPasswordPage } from "./pages/ForgotPassword";
import { ResetPasswordPage } from "./pages/ResetPassword";
import { PrivacyPage, TermsPage } from "./pages/Legal";

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuthToken();
  const loc = useLocation();
  // A signed-out deep link (an emailed /leads?... link, a bookmark) comes back here after
  // sign-in instead of landing on the overview.
  if (!token) rememberReturnPath(loc.pathname + loc.search);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

function Root() {
  const token = useAuthToken();
  const loc = useLocation();
  return (
    <ErrorBoundary resetKey={loc.pathname}>
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/signup" element={<AuthPage mode="signup" />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/upgrade" element={<UpgradeRequestPage />} />
      <Route path="/auth/google" element={<GoogleCallbackPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
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
          <Protected>
            <Shell>
              <Routes>
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
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Shell>
          </Protected>
        }
      />
    </Routes>
    </ErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Outer boundary catches a crash in the router itself; the inner one in Root resets on navigation. */}
    <ErrorBoundary>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
