# Scout Database Schema & Data Models

This document details the PostgreSQL schema managed via Drizzle ORM in `@prospex/db`.

## 1. Revenue Execution & Salesfloor Entities

### `deals`
Manages sales opportunities, pipeline stages, and AI revenue guidance.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | Primary Key, defaultRandom | Unique deal identifier |
| `workspace_id` | `uuid` | Not Null, FK -> `workspaces.id` | Multi-tenant workspace scoping |
| `name` | `varchar(255)` | Not Null | Opportunity title (e.g. "Acme Enterprise License") |
| `company_name` | `varchar(255)` | Not Null | Target account name |
| `stage` | `varchar(50)` | Not Null, default 'discovery' | `discovery`, `demo`, `proposal`, `negotiation`, `won`, `lost` |
| `value` | `numeric(12, 2)` | Not Null, default 0 | Monetary value of the deal |
| `currency` | `varchar(10)` | Not Null, default 'USD' | Currency code |
| `probability` | `integer` | Not Null, default 20 | Win probability (0-100) |
| `close_date` | `timestamp` | Nullable | Target closing date |
| `owner_name` | `varchar(120)` | Nullable | Assigned sales representative |
| `contact_name` | `varchar(120)` | Nullable | Primary decision maker |
| `contact_email`| `varchar(255)` | Nullable | Primary contact email |
| `contact_phone`| `varchar(50)` | Nullable | Primary contact phone |
| `risk_level` | `varchar(20)` | default 'low' | `low`, `medium`, `high` |
| `next_step` | `text` | Nullable | Human-defined next step |
| `ai_recommended_action` | `text` | Nullable | AI generated next-best action |
| `created_at` | `timestamp` | defaultNow | Creation timestamp |
| `updated_at` | `timestamp` | defaultNow | Last update timestamp |

---

### `call_logs`
Logs completed and in-progress dialer calls, conversation telemetry, and coaching notes.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | Primary Key, defaultRandom | Unique call log identifier |
| `workspace_id` | `uuid` | Not Null, FK -> `workspaces.id` | Multi-tenant workspace scoping |
| `user_id` | `text` | Nullable | Sales representative identifier |
| `contact_name` | `varchar(120)` | Nullable | Contact spoken with |
| `contact_phone`| `varchar(50)` | Not Null | Phone number dialed |
| `company_name` | `varchar(255)` | Nullable | Account name |
| `direction` | `varchar(20)` | default 'outbound' | `outbound` or `inbound` |
| `duration_sec` | `integer` | default 0 | Call duration in seconds |
| `disposition` | `varchar(50)` | Nullable | `meeting_booked`, `follow_up`, `gatekeeper`, `voicemail`, `bad_timing`, `not_interested` |
| `notes` | `text` | Nullable | Rep notes taken during call |
| `recording_url`| `text` | Nullable | Telephony recording URL |
| `transcript` | `text` | Nullable | Speech-to-text transcript |
| `sentiment` | `varchar(20)` | Nullable | `positive`, `neutral`, `negative` |
| `talk_to_listen_ratio` | `numeric(4, 2)` | Nullable | Ratio of rep speaking time to buyer |
| `objections_detected` | `jsonb` | Nullable | Extracted objections list |
| `created_at` | `timestamp` | defaultNow | Call start timestamp |

---

### `coaching_sessions`
Tracks rep practice sessions against simulated AI buyer personas.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | Primary Key, defaultRandom | Unique coaching session ID |
| `workspace_id` | `uuid` | Not Null, FK -> `workspaces.id` | Multi-tenant workspace scoping |
| `user_id` | `text` | Nullable | Rep participating in simulation |
| `persona_id` | `varchar(50)` | Not Null | Target persona (`skeptical_cfo`, etc.) |
| `scenario_name`| `varchar(255)` | Not Null | Pitch scenario description |
| `score` | `integer` | Nullable | Composite performance score (0-100) |
| `feedback` | `text` | Nullable | AI coaching evaluation summary |
| `strengths` | `jsonb` | Nullable | Array of detected strengths |
| `weaknesses` | `jsonb` | Nullable | Array of improvement areas |
| `transcript` | `jsonb` | Nullable | Conversation turn-by-turn history |
| `created_at` | `timestamp` | defaultNow | Session creation timestamp |

---

### `salesfloor_blitzes`
Coordinates live team calling blitzes on the Virtual Salesfloor.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | Primary Key, defaultRandom | Unique blitz sprint ID |
| `workspace_id` | `uuid` | Not Null, FK -> `workspaces.id` | Multi-tenant workspace scoping |
| `name` | `varchar(255)` | Not Null | Sprint title (e.g. "Q4 Pipeline Sprint") |
| `status` | `varchar(20)` | default 'active' | `active`, `completed`, `cancelled` |
| `target_calls` | `integer` | default 50 | Team target call volume |
| `completed_calls` | `integer` | default 0 | Actual calls logged during blitz |
| `target_meetings` | `integer` | default 5 | Team target meetings booked |
| `completed_meetings` | `integer` | default 0 | Meetings booked during blitz |
| `start_time` | `timestamp` | defaultNow | Blitz kickoff time |
| `end_time` | `timestamp` | Nullable | Blitz conclusion time |
| `created_by` | `text` | Nullable | Manager or rep who initiated blitz |
