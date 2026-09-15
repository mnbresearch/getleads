import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { auth } from "./lib/api";
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
import { TasksPage } from "./pages/Tasks";
import { AutopilotPage } from "./pages/Autopilot";
import { ToolsPage } from "./pages/Tools";
import { JoinPage } from "./pages/Join";
import { LandingPage } from "./pages/Landing";

function Protected({ children }: { children: React.ReactNode }) {
  return auth.token ? <>{children}</> : <Navigate to="/login" replace />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/" element={auth.token ? <Protected><Shell><Dashboard /></Shell></Protected> : <LandingPage />} />
        <Route
          path="/*"
          element={
            <Protected>
              <Shell>
                <Routes>
                  <Route path="/leads" element={<LeadsPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/icps" element={<IcpPage />} />
                  <Route path="/campaigns" element={<CampaignsPage />} />
                  <Route path="/campaigns/:id" element={<CampaignDetail />} />
                  <Route path="/agent" element={<AgentPage />} />
                  <Route path="/visitors" element={<VisitorsPage />} />
                  <Route path="/signals" element={<SignalsPage />} />
                  <Route path="/tasks" element={<TasksPage />} />
                  <Route path="/autopilot" element={<AutopilotPage />} />
                  <Route path="/tools" element={<ToolsPage />} />
                  <Route path="/settings/*" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Shell>
            </Protected>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
