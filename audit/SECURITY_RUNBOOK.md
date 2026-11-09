# Scout Engineering: Security Operations Runbook
**Date:** November 9, 2026  
**Auditor Reference:** Enterprise Security Architecture `audit/hardening-2026-11-09`

---

## 1. Secret Rotation Procedures

### 1.1 Application Encryption Key (`ENCRYPTION_KEY`)
The application uses AES-256-GCM authenticated encryption with HKDF key derivation.
* **Procedure:**
  1. Generate a new 32-byte hex secret: `openssl rand -hex 32`.
  2. In Render Dashboard (`getleads-api`), copy the current value of `ENCRYPTION_KEY`.
  3. Prepend the old key to `ENCRYPTION_KEYS_OLD` (comma-separated list).
  4. Paste the newly generated key into `ENCRYPTION_KEY`.
  5. Deploy. The application automatically encrypts new writes under the new key while continuing to read legacy records via `ENCRYPTION_KEYS_OLD`.
  6. Run `npm run test -w apps/api src/security.auth.test.ts` to verify backward and forward decryption compatibility.

### 1.2 Session JWT Secret (`JWT_SECRET`)
* **Procedure:**
  1. Generate a new secret: `openssl rand -hex 32`.
  2. Note: Rotating `JWT_SECRET` invalidates all existing user session tokens immediately, requiring all users to log in again.
  3. Update `JWT_SECRET` in Render environment and trigger a restart.

### 1.3 Database Connection Credentials (`DATABASE_URL`)
* **Procedure:**
  1. In Neon / Supabase, create a new database role or reset the existing role password.
  2. Update `DATABASE_URL` in Render.
  3. Verify connection via `GET /health`.

---

## 2. Security Incident Response Playbook

```mermaid
flowchart TD
    A["Incident Reported / Alert Triggered"] --> B["Triage & Severity Classification"]
    B --> C{"Severity Level?"}
    C -->|P0: Critical (Data Breach / Auth Bypass)| D["Execute P0 Emergency Protocol"]
    C -->|P1: High (Denial of Service / SSRF)| E["Execute P1 Containment"]
    C -->|P2: Medium (Failed Login Spike)| F["Monitor & Throttle"]
    
    D --> D1["Freeze Compromised Senders / API Keys"]
    D1 --> D2["Roll JWT_SECRET & Invalidate Sessions"]
    D2 --> D3["Deploy Patch via Emergency Hotfix Branch"]
    D3 --> D4["Notify Affected Workspace Owners within 72h (GDPR)"]
```

### Emergency Contacts & Roles
* **Incident Commander:** Platform Lead (`mridul@mnbresearch.com`)
* **Security Escalation:** `security@mnbresearch.com`

---

## 3. Pre-Deployment Security Checklist

Before merging any pull request to `main` or deploying to production:
- [ ] Run `npm run secret-scan` to verify zero credentials in tracked/staged code.
- [ ] Run `npm run typecheck` across all workspace packages (`core`, `db`, `api`, `web`, `sdk`, `mcp`).
- [ ] Run `npm test -w apps/api src/security.platform.test.ts` to verify security assertions pass.
- [ ] Run `npm test -w apps/api src/security.rls.test.ts` to ensure database RLS coverage is intact.
- [ ] Confirm no database migration drops columns without backward-compatible defaults.
- [ ] Verify no new route is added without being registered in `apps/api/src/tenancy.matrix.test.ts`.

---

## 4. Automated CI Security Testing Maintenance

Automated security checks are wired directly into `.github/workflows/ci.yml`:
1. **Secret Scanning:** Executes `scripts/secret-scan.mjs` against all tracked and untracked repository files.
2. **Typecheck & Linting:** Validates schema and type boundaries.
3. **Multi-Tenant Matrix Test:** Executes against isolated Postgres test schema.
4. **Dependency Audit:** Runs `npm audit --omit=dev --audit-level=high` in its own pipeline step.

To extend the secret scanner with new vendor tokens, add signatures to `SECRET_PATTERNS` in `scripts/secret-scan.mjs`.

---

## 5. Vulnerability Disclosure Policy Template

```markdown
# Vulnerability Disclosure Policy

At Scout, we take security seriously. If you believe you have discovered a security vulnerability in our application or infrastructure, please report it to us responsibly.

### Reporting
Please email security@mnbresearch.com with:
- Description of the vulnerability and attack vector
- Reproduction steps or proof of concept
- Potential impact

We will acknowledge receipt within 24 hours and provide an estimated remediation timeline within 72 hours. We ask that you do not disclose the vulnerability publicly until we have had reasonable time to address it.
```
