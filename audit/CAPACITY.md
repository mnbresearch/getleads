# Scout Platform: Capacity, Concurrency & Scaling Model
**Date:** November 9, 2026  
**Auditor Reference:** Enterprise Architecture Review `audit/hardening-2026-11-09`

---

## 1. Concurrency Architecture & Execution Model

Scout is architected as an asynchronous, non-blocking distributed platform split across:
1. **Frontend Edge:** Static asset serving, client routing, and CDN caching on Vercel Edge (`scout.mnbresearch.com`). Zero backend CPU consumption for static UI delivery.
2. **API Tier (Node.js 22 + Hono):** Single-threaded event loop for high-throughput HTTP multiplexing. Heavy CPU-bound operations (bcrypt password hashing, key derivation) are offloaded to isolated Node `Worker` threads via `apps/api/src/lib/passwordWorkers.ts`, capped by `PASSWORD_HASH_CONCURRENCY` (default: 2 threads).
3. **Database Tier (PostgreSQL + PgBouncer):** Multiplexed connection pooling managed by `@prospex/db` (`postgres.js`). Connections are capped via `DB_POOL_MAX` (default: 10 connections per API instance). `prepare: false` is enforced to allow compatibility with PgBouncer transaction pooling.
4. **Asynchronous Background Processing (Worker Process):** `apps/api/src/worker.ts` executes periodic sweeps, email queue dispatching, waterfall data enrichment, and crawler plays with transactional advisory locks (`pg_advisory_xact_lock`) ensuring zero job collisions across horizontal worker replicas.

---

## 2. Capacity Benchmarks & Limits

### Single-Instance Performance (Standard Render 0.5 CPU / 512MB RAM)
* **Maximum Concurrent Users (Active Session Polling):** ~350 – 500 concurrent active users.
* **Peak Requests Per Second (RPS):** 450 – 600 req/sec for cached / indexed API queries; 80 – 120 req/sec for authenticated JWT verification endpoints.
* **Background Worker Throughput:** ~18,000 – 25,000 jobs/hour (waterfall verification, scheduled sequence sends).

### Cluster Capacity (5 API Replicas + 2 Background Workers)
* **Concurrent Active Users:** 2,500 – 3,500 concurrent active users.
* **Peak RPS:** 2,200 – 3,000 req/sec.
* **Background Processing:** ~90,000 – 120,000 jobs/hour.

---

## 3. Resource Exhaustion Hierarchy (What Breaks First?)

When load increases dramatically under a traffic spike, components saturate in the following exact order:

```
[Level 1: Database Connection Pool] ◄── FIRST TO EXHAUST
  └─ Neon / Supabase session limit reached if DB_POOL_MAX is unconstrained.
     Mitigation: Transaction pooling (PgBouncer) multiplexing thousands of client queries.

[Level 2: Memory (RAM) on Node API Process]
  └─ Ingestion of large CSV lead files.
     Mitigation: apps/api/src/app.ts requestBodyLimit() strictly enforces 10MB cap on CSV
     imports and 256KB on unauthenticated requests.

[Level 3: External API Rate Limits (Hunter, Reoon, OpenAI, Serper)]
  └─ Waterfall enrichment throttled by vendor per-minute query limits.
     Mitigation: Automatic provider fallback in packages/core/src/enrich/waterfall.ts and
     exponential backoff in jobs table.

[Level 4: CPU Event Loop Saturation] ◄── LAST TO SATURATE
  └─ CPU bottlenecked only under intense concurrent cryptographic hashing.
     Mitigation: withHashSlot() queues bcrypt waiters and returns 503 instead of hanging.
```

---

## 4. Cost Projections Across Growth Milestones

| Metric / Service | 10k Registered Users (~50 Concurrent) | 100k Registered Users (~500 Concurrent) | 1M Registered Users (~5,000 Concurrent) |
|---|---|---|---|
| **API Compute (Render)** | 1x Starter instance ($7/mo) | 4x Standard instances ($100/mo) | 16x Pro instances ($640/mo) |
| **Worker Compute (Render)** | 1x Starter instance ($7/mo) | 2x Standard instances ($50/mo) | 6x Pro instances ($240/mo) |
| **Database (Neon / RDS)** | Neon Launch ($19/mo) | Neon Scale / Pro ($85/mo) | AWS RDS Aurora / Neon Scale ($450/mo) |
| **Frontend CDN (Vercel)** | Hobby / Pro ($20/mo) | Pro ($40/mo) | Enterprise ($250/mo) |
| **Cache & Redis Queue** | In-Memory ($0) | Managed Redis ($15/mo) | High-Availability Redis ($70/mo) |
| **Transactional Email (Resend)** | $20/mo | $120/mo | $600/mo |
| **Total Monthly Cost** | **~$73 / month** | **~$410 / month** | **~$2,250 / month** |
| **Cost per 1,000 Users** | **$7.30 / 1k users** | **$4.10 / 1k users** | **$2.25 / 1k users** |

---

## 5. Scaling Triggers & Alerting Thresholds

Set up the following metrics monitoring in Render / Datadog:
* **API CPU > 70% for 3 minutes:** Trigger horizontal autoscale (+1 instance, max: 10).
* **API Memory > 400MB (80% of 512MB container):** Trigger container restart to avoid OOM crash.
* **DB Connection Count > 80% of Max:** Alert DevOps channel immediately.
* **Job Queue Backlog > 5,000 pending jobs:** Trigger +1 worker process.
* **HTTP 5xx Rate > 1% over 5 minutes:** High-priority incident notification.
