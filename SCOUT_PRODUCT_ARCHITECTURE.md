# Scout by MNB Research - Product Architecture

## 1. Executive Overview

Scout is an enterprise-grade AI Sales Development and Revenue Execution Platform engineered by MNB Research. Moving beyond conventional siloed outreach tools or disconnected dialers, Scout brings together:

- **AI Research & Intent Signals**: Real-time website visitor identification, deanonymization, ICP fit scoring, and buying stage prediction.
- **Multi-Channel Orchestration**: Integrated Plays supporting automated email sequences, personalized LinkedIn touches, webhook tasks, and AI phone touchpoints.
- **AI Sales Dialer & Calling Workspace**: 3-panel calling console with automated queue prioritization, live AI conversation assistance, real-time objection battlecards, and post-call CRM logging.
- **Virtual Salesfloor & Blitzes**: Real-time rep presence, team calling blitzes, collaborative milestone celebration, and live coaching assistance.
- **AI Sales Coaching & Roleplay Simulator**: Interactive buyer persona simulations (Skeptical CFO, Busy Founder, RevOps Leader) with turn-by-turn feedback and scoring.
- **Opportunity Pipeline & CRM**: Unified deal pipeline with automated stage progression, health scoring, probability calculation, and AI next-best action recommendations.
- **Governance & Tenant Safety**: Human-in-the-loop controls, approval queues, strict RBAC, automated rate limiting, and 7-day feature-gated demo sandboxes.

```
                           +----------------------------------------+
                           |           SCOUT COMMAND CENTER         |
                           +----------------------------------------+
                                        |              |
                +-----------------------+              +-----------------------+
                |                                                              |
+-------------------------------+                              +-------------------------------+
|     OUTBOUND & ENGAGEMENT     |                              |      REVENUE EXECUTION        |
| - Account & Prospect Research |                              | - AI Sales Dialer             |
| - Visitor Identification      |                              | - Live Objection Battlecards  |
| - Multi-Touch Plays/Cadences  |                              | - Virtual Salesfloor & Blitz  |
| - Deliverability Ramp Manager |                              | - AI Coaching & Simulator     |
| - LinkedIn & Email Execution  |                              | - Deal Pipeline & Opportunities
+-------------------------------+                              +-------------------------------+
                                        |              |
                                        v              v
                           +----------------------------------------+
                           |          UNIFIED DATA LAYER            |
                           |  (PostgreSQL + Drizzle ORM + Vector)   |
                           +----------------------------------------+
                                        |              |
                                        v              v
                           +----------------------------------------+
                           |       INTELLIGENCE & INTEGRATIONS      |
                           | - DeepSeek / Gemini / OpenAI Models    |
                           | - HubSpot, Pipedrive, Zoho, Salesforce |
                           | - WebRTC & Telephony Engine (SIP/Twilio)|
                           +----------------------------------------+
```

---

## 2. Core Service Domains

### A. Intelligent Dialer Engine
- **Queue Prioritization**: Evaluates account intent signals, recent website visits, sequence step timing, and local time zones to construct an optimized daily dial list.
- **Active Call Console**: One-click dialing with WebRTC call state tracking (connecting, in-call, wrap-up), live call timer, quick dispositions (Meeting Booked, Follow Up, Gatekeeper, Voicemail, Not Interested), and meeting booking links.
- **Real-Time AI Battlecards**: Live assistance offering contextual objection responses (e.g., "Already using a competitor", "No budget right now", "Send me an email").
- **Post-Call Intelligence**: Automatic transcript logging, sentiment scoring, talk-to-listen ratio estimation, and instant sync to CRM.

### B. Virtual Salesfloor
- **Live Floor Presence**: Real-time team visualization showing rep status (`in_call`, `available`, `coaching`, `wrap_up`).
- **Blitz Mode**: Synchronized calling sprints with team targets (calls made, meetings booked) and live countdown timer.
- **Milestone Celebration**: Broadcasts notable milestones across the floor (e.g., "Alex booked a demo with Stripe!").

### C. AI Sales Coaching Simulator
- **Interactive Roleplay**: Reps practice pitches against simulated enterprise personas (`skeptical_cfo`, `busy_founder`, `revops_leader`).
- **Turn-by-Turn Guidance**: Provides instant feedback after each rep utterance, highlighting strengths and coaching opportunities.
- **Session Evaluation**: Generates composite score (0-100), key strengths, and specific areas for development.

### D. Revenue Opportunities & Pipeline
- **Kanban Deal Board**: Organized across `Discovery`, `Demo Scheduled`, `Proposal`, `Negotiation`, `Won`, and `Lost`.
- **Predictive Risk & Probability**: Automated win probability based on engagement frequency, objections raised, and deal velocity.
- **AI Next-Best Action**: Actionable recommendations for every deal (e.g., "Send ROI case study to VP Finance", "Follow up on contract review").

### E. Multi-Touch Plays & Autopilot
- **Execution Safeguards**: Daily sending limits, human-in-the-loop approval queues, and domain warmup schedules.
- **Deliverability Protection**: Automatic MX/SPF/DKIM validation, bounce rate throttling, and inbox rotation.

---

## 3. Technology Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS, Lucide Icons |
| **Backend API** | Node.js, Fastify / Express, TypeScript, Zod |
| **Database & ORM** | PostgreSQL (Neon / Supabase), Drizzle ORM |
| **AI Intelligence** | Gemini 2.5 Flash / Pro, DeepSeek V3, OpenAI GPT-4o |
| **Telephony & Real-time** | WebRTC abstraction layer, Server-Sent Events (SSE) / WebSockets |
| **Authentication & RBAC** | Session cookies, Bearer tokens, Role-Based Access Control |
| **Integrations** | HubSpot, Pipedrive, Zoho, Google Sheets, MCP Protocol |
