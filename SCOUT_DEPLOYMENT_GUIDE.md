# Scout Production Deployment Guide

## 1. Environment Architecture

Scout is deployed across high-availability managed infrastructure:

- **Web Frontend**: Hosted on Vercel / Cloudflare Pages (Vite SPA with static prerendering for marketing routes).
- **Backend API**: Hosted on Render / Railway / AWS ECS (`@prospex/api` Node.js Fastify service).
- **Database**: Managed PostgreSQL on Neon / AWS RDS with connection pooling.

---

## 2. Key Environment Variables

### Backend API (`apps/api/.env`)
```bash
# Server Configuration
PORT=4000
NODE_ENV=production
API_BASE_URL=https://api.scout.mnbresearch.com

# Database Connection
DATABASE_URL=postgresql://user:password@ep-host.neon.tech/scout?sslmode=require

# Authentication & JWT
JWT_SECRET=super-secure-production-jwt-secret
SESSION_SECRET=super-secure-session-key

# AI Provider Keys
GEMINI_API_KEY=AIzaSy...
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...

# Telephony Gateway (Optional)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_TWIML_APP_SID=AP...
```

### Web Frontend (`apps/web/.env`)
```bash
VITE_API_BASE_URL=https://api.scout.mnbresearch.com
VITE_APP_URL=https://scout.mnbresearch.com
```

---

## 3. Database Migration Deployment

Before deploying new API versions, run schema migrations:

```bash
# Navigate to db package
cd packages/db

# Execute Drizzle migrations against production DB
npm run db:migrate
```

---

## 4. Build and Production Verification

```bash
# Run typecheck across entire monorepo
npm run typecheck

# Build all packages & execute static prerendering
npm run build

# Run security & platform test suites
npm test
```
