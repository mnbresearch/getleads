import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LandingPage } from "./pages/Landing";
import { PrivacyPage, TermsPage } from "./pages/Legal";

export function renderLanding(): string {
  return renderToString(
    <React.StrictMode>
      <MemoryRouter initialEntries={["/"]}>
        <LandingPage />
      </MemoryRouter>
    </React.StrictMode>
  );
}

export function renderPrivacy(): string {
  return renderToString(
    <React.StrictMode>
      <MemoryRouter initialEntries={["/privacy"]}>
        <PrivacyPage />
      </MemoryRouter>
    </React.StrictMode>
  );
}

export function renderTerms(): string {
  return renderToString(
    <React.StrictMode>
      <MemoryRouter initialEntries={["/terms"]}>
        <TermsPage />
      </MemoryRouter>
    </React.StrictMode>
  );
}
