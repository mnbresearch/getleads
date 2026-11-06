# Scout REST API Documentation: Revenue Execution Suite

Base URL: `/v1`

All requests require either a valid Bearer token (`Authorization: Bearer <token>`) or an active session cookie. Multi-tenant workspace scoping is automatically enforced based on the caller's active workspace.

---

## 1. Opportunities & Deals (`/v1/deals`)

### `GET /v1/deals`
Returns all deals for the active workspace, grouped by stage summary with pipeline totals.

**Response `200 OK`**:
```json
{
  "deals": [
    {
      "id": "7f8b9a12-...",
      "name": "Databricks Enterprise Rollout",
      "companyName": "Databricks",
      "stage": "proposal",
      "value": "45000.00",
      "probability": 70,
      "riskLevel": "low",
      "aiRecommendedAction": "Send executive security whitepaper"
    }
  ],
  "summary": {
    "totalValue": 182000,
    "weightedPipeline": 94500,
    "count": 6
  }
}
```

### `POST /v1/deals`
Creates a new deal record.

**Request Body**:
```json
{
  "name": "Ramp RevOps Acceleration",
  "companyName": "Ramp",
  "value": 35000,
  "stage": "discovery",
  "probability": 25,
  "contactName": "Sarah Chen",
  "contactEmail": "schen@ramp.com"
}
```

### `PATCH /v1/deals/:id`
Updates stage, value, probability, or next-best actions.

---

## 2. AI Sales Dialer (`/v1/dialer`)

### `GET /v1/dialer/queue`
Fetches the prioritized calling queue for the day, enriched with intent signals, battlecards, and talk tracks.

**Response `200 OK`**:
```json
{
  "queue": [
    {
      "id": "prospect-1",
      "name": "Sarah Chen",
      "title": "Head of Revenue Operations",
      "company": "ScaleAI",
      "phone": "+1 (415) 890-2341",
      "intentScore": 94,
      "recentSignal": "Viewed Pricing page 3x yesterday",
      "talkTrack": "Acknowledge recent evaluation of conversation intelligence platforms...",
      "battlecards": [
        {
          "trigger": "Using Gong/Outreach",
          "response": "Unlike Gong which is post-call only, Scout combines dialer, live in-call assistance, and multichannel plays into one seat."
        }
      ]
    }
  ]
}
```

### `POST /v1/dialer/log`
Logs an outbound call attempt, duration, notes, and disposition.

**Request Body**:
```json
{
  "contactPhone": "+1 (415) 890-2341",
  "contactName": "Sarah Chen",
  "companyName": "ScaleAI",
  "durationSec": 185,
  "disposition": "meeting_booked",
  "notes": "Agreed to 20-min demo on Thursday 2pm PST."
}
```

---

## 3. AI Sales Coaching & Roleplay (`/v1/coaching`)

### `GET /v1/coaching/personas`
Retrieves available buyer personas with objection styles and difficulty levels.

### `POST /v1/coaching/simulate-turn`
Simulates a conversation turn against an AI buyer persona.

**Request Body**:
```json
{
  "personaId": "skeptical_cfo",
  "userMessage": "Our platform replaces 3 separate subscriptions and cuts customer acquisition cost by 35% in 60 days.",
  "history": []
}
```

**Response `200 OK`**:
```json
{
  "reply": "Every vendor claims 30% savings. What does the implementation timeline look like, and how much engineering overhead does it require?",
  "coachingTip": "Great anchor on CAC reduction. Now address implementation time and de-risk engineering requirements.",
  "turnScore": 88
}
```

---

## 4. Virtual Salesfloor (`/v1/salesfloor`)

### `GET /v1/salesfloor/state`
Returns active team presence, live call indicators, blitz progress, and milestone feed.

### `POST /v1/salesfloor/blitz`
Initiates a new team calling sprint.

**Request Body**:
```json
{
  "name": "Afternoon Outbound Blitz",
  "targetCalls": 60,
  "targetMeetings": 6
}
```
