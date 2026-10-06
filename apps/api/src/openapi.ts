/** Hand-maintained OpenAPI 3.1 document. Served at /openapi.json and rendered at /docs. */
export function openapi(apiUrl: string) {
  const sec = [{ bearerAuth: [] }, { apiKey: [] }];
  const j = (schema: unknown) => ({ content: { "application/json": { schema } } });
  const ok = (schema: unknown = { type: "object" }) => ({ "200": { description: "OK", ...j(schema) } });
  const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
  const arr = (items: unknown = { type: "string" }) => ({ type: "array", items });
  const str = { type: "string" };
  const num = { type: "number" };
  const bool = { type: "boolean" };

  const searchBody = obj({
    query: { ...str, description: "Natural-language description, e.g. 'Heads of Sales at Series A fintechs in Bengaluru'" },
    titles: arr(),
    industries: arr(),
    locations: arr(),
    companySizes: arr(),
    keywords: arr(),
    companyDomains: arr(),
    limit: { type: "integer", default: 25, maximum: 200 },
    findEmails: { ...bool, default: true },
    icpId: str,
    listId: str,
    country: { ...str, description: "ISO 2-letter, biases search" },
  });
  /** A JSON response under a status other than 200. */
  const res = (status: string, description: string, schema: unknown = { type: "object" }) => ({ [status]: { description, ...j(schema) } });
  const errorBody = obj({ error: obj({ code: str, message: str }, ["code", "message"]) }, ["error"]);
  /** What a completed sign-in returns (login, 2fa/verify, password reset, Google exchange). */
  const sessionBody = obj({ token: str, user: { type: "object", description: "id, email, name, role, hasPassword, emailVerified, hasGoogle, twoFactorEnabled, twoFactorEnabledAt" }, org: { type: "object", description: "id, name, slug, plan, limits, settings, emailVerificationAvailable" } }, ["token", "user", "org"]);
  /** What a sign-in returns instead when the account has two-factor sign-in on. */
  const challengeBody = obj({ twoFactorRequired: { type: "boolean", enum: [true] }, challenge: { ...str, description: "Opaque; valid for 5 minutes. Send it to /v1/auth/2fa/verify with a code. It is not a session token" } }, ["twoFactorRequired", "challenge"]);
  const sessionOrChallenge = { oneOf: [sessionBody, challengeBody] };
  const twoFactorCode = { ...str, description: "The 6-digit code from the authenticator app, or an unused recovery code (xxxx-xxxx-xxxx)" };
  const recoveryCodes = { ...arr(str), description: "Ten single-use codes like \"xxxx-xxxx-xxxx\". Shown this once; only their hashes are stored" };
  const adminSec = [{ bearerAuth: [] }];
  const leadBody = obj({ firstName: str, lastName: str, fullName: str, title: str, email: str, linkedinUrl: str, phone: str, location: str, country: str, companyDomain: str, companyName: str, icpId: str, tags: arr(), custom: { type: "object" } });


  // ── Plays ──
  // A play is a saved recipe that finds the people who need the customer's product this week
  // from one source of buying intent. What it finds waits in a review queue as candidates;
  // only an approved candidate becomes a lead.
  const int = { type: "integer" };
  const uuid = { ...str, format: "uuid" };
  const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type as string, "null"] });
  const dateTime = { ...str, format: "date-time" };
  const idParam = (description: string) => ({ name: "id", in: "path", required: true, schema: uuid, description });
  const tagList = (maxItems: number, maxLength = 100) => ({ type: "array", maxItems, items: { ...str, minLength: 1, maxLength } });
  const PLAY_TYPE_IDS = ["competitor_customers", "hiring_role", "funding", "public_asks", "website_visitors", "job_changes", "engagers_upload"];
  const playType = { ...str, enum: PLAY_TYPE_IDS };
  const playCounts = obj({ pending: int, approved: int, skipped: int }, ["pending", "approved", "skipped"]);
  /** The settings each type of play takes. Keys that do not belong to the type are dropped. */
  const playConfigs: Record<string, Record<string, unknown>> = {
    competitor_customers: obj({ competitors: { type: "array", minItems: 1, maxItems: 10, items: obj({ name: { ...str, minLength: 1, maxLength: 120 }, domain: { ...str, description: "Optional. Found for you when left out" } }, ["name"]) }, maxPerCompetitor: { ...int, minimum: 1, maximum: 50 } }, ["competitors"]),
    hiring_role: obj({ roles: { ...tagList(10), minItems: 1, description: "Job titles of the open postings to look for" }, keywords: tagList(10), locations: tagList(10), companyDomains: { ...tagList(50, 253), description: "Only look at these companies" } }, ["roles"]),
    funding: obj({ keywords: arr(), industries: arr(), locations: arr(), days: { ...int, minimum: 1, maximum: 60, default: 14 }, minAmountUsd: num, country: { ...str, description: "ISO 2-letter" } }),
    public_asks: { ...obj({ competitors: { ...tagList(10, 120), description: "Competitor names" }, problems: tagList(10, 160), category: { ...str, maxLength: 120 }, sources: arr({ ...str, enum: ["linkedin", "reddit", "hackernews", "x", "forums"] }), days: int }), description: "At least one of competitors, problems or category" },
    website_visitors: obj({ minIntentScore: { ...int, minimum: 0, maximum: 100, default: 30 }, days: { ...int, minimum: 1, maximum: 90, default: 14 } }),
    job_changes: obj({ days: { ...int, minimum: 1, maximum: 90, default: 30 } }),
    engagers_upload: { ...obj({}), description: "No settings: this type is fed by uploads" },
  };
  const playConfig = { description: "The play's settings. Which keys apply depends on the play's type: see POST /v1/plays", anyOf: PLAY_TYPE_IDS.map((t) => ({ title: t, ...playConfigs[t] })) };
  /** What a play is created or changed with. */
  const playInputProps = {
    name: { ...str, minLength: 1, maxLength: 120 },
    type: playType,
    config: playConfig,
    targetTitles: { ...tagList(20), description: "Job titles to look for at the companies the play finds" },
    icpId: { ...uuid, description: "People are scored against this ICP" },
    clientId: uuid,
    listId: { ...uuid, description: "Approved people are added to this list" },
    campaignId: { ...uuid, description: "The campaign approved people can be added to, when a decision is sent with `enroll: true`. A play never starts a campaign" },
    autoApprove: { ...bool, default: false, description: "When true, the people a run finds become leads without review" },
    minScore: { ...int, minimum: 0, maximum: 100 },
    runEveryHours: { type: ["integer", "null"], minimum: 6, maximum: 720, description: "null: only when asked" },
    status: { ...str, enum: ["active", "paused"] },
  };
  const playRunOut = obj(
    {
      id: uuid,
      playId: uuid,
      status: { ...str, enum: ["running", "done", "failed", "blocked"], description: "`blocked`: the run could not look anywhere (`note` says why). That is not the same as finding nobody" },
      trigger: { ...str, enum: ["manual", "schedule", "upload"] },
      found: int,
      added: { ...int, description: "New candidates put in the review queue" },
      duplicates: { ...int, description: "Already found by an earlier run of this play" },
      note: { ...nullable(str), description: "A plain sentence about the run" },
      error: nullable(str),
      startedAt: dateTime,
      finishedAt: nullable(dateTime),
    },
    ["id", "playId", "status", "trigger", "found", "added", "duplicates", "startedAt"],
  );
  const playOut = obj(
    {
      id: uuid,
      name: str,
      type: playType,
      status: { ...str, enum: ["active", "paused"] },
      config: { type: "object" },
      targetTitles: arr(),
      icpId: nullable(uuid),
      clientId: nullable(uuid),
      listId: nullable(uuid),
      campaignId: nullable(uuid),
      autoApprove: bool,
      minScore: int,
      runEveryHours: { type: ["integer", "null"] },
      lastRunAt: nullable(dateTime),
      nextRunAt: nullable(dateTime),
      lastResult: { type: ["object", "null"], description: "What the last run did", properties: { status: str, found: int, added: int, duplicates: int, note: nullable(str) } },
      createdAt: dateTime,
      updatedAt: dateTime,
      counts: { ...playCounts, description: "This play's candidates by decision" },
    },
    ["id", "name", "type", "status", "config", "targetTitles", "autoApprove", "minScore", "createdAt", "updatedAt", "counts"],
  );
  const candidateOut = obj(
    {
      id: uuid,
      playId: uuid,
      playName: str,
      playType,
      kind: { ...str, enum: ["person", "company", "post"], description: "person: someone who can be contacted. company: the company was found but nobody there yet. post: a public conversation with no contact details" },
      status: { ...str, enum: ["pending", "approved", "skipped"] },
      skipReason: nullable(str),
      fullName: nullable(str),
      firstName: nullable(str),
      lastName: nullable(str),
      title: nullable(str),
      linkedinUrl: nullable(str),
      email: nullable(str),
      emailStatus: nullable(str),
      location: nullable(str),
      companyName: nullable(str),
      companyDomain: nullable(str),
      relevantBecause: { ...str, description: "One sentence saying why this person or company is relevant now. Built from the evidence by fixed rules, never written freely by a model" },
      evidenceUrl: { ...nullable(str), description: "The page that proves the reason. null when the evidence is the workspace's own data (website visits, a job-change check)" },
      evidenceTitle: nullable(str),
      evidenceQuote: { ...nullable(str), description: "Verbatim from the evidence" },
      signalType: { ...str, description: "competitor_customer | job_posting | funding | public_ask | public_complaint | site_visit | job_change | post_engagement" },
      signalAt: nullable(dateTime),
      confidence: { ...num, minimum: 0, maximum: 1 },
      score: { type: ["number", "null"], description: "Fit against the play's ICP, 0 to 100; null when the play has none" },
      scoreReasons: arr(),
      leadId: { ...nullable(uuid), description: "The lead, once approved - or straight away when the person was already a lead" },
      alreadyLead: bool,
      decidedAt: nullable(dateTime),
      createdAt: dateTime,
    },
    ["id", "playId", "playName", "playType", "kind", "status", "relevantBecause", "signalType", "confidence", "scoreReasons", "alreadyLead", "createdAt"],
  );
  const engagerRow = obj({ fullName: str, firstName: str, lastName: str, title: str, companyName: str, companyDomain: str, linkedinUrl: str, email: str, location: str, note: str });

  return {
    openapi: "3.1.0",
    info: {
      title: "Scout API",
      version: "1.0.0",
      description:
        "Lead generation infrastructure for sales teams and AI agents: real-time B2B discovery, company enrichment, email finding + verification, ICP lookalike scoring, AI-personalized outreach, sequences, tracking, webhooks and CRM sync.\n\nAuthenticate with `x-api-key: px_live_...` (recommended for agents) or `Authorization: Bearer <jwt>`.\n\nAn API key is either full access or read-only (chosen when it is created). A read-only key may only make GET and HEAD requests; anything else answers `403 insufficient_scope`.\n\nLong-running operations return `202` with a `jobId`; poll `GET /v1/search/{id}` or `GET /v1/search/jobs/{jobId}`.\n\nRequest bodies are limited to 1 MB (10 MB for `POST /v1/leads/import`, 2 MB for `POST /v1/plays/{id}/upload`); larger ones get `413 payload_too_large`.",
    },
    servers: [{ url: apiUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    security: sec,
    paths: {
      "/v1/auth/signup": {
        post: {
          tags: ["Auth"],
          security: [],
          summary: "Create workspace + user; returns JWT and an API key. When the platform can send mail, a confirmation link is emailed (`verificationEmailSent`); the account works straight away, but cannot send team invites or use the shared sender until the address is confirmed. At most 5 new workspaces an hour and 20 a day from one network address (429 rate_limited)",
          requestBody: j(obj({ email: str, password: str, name: str, orgName: str, inviteCode: str }, ["email", "password"])),
          responses: { "201": { description: "Created", ...j(obj({ token: str, user: { type: "object" }, org: { type: "object" }, apiKey: { ...str, description: "A full-access API key, shown once" }, verificationEmailSent: bool })) }, ...res("429", "Too many new workspaces from this address", errorBody) },
        },
      },
      "/v1/auth/login": {
        post: {
          tags: ["Auth"],
          security: [],
          summary: "Login. After 5 failed attempts for one account in 15 minutes: 429 too_many_attempts with a Retry-After header. When the account has two-factor sign-in on and the password is right, the answer is `{twoFactorRequired:true, challenge}` and NO token: send the challenge with a code to /v1/auth/2fa/verify",
          requestBody: j(obj({ email: str, password: str }, ["email", "password"])),
          responses: ok(sessionOrChallenge),
        },
      },
      "/v1/auth/2fa/verify": {
        post: {
          tags: ["Two-factor"],
          security: [],
          summary: "Second step of a two-factor sign-in: the challenge from /v1/auth/login (or from a password reset) plus a code. Returns the same body as a login. A wrong code is 401 invalid_2fa_code and counts towards the account's sign-in lock (5 in 15 minutes -> 429 too_many_attempts). An authenticator code works once per 30-second step; a recovery code works once (the response then carries `usedRecoveryCode` and `recoveryCodesLeft`). An expired or unusable challenge is 401 invalid_2fa_challenge: sign in again",
          requestBody: j(obj({ challenge: str, code: twoFactorCode }, ["challenge", "code"])),
          responses: { ...ok({ ...sessionBody, properties: { ...sessionBody.properties, usedRecoveryCode: bool, recoveryCodesLeft: { type: "integer" } } }), ...res("401", "invalid_2fa_code or invalid_2fa_challenge", errorBody), ...res("429", "too_many_attempts", errorBody) },
        },
      },
      "/v1/auth/2fa/setup": {
        post: {
          tags: ["Two-factor"],
          security: [{ bearerAuth: [] }],
          summary: "Start setting up two-factor sign-in (TOTP: SHA-1, 6 digits, 30 seconds). Returns the secret and the otpauth:// link to show as a QR code. Nothing is on until /v1/auth/2fa/enable is called with a code. `currentPassword` is required when the account has a password (400 current_password_required, 403 invalid_credentials). 409 two_factor_already_enabled when it is already on",
          requestBody: j(obj({ currentPassword: str })),
          responses: ok(obj({ secret: { ...str, description: "base32, for typing into an authenticator by hand" }, otpauthUrl: { ...str, description: "otpauth://totp/Scout:<email>?secret=...&issuer=Scout" } }, ["secret", "otpauthUrl"])),
        },
      },
      "/v1/auth/2fa/enable": {
        post: {
          tags: ["Two-factor"],
          security: [{ bearerAuth: [] }],
          summary: "Turn two-factor sign-in on with the first code from the authenticator. Returns the recovery codes, once. 403 invalid_2fa_code for a wrong code; 400 two_factor_not_set_up when setup was not started",
          requestBody: j(obj({ code: { ...str, description: "The 6-digit code the authenticator shows" } }, ["code"])),
          responses: ok(obj({ ok: bool, recoveryCodes }, ["ok", "recoveryCodes"])),
        },
      },
      "/v1/auth/2fa/disable": {
        post: {
          tags: ["Two-factor"],
          security: [{ bearerAuth: [] }],
          summary: "Turn two-factor sign-in off. Needs a code. 403 invalid_2fa_code for a wrong code (the session is not affected); 429 too_many_attempts after five wrong codes; 400 two_factor_not_enabled when it is not on",
          requestBody: j(obj({ code: twoFactorCode }, ["code"])),
          responses: ok(obj({ ok: bool })),
        },
      },
      "/v1/auth/2fa/recovery-codes": {
        post: {
          tags: ["Two-factor"],
          security: [{ bearerAuth: [] }],
          summary: "Issue ten new recovery codes (the stored ones are hashes and cannot be shown again). The old codes stop working. Needs a code",
          requestBody: j(obj({ code: twoFactorCode }, ["code"])),
          responses: ok(obj({ recoveryCodes }, ["recoveryCodes"])),
        },
      },
      "/v1/auth/verify/confirm": {
        post: {
          tags: ["Auth"],
          security: [],
          summary: "Confirm an email address with the token from the emailed link (24 hours, single use). 400 invalid_verification_token when the token is unknown, used or expired",
          requestBody: j(obj({ token: str }, ["token"])),
          responses: { ...ok(obj({ ok: bool })), ...res("400", "invalid_verification_token", errorBody) },
        },
      },
      "/v1/auth/verify/resend": {
        post: {
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          summary: "Email the confirmation link again (3 an hour; 429 after that). `emailed` is false when the address is already verified (`alreadyVerified`), when the platform cannot send mail, or when the send failed (`message` then says so)",
          responses: ok(obj({ ok: bool, emailed: bool, alreadyVerified: bool, message: str }, ["ok", "emailed"])),
        },
      },
      "/v1/auth/password/forgot": { post: { tags: ["Auth"], security: [], summary: "Email a password-reset link. Always 200 {ok:true}, whether or not the address has an account. One address is mailed at most once a minute and 3 times an hour; past that the answer is the same and nothing is sent", requestBody: j(obj({ email: str }, ["email"])), responses: ok(obj({ ok: bool })) } },
      "/v1/auth/password/reset": { post: { tags: ["Auth"], security: [], summary: "Set a new password from an emailed token (1 hour, single use); returns the same body as /v1/auth/login. With two-factor sign-in on, the password is changed but the answer is `{twoFactorRequired:true, challenge}` instead of a token", requestBody: j(obj({ token: str, password: { ...str, minLength: 8 } }, ["token", "password"])), responses: ok(sessionOrChallenge) } },
      "/v1/auth/password/change": { post: { tags: ["Auth"], summary: "Change your password. currentPassword is required unless the account has never had one (Google sign-up). With two-factor sign-in on, `code` is required as well (400 two_factor_code_required, 403 invalid_2fa_code). Signs out every other session; the response carries a fresh `token` that replaces the caller's", security: [{ bearerAuth: [] }], requestBody: j(obj({ currentPassword: str, newPassword: { ...str, minLength: 8 }, code: twoFactorCode }, ["newPassword"])), responses: ok(obj({ ok: bool, token: str, sessionsRevoked: bool })) } },
      "/v1/auth/logout-all": { post: { tags: ["Auth"], summary: "Sign out everywhere: every session token for this user stops working, including the caller's. API keys are not affected", security: [{ bearerAuth: [] }], responses: ok(obj({ ok: bool })) } },
      "/v1/auth/google/status": { get: { tags: ["Auth"], security: [], summary: "Whether Sign in with Google is available", responses: ok(obj({ enabled: bool })) } },
      "/v1/auth/google/start": { get: { tags: ["Auth"], security: [], summary: "Browser redirect to Google. `cv` is base64url(SHA-256(verifier)) for a random verifier the web app keeps; `next` is a path in the app", parameters: [{ name: "cv", in: "query", required: true, schema: str }, { name: "next", in: "query", schema: str }], responses: { "302": { description: "Redirect to Google" } } } },
      "/v1/auth/google/exchange": { post: { tags: ["Auth"], security: [], summary: "Trade the one-time code from the Google callback (60 seconds, single use) plus the verifier for a session; same body as /v1/auth/login", requestBody: j(obj({ code: str, verifier: str }, ["code", "verifier"])), responses: ok() } },
      "/v1/audit-log": { get: { tags: ["Account"], summary: "Security log for the workspace, newest first (owner/admin session only): sign-ins, password changes, API keys, admin changes. `ip` is null on rows made by the platform operator (actorType \"admin\")", security: [{ bearerAuth: [] }], parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } }, { name: "before", in: "query", schema: str, description: "nextBefore from the previous page" }], responses: ok(obj({ entries: arr(obj({ id: str, action: str, actorType: str, actorEmail: str, targetType: str, targetId: str, result: { ...str, enum: ["ok", "denied", "failed"] }, ip: str, createdAt: str, data: { type: "object" } })), hasMore: bool, nextBefore: str })) } },
      "/v1/tools/team/invites/{id}": { delete: { tags: ["Team"], summary: "Revoke a pending invite (owner/admin)", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/tools/team/invites/{id}/resend": { post: { tags: ["Team"], summary: "Re-send a pending invite and renew its 14-day expiry (owner/admin)", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/webhooks/{id}/test": { post: { tags: ["Webhooks"], summary: "Deliver a webhook.test event to this webhook only, regardless of its event filter", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/webhooks/{id}/rotate-secret": {
        post: {
          tags: ["Webhooks"],
          summary: "Issue a new signing secret for this webhook (owner/admin). The new secret is returned once and the old one stops working at once. The webhook moves to signature v2 (HMAC-SHA256, sent as `v2=<hex>`), so update the receiver's verification together with the secret",
          parameters: [{ name: "id", in: "path", required: true, schema: str }],
          responses: ok(obj({ id: str, secret: { ...str, description: "Shown once; store it now" }, signatureVersion: { type: "integer", enum: [2] } })),
        },
      },
      "/v1/campaigns/email-accounts/{id}/retest": {
        post: {
          tags: ["Outreach"],
          summary: "Test a sender account's connection again (owner/admin). Sets its status to \"active\" when the test passes and \"error\" when it does not; the result is in `test`",
          parameters: [{ name: "id", in: "path", required: true, schema: str }],
          responses: ok(obj({ emailAccount: { type: "object", description: "The sender account's public fields, including its new `status`" }, test: obj({ ok: bool, error: str }, ["ok"]) })),
        },
      },
      // ── Platform admin (operator only). Authenticate with the admin session token from
      // /v1/admin/login as a Bearer token, or the server-to-server `x-admin-token` header. A
      // customer session or API key is never accepted here. Every mutation answers
      // `changed: false` (and writes nothing to the audit log) when it leaves things as they were. ──
      "/v1/admin/login": {
        post: {
          tags: ["Admin"],
          security: [],
          summary: "Admin sign-in; returns a 12-hour session token. Five failed attempts from one address lock that address for 15 minutes; fifty failed attempts in 15 minutes lock the form for every address that has not signed in before (429 too_many_attempts with Retry-After). When the server has an admin authenticator secret configured, `code` is required: without it the answer is 401 totp_required; a wrong, expired or already-used code is 401 invalid_totp and counts towards the lock",
          requestBody: j(obj({ email: str, password: str, code: { ...str, description: "The 6-digit code from the operator's authenticator app. Only needed when the server asks for it (401 totp_required)" } }, ["email", "password"])),
          responses: { ...ok(obj({ token: str })), ...res("401", "totp_required or invalid_totp", errorBody) },
        },
      },
      "/v1/admin/session": {
        get: {
          tags: ["Admin"],
          security: adminSec,
          summary: "Whether the presented admin credential is valid. `totpEnabled` says whether the admin login asks for an authenticator code",
          responses: ok(obj({ ok: bool, totpEnabled: bool }, ["ok", "totpEnabled"])),
        },
      },
      "/v1/account/export": {
        get: { tags: ["Account"], security: [{ bearerAuth: [] }], summary: "Download everything the workspace owns as JSON (owner session only). Re-confirmed with the `x-confirm-password` header, or `x-confirm-code` when two-factor sign-in is on. At most one export every 10 minutes per workspace", parameters: [{ name: "x-confirm-password", in: "header", schema: str }, { name: "x-confirm-code", in: "header", schema: str }], responses: ok({ type: "object", description: "The workspace's data, as a file download" }) },
        post: { tags: ["Account"], security: [{ bearerAuth: [] }], summary: "The same export, with the confirmation in the body", requestBody: j(obj({ password: str, code: str })), responses: ok({ type: "object", description: "The workspace's data, as a file download" }) },
      },
      "/v1/account/deletion": { get: { tags: ["Account"], security: [{ bearerAuth: [] }], summary: "Whether a deletion of this workspace is pending, and when it is due", responses: ok(obj({ pending: bool, scheduledFor: str }, ["pending"])) } },
      "/v1/account/delete": { post: { tags: ["Account"], security: [{ bearerAuth: [] }], summary: "Schedule the workspace and all its data for deletion in 7 days (owner session only). `confirmName` is the workspace's exact name; `password`, or `code` when two-factor sign-in is on, re-confirms who is asking. The workspace keeps working until then, with campaigns paused", requestBody: j(obj({ confirmName: str, password: str, code: str }, ["confirmName"])), responses: ok(obj({ scheduledFor: str }, ["scheduledFor"])) } },
      "/v1/account/delete/cancel": { post: { tags: ["Account"], security: [{ bearerAuth: [] }], summary: "Cancel a pending workspace deletion (owner session only)", responses: ok(obj({ ok: bool })) } },
      "/v1/account/privacy": {
        get: { tags: ["Account"], summary: "Workspace privacy settings: whether AI assistance is on, and the mailing address added to the foot of campaign emails", responses: ok(obj({ aiAssist: bool, mailingAddress: str }, ["aiAssist", "mailingAddress"])) },
        patch: { tags: ["Account"], security: [{ bearerAuth: [] }], summary: "Change AI assistance or the mailing address (owner/admin session only). With AI assistance off, nothing about leads, prospects or replies is sent to an AI provider; features fall back to their built-in rules and templates", requestBody: j(obj({ aiAssist: bool, mailingAddress: { ...str, maxLength: 300 } })), responses: ok(obj({ aiAssist: bool, mailingAddress: str }, ["aiAssist", "mailingAddress"])) },
      },
      "/v1/campaigns/{id}/messages": { get: { tags: ["Outreach"], summary: "Messages of a campaign, newest first. A message to a person whose lead was deleted is kept without content: `toEmail` is null and `recipientRemoved` is true", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok(obj({ messages: arr({ type: "object", description: "id, direction, toEmail (nullable), recipientRemoved, subject, status, intent, sentAt, createdAt, ..." }) })) } },
      "/v1/leads/suppressions/all": { get: { tags: ["Leads"], summary: "The workspace's do-not-contact list. An entry for a removed contact has `email: null` and `recipientRemoved: true`", responses: ok(obj({ suppressions: arr({ type: "object", description: "id, email (nullable), recipientRemoved, reason, createdAt" }) })) } },
      "/v1/clients/{id}/share": { post: { tags: ["Clients"], summary: "Create the client report link, or replace it with a new one (owner/admin). `rotated` is true when an earlier link existed and has stopped working", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok(obj({ shareToken: str, rotated: bool }, ["shareToken", "rotated"])) } },
      "/v1/admin/suppressions": {
        get: { tags: ["Admin"], security: adminSec, summary: "The platform-wide do-not-contact list: addresses no workspace may email. `q` matches part of the address", parameters: [{ name: "q", in: "query", schema: { ...str, maxLength: 200 } }, { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } }], responses: ok(obj({ suppressions: arr(obj({ id: str, email: str, reason: str, note: { type: ["string", "null"] }, createdAt: str })) }, ["suppressions"])) },
        post: { tags: ["Admin"], security: adminSec, summary: "Add an address to the platform-wide list. Answers 201 when it was added and 200 when it was already there", requestBody: j(obj({ email: str, reason: str, note: str }, ["email"])), responses: ok(obj({ suppression: { type: "object" }, created: bool })) },
      },
      "/v1/admin/suppressions/{id}": { delete: { tags: ["Admin"], security: adminSec, summary: "Remove an address from the platform-wide list", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok(obj({ ok: bool })) } },
      "/v1/admin/data-subject": { get: { tags: ["Admin"], security: adminSec, summary: "Where one person's address appears: counts per workspace, and whether it is on the platform-wide list. No content is returned", parameters: [{ name: "email", in: "query", required: true, schema: str }], responses: ok(obj({ email: str, globallySuppressed: bool, held: { ...bool, description: "true when some workspace still holds the person: a lead, a campaign contact, or a message that still carries the address" }, workspaces: arr(obj({ orgId: str, orgName: str, leads: { type: "integer" }, campaignContacts: { type: "integer" }, messages: { type: "integer", description: "messages that still carry the address" }, anonymisedMessages: { type: "integer", description: "message records kept without content after an erase" }, suppressed: bool })) }, ["email", "globallySuppressed", "held", "workspaces"])) } },
      "/v1/admin/data-subject/erase": { post: { tags: ["Admin"], security: adminSec, summary: "Erase a person from every workspace and add their address to the platform-wide list. `confirm` must repeat the address. Cannot be undone", requestBody: j(obj({ email: str, confirm: str }, ["email", "confirm"])), responses: ok(obj({ ok: bool, workspaces: { type: "integer" }, leadsDeleted: { type: "integer" }, globallySuppressed: bool })) } },
      "/v1/admin/audit-log": {
        get: {
          tags: ["Admin"],
          security: adminSec,
          summary: "The security log across every workspace, newest first, including rows that belong to no workspace (admin sign-ins). Filters combine. `action` is an exact name, or a prefix ending in `*` (\"auth.*\"). An empty filter value means no filter. Page with `before` = the previous page's `nextBefore`",
          parameters: [
            { name: "orgId", in: "query", schema: { ...str, format: "uuid" } },
            { name: "action", in: "query", schema: { ...str, maxLength: 100 } },
            { name: "result", in: "query", schema: { ...str, enum: ["ok", "denied", "failed"] } },
            { name: "actorType", in: "query", schema: { ...str, enum: ["user", "api_key", "admin", "system", "anonymous"] } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
            { name: "before", in: "query", schema: str, description: "nextBefore from the previous page" },
          ],
          responses: ok(
            obj(
              {
                entries: arr(obj({ id: str, orgId: { type: ["string", "null"] }, orgName: { type: ["string", "null"] }, action: str, actorType: str, actorEmail: { type: ["string", "null"] }, targetType: { type: ["string", "null"] }, targetId: { type: ["string", "null"] }, result: { ...str, enum: ["ok", "denied", "failed"] }, ip: { type: ["string", "null"] }, createdAt: str, data: { type: "object" } })),
                hasMore: bool,
                nextBefore: { type: ["string", "null"] },
              },
              ["entries", "hasMore", "nextBefore"],
            ),
          ),
        },
      },
      "/v1/admin/security/summary": {
        get: {
          tags: ["Admin"],
          security: adminSec,
          summary: "The last 24 hours in numbers: failed sign-ins, accounts refused by a lock, refused actions, admin sign-ins, new workspaces, data exports, bulk deletions, the five addresses with the most failed sign-ins - and how many workspaces are currently waiting to be deleted (not limited to 24 hours)",
          responses: ok(
            obj(
              {
                window: { ...str, enum: ["24h"] },
                failedLogins: { type: "integer" },
                lockedAccounts: { type: "integer" },
                deniedActions: { type: "integer" },
                adminLogins: { type: "integer" },
                newWorkspaces: { type: "integer" },
                exports: { type: "integer" },
                bulkDeletes: { type: "integer" },
                pendingDeletions: { type: "integer" },
                topFailingIps: arr(obj({ ip: str, count: { type: "integer" } }, ["ip", "count"])),
              },
              ["window", "failedLogins", "lockedAccounts", "deniedActions", "adminLogins", "newWorkspaces", "exports", "bulkDeletes", "pendingDeletions", "topFailingIps"],
            ),
          ),
        },
      },
      "/v1/admin/orgs/{id}/users/{userId}/reset-2fa": {
        post: {
          tags: ["Admin"],
          security: adminSec,
          summary: "Turn a user's two-factor sign-in off, for support: the way back in for someone who has lost both their authenticator and their recovery codes. Their password alone then signs them in. Written to the workspace's security log and emailed to the user. `changed` is false when two-factor was not on",
          parameters: [{ name: "id", in: "path", required: true, schema: str }, { name: "userId", in: "path", required: true, schema: str }],
          responses: ok(obj({ userId: str, twoFactorEnabled: bool, changed: bool, note: str }, ["userId", "twoFactorEnabled", "changed"])),
        },
      },
      "/v1/admin/logout": {
        post: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Sign the admin session out: the presented token is revoked and refused from the next request on. With the server-to-server token header (not a session) nothing is revoked and `revoked` is false",
          responses: ok(obj({ ok: bool, revoked: bool, note: str }, ["ok", "revoked"])),
        },
      },
      "/v1/admin/orgs": { get: { tags: ["Admin"], security: [{ bearerAuth: [] }], summary: "Workspaces, newest first. `q` matches the name, slug or a member's email as literal text (% and _ are not wildcards). Each row carries `pendingDeletionAt`: when the workspace is due to be deleted at its owner's request, or null", parameters: [{ name: "q", in: "query", schema: { ...str, maxLength: 200 } }], responses: ok(obj({ orgs: arr({ type: "object", description: "id, name, slug, plan, status, createdAt, leadsUsed, premiumLeadsUsed, userCount, ownerEmail, ownerName, limits, pendingDeletionAt" }) })) } },
      "/v1/admin/orgs/{id}": {
        get: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "One workspace: its users (with whether each has two-factor sign-in on and a verified address), this month's usage, its effective limits and its overrides",
          parameters: [{ name: "id", in: "path", required: true, schema: str }],
          responses: ok(obj({ org: { type: "object", description: "Includes `limits` (plan defaults with overrides applied), `overrides` and `pendingDeletionAt`" }, overrides: { type: "object", description: "The workspace's limits that differ from its plan's defaults; empty when it simply has the plan's limits" }, users: arr(obj({ id: str, email: str, name: str, role: str, lastLoginAt: { type: ["string", "null"] }, createdAt: str, twoFactorEnabled: bool, emailVerified: bool })), usage: { type: "object" }, period: str })),
        },
      },
      "/v1/admin/orgs/{id}/plan": {
        patch: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Change a workspace's plan and/or its limit overrides. `plan` must be one of the plan ids from /v1/admin/plans. Existing overrides are kept when `overrides` is omitted; pass `overrides` to replace them, or `{}` to clear them. Unknown override keys and values of the wrong kind are a 400, and so is an override for a limit the server does not enforce yet (`campaigns`, `apiAccess`, `integrations`)",
          parameters: [{ name: "id", in: "path", required: true, schema: str }],
          requestBody: j(
            obj(
              {
                plan: { ...str, enum: ["free", "pilot", "starter", "growth", "scale", "enterprise"] },
                overrides: {
                  type: "object",
                  additionalProperties: false,
                  description: "Strict partial of the plan limits the server enforces. Counts are whole numbers from 0 (0 = no limit for the monthly metrics; for premiumLeadsPerMonth 0 means none)",
                  properties: Object.fromEntries([
                    ...["leadsPerMonth", "premiumLeadsPerMonth", "searchesPerMonth", "verificationsPerMonth", "aiMessagesPerMonth", "emailsPerMonth", "seats"].map((k) => [k, { type: "integer", minimum: 0, maximum: 1000000000 }]),
                    ["emailsPerDay", { type: "integer", minimum: 1, maximum: 1000000000, description: "Daily sending ceiling for this workspace" }],
                  ]),
                },
              },
              ["plan"],
            ),
          ),
          responses: ok(obj({ id: str, plan: str, limits: { type: "object" }, overrides: { type: "object" }, changed: bool, note: str }, ["id", "plan", "limits", "overrides", "changed"])),
        },
      },
      "/v1/admin/orgs/{id}/status": {
        patch: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Activate, deactivate or revoke a workspace",
          parameters: [{ name: "id", in: "path", required: true, schema: str }],
          requestBody: j(obj({ status: { ...str, enum: ["active", "deactivated", "revoked"] } }, ["status"])),
          responses: ok(obj({ id: str, status: str, changed: bool }, ["id", "status", "changed"])),
        },
      },
      "/v1/admin/orgs/{id}/credits": {
        patch: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Adjust this month's used-count for one metric. `grant` gives usage back (a negative amount adds usage); `set` pins the used-count. The result never goes below 0, and `note` says so when the request asked for more than could be done. Granting does not raise the plan's allowance - use a plan override for that",
          parameters: [{ name: "id", in: "path", required: true, schema: str }],
          requestBody: j(
            obj(
              {
                metric: { ...str, enum: ["leads", "premiumLeads", "searches", "verifications", "aiMessages", "emails"] },
                action: { ...str, enum: ["grant", "set"], description: "Also accepted as `mode`" },
                amount: { type: "integer", minimum: -1000000, maximum: 1000000 },
              },
              ["metric", "action", "amount"],
            ),
          ),
          responses: ok(obj({ metric: str, period: str, used: { type: "integer" }, limit: { type: ["integer", "null"], description: "The allowance this is measured against; null when the plan has no limit for this metric" }, changed: bool, note: str }, ["metric", "period", "used", "limit", "changed"])),
        },
      },
      "/v1/admin/upgrade-requests": {
        get: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Upgrade requests from the pricing page, newest first. `orgId` and `orgName` are the workspace the request came from, or null when the person was not signed in",
          parameters: [{ name: "status", in: "query", schema: { ...str, enum: ["new", "contacted", "converted", "dismissed"] } }],
          responses: ok(obj({ requests: arr(obj({ id: str, orgId: { type: ["string", "null"] }, orgName: { type: ["string", "null"] }, name: str, email: str, mobile: str, country: str, planId: str, message: { type: ["string", "null"] }, status: str, createdAt: str })) })),
        },
      },
      "/v1/admin/upgrade-requests/{id}": {
        patch: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Set an upgrade request's status",
          parameters: [{ name: "id", in: "path", required: true, schema: str }],
          requestBody: j(obj({ status: { ...str, enum: ["new", "contacted", "converted", "dismissed"] } }, ["status"])),
          responses: ok({ type: "object", description: "The request, plus `changed`" }),
        },
      },
      "/v1/admin/tools/check": {
        post: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Test every configured provider key with one free or minimal call. `summary` says how many were tested and passed, and `testedCount` (the same number as `tested`) is that count: it leaves out retired providers, which are still listed in `results` with `retired: true`; `notTested` lists providers that hold a key but have no free test call, with the reason. With no key configured the summary is \"No provider keys are configured, so nothing was tested.\"",
          responses: ok(obj({ results: arr({ type: "object" }), checkedAt: str, retired: arr(), tested: { type: "integer" }, testedCount: { type: "integer", description: "How many provider keys were tested, as the summary counts them (retired providers excluded)" }, passed: { type: "integer" }, skippedRetired: arr(), notTested: arr(obj({ provider: str, label: str, reason: str })), summary: str })),
        },
      },
      "/v1/admin/tools/{provider}": {
        patch: {
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          summary: "Set a provider's usage limit, period, alert threshold or notes",
          parameters: [{ name: "provider", in: "path", required: true, schema: str }],
          requestBody: j(obj({ usageLimit: { type: ["integer", "null"], minimum: 0, maximum: 1000000000 }, period: { ...str, enum: ["day", "month"] }, alertThresholdPct: { type: "integer", minimum: 1, maximum: 100 }, notes: { type: ["string", "null"], maxLength: 2000 } })),
          responses: ok({ type: "object", description: "The provider's row, plus `changed`" }),
        },
      },
      "/v1/auth/me": {
        get: {
          tags: ["Auth"],
          summary: "Current identity + plan limits. `user.emailVerified` and `user.twoFactorEnabled` describe the signed-in person; `emailVerificationAvailable` (also on `org`) is false when the platform cannot send the confirmation link, and then nothing is restricted for an unverified address",
          responses: ok(
            obj({
              user: { type: ["object", "null"], description: "null for an API key. id, email, name, role, createdAt, hasPassword, emailVerified, hasGoogle, twoFactorEnabled, twoFactorEnabledAt" },
              org: { type: "object", description: "id, name, slug, plan, limits, settings, createdAt, emailVerificationAvailable" },
              via: { ...str, enum: ["jwt", "api_key"] },
              apiKey: { type: ["object", "null"], description: "For an API key: id, name, prefix, scope (\"full\" or \"read\")" },
              emailVerificationAvailable: bool,
            }),
          ),
        },
      },
      "/v1/auth/api-keys": {
        get: { tags: ["Auth"], summary: "List API keys. `scope` is \"full\" or \"read\"", security: [{ bearerAuth: [] }], responses: ok(obj({ apiKeys: arr(obj({ id: str, name: str, prefix: str, scope: { ...str, enum: ["full", "read"] }, scopes: arr(), lastUsedAt: { type: ["string", "null"] }, revokedAt: { type: ["string", "null"] }, createdAt: str })) })) },
        post: {
          tags: ["Auth"],
          summary: "Create API key (owner/admin). `scope` \"read\" makes a read-only key: it may only make GET and HEAD requests, and anything else answers 403 insufficient_scope. Default \"full\". The key is returned once",
          security: [{ bearerAuth: [] }],
          requestBody: j(obj({ name: str, scope: { ...str, enum: ["full", "read"], default: "full" } }, ["name"])),
          responses: { "201": { description: "Created", ...j(obj({ id: str, name: str, prefix: str, scope: { ...str, enum: ["full", "read"] }, key: { ...str, description: "Shown once; store it now" }, note: str })) } },
        },
      },
      "/v1/search": {
        post: { tags: ["Discovery"], summary: "Start a lead search (async). Discovers people, enriches companies, finds + verifies emails, scores against ICP, saves leads.", requestBody: j(searchBody), responses: { "202": { description: "Queued", ...j(obj({ search: { type: "object" }, jobId: str, poll: str })) } } },
        get: { tags: ["Discovery"], summary: "Recent searches", responses: ok() },
      },
      "/v1/search/{id}": { get: { tags: ["Discovery"], summary: "Search status + resulting lead ids", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok(obj({ search: { type: "object" }, job: { type: "object" }, leadIds: arr() })) } },
      "/v1/search/quick": { post: { tags: ["Discovery"], summary: "Synchronous quick prospect (≤10 results, 5-40s). Ideal for agents.", requestBody: j({ ...searchBody, properties: { ...searchBody.properties, limit: { type: "integer", default: 5, maximum: 10 }, save: { ...bool, default: false } } }), responses: ok(obj({ results: arr({ type: "object" }) })) } },
      "/v1/search/parse": { post: { tags: ["Discovery"], summary: "Parse natural-language query into structured filters. With AI assistance off for the workspace the built-in parser is used, nothing is charged, and the answer carries `aiOff: true` and a `note`", requestBody: j(obj({ query: str }, ["query"])), responses: ok() } },
      "/v1/search/people": { post: { tags: ["Discovery"], summary: "Find people at a company", requestBody: j(obj({ companyName: str, companyDomain: str, titles: arr(), locations: arr(), limit: { type: "integer", default: 10 } })), responses: ok() } },
      "/v1/search/companies": { post: { tags: ["Discovery"], summary: "Find companies matching a description", requestBody: j(obj({ query: str, industries: arr(), locations: arr(), keywords: arr(), limit: { type: "integer", default: 20 }, resolveDomains: { ...bool, default: true } })), responses: ok() } },
      "/v1/search/company/enrich": { post: { tags: ["Enrichment"], summary: "Enrich a company by domain (website crawl: description, emails, tech stack, team, socials)", requestBody: j(obj({ domain: str }, ["domain"])), responses: ok() } },
      "/v1/search/verify": { post: { tags: ["Enrichment"], summary: "Verify email(s): syntax, disposable, MX, SMTP handshake, catch-all", requestBody: j(obj({ email: str, emails: arr() })), responses: ok() } },
      "/v1/search/find-email": { post: { tags: ["Enrichment"], summary: "Find a work email from name + domain", requestBody: j(obj({ firstName: str, lastName: str, domain: str }, ["firstName", "lastName", "domain"])), responses: ok() } },
      "/v1/search/jobs/{jobId}": { get: { tags: ["Discovery"], summary: "Job status", parameters: [{ name: "jobId", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/leads": {
        get: { tags: ["Leads"], summary: "List leads with filters", parameters: ["q", "emailStatus", "minScore", "tag", "icpId", "listId", "companyDomain", "seniority", "department", "hasEmail", "sort", "order", "limit", "offset"].map((n) => ({ name: n, in: "query", schema: str })), responses: ok() },
        post: { tags: ["Leads"], summary: "Create/upsert a lead. An address on the platform-wide do-not-contact list is refused with 409 `suppressed` (a lead the workspace already holds is still updated)", requestBody: j(leadBody), responses: ok() },
      },
      "/v1/leads/import": { post: { tags: ["Leads"], summary: "Bulk import (JSON array or CSV body). Rows whose address is on the platform-wide do-not-contact list are skipped: counted in `skippedDoNotContact` and listed in `skippedRows` with `code: \"do_not_contact\"`", requestBody: { content: { "application/json": { schema: arr(leadBody) }, "text/csv": { schema: str } } }, responses: ok() } },
      "/v1/leads/export.csv": { get: { tags: ["Leads"], summary: "Export CSV (same filters as list)", responses: { "200": { description: "CSV" } } } },
      "/v1/leads/{id}": {
        get: { tags: ["Leads"], summary: "Get lead with company", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() },
        patch: { tags: ["Leads"], summary: "Update lead", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(leadBody), responses: ok() },
        delete: { tags: ["Leads"], summary: "Delete lead", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() },
      },
      "/v1/leads/{id}/enrich": { post: { tags: ["Enrichment"], summary: "Queue enrichment (company crawl + email find/verify + rescore)", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: { "202": { description: "Queued" } } } },
      "/v1/leads/{id}/verify": { post: { tags: ["Enrichment"], summary: "Verify lead email now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/leads/{id}/find-email": { post: { tags: ["Enrichment"], summary: "Find lead email now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/leads/bulk/enrich": { post: { tags: ["Enrichment"], summary: "Queue enrichment for many leads", requestBody: j(obj({ ids: arr() }, ["ids"])), responses: { "202": { description: "Queued" } } } },
      "/v1/leads/bulk/tag": { post: { tags: ["Leads"], summary: "Add/remove tags", requestBody: j(obj({ ids: arr(), add: arr(), remove: arr() }, ["ids"])), responses: ok() } },
      "/v1/leads/lists/all": { get: { tags: ["Lists"], summary: "List lists", responses: ok() } },
      "/v1/leads/lists": { post: { tags: ["Lists"], summary: "Create list", requestBody: j(obj({ name: str, description: str }, ["name"])), responses: ok() } },
      "/v1/leads/lists/{listId}/leads": { post: { tags: ["Lists"], summary: "Add leads to list", parameters: [{ name: "listId", in: "path", required: true, schema: str }], requestBody: j(obj({ ids: arr() }, ["ids"])), responses: ok() } },
      "/v1/icps": {
        get: { tags: ["ICP"], summary: "List ideal customer profiles", responses: ok() },
        post: { tags: ["ICP"], summary: "Create ICP; AI builds lookalike criteria from description + seed customer domains", requestBody: j(obj({ name: str, description: str, product: str, seedDomains: arr(), criteria: { type: "object" }, buildWithAi: { ...bool, default: true } }, ["name"])), responses: ok() },
      },
      "/v1/icps/{id}/score": { post: { tags: ["ICP"], summary: "Score leads against ICP (rules + optional AI re-rank)", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ leadIds: arr(), assign: bool, aiRerankTop: { type: "integer", default: 0 } })), responses: ok() } },
      "/v1/campaigns": {
        get: { tags: ["Outreach"], summary: "List campaigns", responses: ok() },
        post: { tags: ["Outreach"], summary: "Create campaign with sequence steps", requestBody: j(obj({ name: str, icpId: str, listId: str, emailAccountId: str, settings: { type: "object" }, steps: arr(obj({ delayDays: num, subjectTemplate: str, bodyTemplate: str, aiPersonalize: bool, aiInstructions: str })) }, ["name"])), responses: ok() },
      },
      "/v1/campaigns/generate": { post: { tags: ["Outreach"], summary: "Generate an AI-personalized email for a lead (no campaign needed)", requestBody: j(obj({ leadId: str, lead: { type: "object" }, sender: obj({ name: str, company: str, title: str, valueProp: str, signature: str, tone: str }, ["name", "company", "valueProp"]), instructions: str, stepNo: num, language: str }, ["sender"])), responses: ok(obj({ subject: str, body: str, personalized: bool })) } },
      "/v1/campaigns/inbound": { post: { tags: ["Outreach"], summary: "Ingest an inbound reply (stops sequence, classifies intent)", requestBody: j(obj({ from: str, text: str, subject: str }, ["from"])), responses: ok() } },
      "/v1/campaigns/email-accounts": { get: { tags: ["Outreach"], summary: "List sender accounts", responses: ok() }, post: { tags: ["Outreach"], summary: "Add sender (Resend / SMTP / system)", requestBody: j(obj({ provider: { ...str, enum: ["resend", "smtp", "system"] }, fromName: str, fromEmail: str, replyTo: str, signature: str, dailyLimit: num, config: { type: "object" } }, ["provider", "fromName", "fromEmail"])), responses: ok() } },
      "/v1/campaigns/{id}/enroll": { post: { tags: ["Outreach"], summary: "Enroll leads", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ leadIds: arr(), fromList: bool, minScore: num })), responses: ok({ type: "object", description: "Enrollment counts. `skippedInvalidEmail` is the number of leads left out because their stored email is not one valid address", properties: { skippedInvalidEmail: { type: "integer" } } }) } },
      "/v1/campaigns/{id}/start": { post: { tags: ["Outreach"], summary: "Start campaign", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/campaigns/{id}/pause": { post: { tags: ["Outreach"], summary: "Pause campaign", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/campaigns/{id}/preview": { post: { tags: ["Outreach"], summary: "Preview personalized copy for a lead", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ leadId: str, stepNo: num }, ["leadId"])), responses: ok() } },
      "/v1/campaigns/{id}/stats": { get: { tags: ["Outreach"], summary: "Campaign stats", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/usage": { get: { tags: ["Account"], summary: "Monthly usage vs plan limits", responses: ok() } },
      "/v1/analytics/overview": { get: { tags: ["Account"], summary: "Dashboard analytics", responses: ok() } },
      "/v1/events": { get: { tags: ["Account"], summary: "Event log", responses: ok() } },
      "/v1/webhooks": { get: { tags: ["Account"], summary: "List webhooks", responses: ok() }, post: { tags: ["Account"], summary: "Create webhook (HMAC-signed; events: lead.created, lead.enriched, lead.verified, lead.replied, search.completed, message.sent/opened/clicked, campaign.started, *)", requestBody: j(obj({ url: str, events: arr() }, ["url"])), responses: ok() } },
      "/v1/integrations": { get: { tags: ["Account"], summary: "List CRM integrations", responses: ok() } },
      "/v1/integrations/{provider}": { put: { tags: ["Account"], summary: "Configure CRM integration (hubspot | pipedrive | zoho | cortex | webhook | sheets)", parameters: [{ name: "provider", in: "path", required: true, schema: str }], requestBody: j(obj({ config: { type: "object" }, autoSync: bool }, ["config"])), responses: ok() } },
      "/v1/integrations/{provider}/sync": { post: { tags: ["Account"], summary: "Push leads to CRM", parameters: [{ name: "provider", in: "path", required: true, schema: str }], requestBody: j(obj({ leadIds: arr() }, ["leadIds"])), responses: { "202": { description: "Queued" } } } },
      "/px/{key}.js": { get: { tags: ["Visitors"], security: [], summary: "Website visitor pixel script (embed on your site)", parameters: [{ name: "key", in: "path", required: true, schema: str }], responses: { "200": { description: "JavaScript" } } } },
      "/v1/visitors/pixels": { get: { tags: ["Visitors"], summary: "List pixels + embed snippets", responses: ok() }, post: { tags: ["Visitors"], summary: "Create a pixel for a website", requestBody: j(obj({ name: str, allowedDomains: arr() }, ["name"])), responses: ok() } },
      "/v1/visitors": { get: { tags: ["Visitors"], summary: "Identified visiting companies sorted by intent (ISPs/hosting filtered)", parameters: [{ name: "days", in: "query", schema: num }, { name: "status", in: "query", schema: str }], responses: ok() } },
      "/v1/visitors/{domain}/decision-makers": { post: { tags: ["Visitors"], summary: "Find + save decision makers at a visiting company", parameters: [{ name: "domain", in: "path", required: true, schema: str }], requestBody: j(obj({ titles: arr(), limit: num, save: bool })), responses: ok() } },
      "/v1/signals": { get: { tags: ["Signals"], summary: "Intent signal feed (funding, acquisition, hiring, leadership, expansion, launch, partnership)", parameters: ["type", "q", "matched", "days", "limit"].map((n) => ({ name: n, in: "query", schema: str })), responses: ok() } },
      "/v1/signals/scan": { post: { tags: ["Signals"], summary: "Scan news now for signals", requestBody: j(obj({ types: arr(), keywords: arr(), industries: arr(), locations: arr(), days: num })), responses: ok() } },
      "/v1/signals/subscriptions": { get: { tags: ["Signals"], summary: "List subscriptions", responses: ok() }, post: { tags: ["Signals"], summary: "Subscribe: scan every 6h, auto-create decision-maker leads, optionally enroll in a campaign", requestBody: j(obj({ name: str, types: arr(), keywords: arr(), industries: arr(), locations: arr(), targetTitles: arr(), autoCreateLeads: bool, icpId: str, campaignId: str }, ["name", "types"])), responses: ok() } },
      "/v1/signals/subscriptions/{id}/run": { post: { tags: ["Signals"], summary: "Run a subscription now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/signals/monitors": { get: { tags: ["Signals"], summary: "List monitors", responses: ok() }, post: { tags: ["Signals"], summary: "Create monitor: linkedin_post (engagers → leads) | keyword | competitor | company_news | jobs", requestBody: j(obj({ type: str, name: str, target: str, config: { type: "object" }, intervalMinutes: num }, ["type", "name", "target"])), responses: ok() } },
      "/v1/signals/monitors/{id}/run": { post: { tags: ["Signals"], summary: "Run monitor now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/signals/monitors/{id}/results": { get: { tags: ["Signals"], summary: "Monitor results", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: ok() } },
      "/v1/tools/linkedin-to-email": { post: { tags: ["Tools"], summary: "LinkedIn URLs → person + verified work email", requestBody: j(obj({ urls: arr(), save: bool }, ["urls"])), responses: ok() } },
      "/v1/tools/email-to-linkedin": { post: { tags: ["Tools"], summary: "Emails → LinkedIn profiles", requestBody: j(obj({ emails: arr() }, ["emails"])), responses: ok() } },
      "/v1/tools/colleagues": { post: { tags: ["Tools"], summary: "Colleagues of a lead / people at a domain", requestBody: j(obj({ leadId: str, companyDomain: str, titles: arr(), limit: num, save: bool })), responses: ok() } },
      "/v1/tools/decision-makers": { post: { tags: ["Tools"], summary: "Decision makers at a company by persona, with emails", requestBody: j(obj({ companyDomain: str, companyName: str, personas: arr(), limit: num, findEmails: bool, save: bool })), responses: ok() } },
      "/v1/tools/personas": { get: { tags: ["Tools"], summary: "Persona → title mappings", responses: ok() } },
      "/v1/tools/company-intel": { post: { tags: ["Tools"], summary: "Company intelligence: hiring by function, recent news signals, intent score", requestBody: j(obj({ domain: str }, ["domain"])), responses: ok() } },
      "/v1/tools/domain-health": { get: { tags: ["Tools"], summary: "Sender domain SPF/DKIM/DMARC/MX check", parameters: [{ name: "domain", in: "query", required: true, schema: str }], responses: ok() } },
      "/v1/tools/verify-batch": { post: { tags: ["Tools"], summary: "Verify up to 500 emails", requestBody: j(obj({ emails: arr() }, ["emails"])), responses: ok() } },
      "/v1/tools/batch-enrich": { post: { tags: ["Tools"], summary: "Queue enrichment for many leads / a list", requestBody: j(obj({ leadIds: arr(), listId: str, onlyMissingEmail: bool, limit: num })), responses: { "202": { description: "Queued" } } } },
      "/v1/tools/saved-searches": { get: { tags: ["Tools"], summary: "Saved searches", responses: ok() }, post: { tags: ["Tools"], summary: "Save a search (optionally daily alert + list)", requestBody: j(obj({ name: str, query: { type: "object" }, alert: bool, alertEmail: str, listId: str }, ["name", "query"])), responses: ok() } },
      "/v1/tools/tasks": { get: { tags: ["Tools"], summary: "Tasks (manual sequence steps)", parameters: [{ name: "status", in: "query", schema: str }], responses: ok() }, post: { tags: ["Tools"], summary: "Create task", requestBody: j(obj({ leadId: str, type: str, title: str, body: str, dueAt: str }, ["title"])), responses: ok() } },
      "/v1/tools/tasks/{id}/complete": { post: { tags: ["Tools"], summary: "Complete/skip a task; advances the sequence", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ outcome: str, note: str })), responses: ok() } },
      "/v1/tools/team": { get: { tags: ["Account"], summary: "Team members + seats", responses: ok() } },
      "/v1/tools/team/invite": { post: { tags: ["Account"], summary: "Invite a teammate", requestBody: j(obj({ email: str, role: str }, ["email"])), responses: ok() } },
      "/v1/tools/autopilots": { get: { tags: ["Autopilot"], summary: "List autopilots", responses: ok() }, post: { tags: ["Autopilot"], summary: "Create an autonomous daily prospecting agent", requestBody: j(obj({ name: str, query: { type: "object" }, icpId: str, listId: str, campaignId: str, dailyLeads: num, minScore: num, requireValidEmail: bool, autoEnroll: bool, runHourUtc: num }, ["name", "query"])), responses: ok() } },
      "/v1/tools/autopilots/{id}/run": { post: { tags: ["Autopilot"], summary: "Run now", parameters: [{ name: "id", in: "path", required: true, schema: str }], responses: { "202": { description: "Queued" } } } },
      "/v1/tools/leads/{id}/status": { post: { tags: ["Leads"], summary: "Set pipeline status (new|contacted|engaged|replied|qualified|customer|lost)", parameters: [{ name: "id", in: "path", required: true, schema: str }], requestBody: j(obj({ status: str }, ["status"])), responses: ok() } },
      // ── Plays. Static paths (types, plan, candidates, performance) are matched before /{id}. ──
      "/v1/plays/types": {
        get: {
          tags: ["Plays"],
          summary: "The seven kinds of play: what each finds, the settings it takes (`fields`, for building a form) and whether it can work in this workspace yet. `available` is false with a plain `unavailableReason` when it cannot (website_visitors without the tracking snippet installed; job_changes when the plan cannot check anyone). A type that depends on public search stays available and carries a `setupHint` when results may be thin",
          responses: ok(
            obj(
              {
                types: arr(
                  obj(
                    {
                      type: playType,
                      name: str,
                      summary: str,
                      finds: { ...str, enum: ["people", "companies", "conversations"] },
                      needsSearch: bool,
                      available: bool,
                      unavailableReason: str,
                      setupHint: str,
                      fields: arr(obj({ key: str, label: str, kind: { ...str, enum: ["tags", "text", "number", "competitors", "select"] }, options: arr({}), required: bool, max: num, placeholder: str, help: str }, ["key", "label", "kind"])),
                      defaultTitles: arr(),
                    },
                    ["type", "name", "summary", "finds", "needsSearch", "available", "fields"],
                  ),
                ),
              },
              ["types"],
            ),
          ),
        },
      },
      "/v1/plays/plan": {
        post: {
          tags: ["Plays"],
          summary: "Read a website and suggest plays for it: what the product is, who buys it, its competitors, and ready-to-create plays with the reason for each. Saves nothing. Uses one search unit; AI messages are counted only when a model actually ran. At most 6 a minute (429 after that)",
          requestBody: j(obj({ website: { ...str, description: "The company's website, e.g. acme.com" } }, ["website"])),
          responses: {
            ...ok(
              obj(
                {
                  product: obj({ domain: str, name: str, description: str }, ["domain"]),
                  icp: { type: "object", description: "ICP criteria: industries, titles, seniorities, departments, companySizes, locations, countries, keywords, excludeKeywords, techStack (each a list of strings, all optional)" },
                  titles: arr(),
                  competitors: arr(obj({ name: str, domain: str, source: { ...str, enum: ["saved", "site", "ai"], description: "saved: from the workspace's settings. site: named on the website itself. ai: suggested by a model" } }, ["name", "source"])),
                  plays: arr(obj({ type: playType, name: str, config: { type: "object", description: "Ready to send to POST /v1/plays" }, targetTitles: arr(), why: str, available: bool, unavailableReason: str }, ["type", "name", "config", "targetTitles", "why", "available"])),
                  notes: { ...arr(), description: "Plain sentences about what could and could not be read" },
                },
                ["product", "icp", "titles", "competitors", "plays", "notes"],
              ),
            ),
            ...res("402", "quota_exceeded: no search units left this month", errorBody),
            ...res("429", "rate_limited", errorBody),
          },
        },
      },
      "/v1/plays": {
        get: { tags: ["Plays"], summary: "The workspace's plays, each with its candidate counts and the result of its last run", responses: ok(obj({ plays: arr(playOut) }, ["plays"])) },
        post: {
          tags: ["Plays"],
          summary: "Create a play. `config` is checked against `type`. Every id must belong to this workspace (404 otherwise). Creating a play finds nobody: run it, or set `runEveryHours`. At most 200 plays per workspace",
          requestBody: j({ description: "One shape per type of play: `config` is the settings that type takes", oneOf: PLAY_TYPE_IDS.map((t) => ({ title: t, ...obj({ ...playInputProps, type: { ...str, const: t }, config: playConfigs[t] }, ["name", "type", "config"]) })) }),
          responses: { "201": { description: "Created", ...j(obj({ play: playOut }, ["play"])) }, ...res("400", "validation_error", errorBody), ...res("404", "A referenced ICP, client, list or campaign was not found", errorBody) },
        },
      },
      "/v1/plays/candidates": {
        get: {
          tags: ["Plays"],
          summary: "The review queue: what plays have found, each with its reason and evidence. Newest first; pending candidates come highest score first, then newest. `counts` is the workspace-wide number in each state",
          parameters: [
            { name: "status", in: "query", schema: { ...str, enum: ["pending", "approved", "skipped"] } },
            { name: "playId", in: "query", schema: uuid },
            { name: "kind", in: "query", schema: { ...str, enum: ["person", "company", "post"] } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 200 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0, minimum: 0 } },
          ],
          responses: ok(obj({ candidates: arr(candidateOut), total: int, counts: playCounts }, ["candidates", "total", "counts"])),
        },
      },
      "/v1/plays/candidates/decide": {
        post: {
          tags: ["Plays"],
          summary: "Approve or skip up to 200 candidates. Approving a person creates a lead that carries the reason and the evidence link (one lead unit when the person is new; none when they were already a lead). Approving a company saves the company. Approving a post creates a task to answer that conversation, never a lead. Skipping only marks the candidate. Approving sends nothing. With `enroll: true`, approved people are also added to the play's campaign: those with a usable address now (`enrolled`), the others after their address has been found (`queuedForEmail`). Being added to a campaign does not start it. A decision for a candidate that is not pending, or not this workspace's, is listed in `notApplied` and changes nothing. When the plan's lead allowance runs out the batch stops, the rest stay pending, and `stopped` says so",
          requestBody: j(
            obj(
              {
                decisions: { type: "array", minItems: 1, maxItems: 200, items: obj({ id: uuid, decision: { ...str, enum: ["approve", "skip"] }, skipReason: { ...str, maxLength: 200 } }, ["id", "decision"]) },
                enroll: { ...bool, default: false },
              },
              ["decisions"],
            ),
          ),
          responses: ok(
            obj(
              {
                approved: int,
                skipped: int,
                leadsCreated: int,
                leadsExisting: int,
                tasksCreated: int,
                enrolled: int,
                queuedForEmail: int,
                notApplied: arr(obj({ id: str, reason: str }, ["id", "reason"])),
                stopped: obj({ reason: { ...str, enum: ["quota", "error"] }, message: str }, ["reason", "message"]),
              },
              ["approved", "skipped", "leadsCreated", "leadsExisting", "tasksCreated", "enrolled", "queuedForEmail", "notApplied"],
            ),
          ),
        },
      },
      "/v1/plays/candidates/{id}/find-people": {
        post: {
          tags: ["Plays"],
          summary: "For a company candidate: find people there. Each one is added to the same play's queue as a person candidate with the company's reason and evidence. Only for company candidates. Uses one search unit. At most 12 a minute",
          parameters: [idParam("The company candidate")],
          requestBody: j(obj({ titles: { ...tagList(10), description: "Defaults to the play's target titles" }, limit: { type: "integer", minimum: 1, maximum: 5, default: 3 } })),
          responses: { ...ok(obj({ added: int, candidates: arr(candidateOut), note: str }, ["added", "candidates"])), ...res("402", "quota_exceeded: no search units left this month", errorBody) },
        },
      },
      "/v1/plays/performance": {
        get: {
          tags: ["Plays"],
          summary: "What each play led to in the last `days`: found (candidates created), approved, contacted (approved people sent at least one message), replied, positive (a reply classified as interested or a referral). Rates are over the people contacted and are null when nobody was. `sufficient` is false until 20 people from a play have been contacted: before that the rates are too small a sample to compare. `best` is chosen only among sufficient plays and is null when there is none - `note` then says more sends are needed",
          parameters: [{ name: "days", in: "query", schema: { type: "integer", minimum: 7, maximum: 365, default: 90 } }],
          responses: ok(
            obj(
              {
                days: int,
                plays: arr(
                  obj(
                    { playId: uuid, name: str, type: playType, found: int, pending: int, approved: int, skipped: int, leads: int, contacted: int, replied: int, positive: int, replyRate: { type: ["number", "null"] }, positiveRate: { type: ["number", "null"] }, sufficient: bool },
                    ["playId", "name", "type", "found", "pending", "approved", "skipped", "leads", "contacted", "replied", "positive", "replyRate", "positiveRate", "sufficient"],
                  ),
                ),
                best: { type: ["object", "null"], properties: { playId: uuid, name: str, why: str }, required: ["playId", "name", "why"] },
                note: str,
              },
              ["days", "plays", "best"],
            ),
          ),
        },
      },
      "/v1/plays/{id}": {
        get: { tags: ["Plays"], summary: "One play with its last 10 runs", parameters: [idParam("The play")], responses: ok(obj({ play: playOut, runs: arr(playRunOut) }, ["play", "runs"])) },
        patch: { tags: ["Plays"], summary: "Change a play. The same fields as creating one, all optional; at least one is needed", parameters: [idParam("The play")], requestBody: j(obj(playInputProps)), responses: { ...ok(obj({ play: playOut }, ["play"])), ...res("400", "validation_error", errorBody) } },
        delete: { tags: ["Plays"], summary: "Delete a play and its candidates. Leads already created from it stay", parameters: [idParam("The play")], responses: ok(obj({ ok: bool }, ["ok"])) },
      },
      "/v1/plays/{id}/run": {
        post: {
          tags: ["Plays"],
          summary: "Run a play now. Uses one search unit. What it finds goes to the review queue; no lead is created and nobody is contacted. Answers 202 with a `jobId` to poll at GET /v1/search/jobs/{jobId} and the `runId` (or 200 with the finished `run` when the server runs jobs inline). At most 12 a minute. A play that is fed by uploads cannot be run (400)",
          parameters: [idParam("The play")],
          responses: {
            "202": { description: "Queued", ...j(obj({ jobId: uuid, runId: uuid }, ["jobId", "runId"])) },
            ...ok(obj({ run: playRunOut }, ["run"])),
            ...res("400", "This play is fed by uploads", errorBody),
            ...res("402", "quota_exceeded: no search units left this month", errorBody),
            ...res("409", "already_running: a run of this play started less than 15 minutes ago and has not finished", errorBody),
            ...res("429", "rate_limited, or queue_full when too many jobs are waiting", errorBody),
          },
        },
      },
      "/v1/plays/{id}/runs": { get: { tags: ["Plays"], summary: "The last 20 runs of a play, newest first", parameters: [idParam("The play")], responses: ok(obj({ runs: arr(playRunOut) }, ["runs"])) } },
      "/v1/plays/{id}/upload": {
        post: {
          tags: ["Plays"],
          summary: "Add people who engaged with a post - or signed up, followed, attended - to a play of type engagers_upload (the only type that takes uploads). Send `people` or `csv` (with a header row), not both. Each row needs a LinkedIn profile URL, or an email, or a name with a company; rows that cannot be used are counted in `rejectedCount` and the first 50 are listed with the reason. The people become candidates in the review queue. Body up to 2 MB. When only `postUrl` is sent and it is a public LinkedIn post, the people shown on the public page are read; the answer says plainly when that page was not publicly readable",
          parameters: [idParam("The play (type engagers_upload)")],
          requestBody: j(
            obj(
              {
                engagement: { ...str, enum: ["reacted", "commented", "reposted", "followed", "signed_up", "attended", "other"] },
                postUrl: { ...str, maxLength: 2000, description: "http or https. Shown as the evidence on every candidate" },
                postTitle: { ...str, maxLength: 200 },
                postAuthor: { ...str, maxLength: 120 },
                people: { type: "array", maxItems: 2000, items: engagerRow },
                csv: { ...str, description: "CSV text. The same column names as the lead import are understood" },
              },
              ["engagement"],
            ),
          ),
          responses: { ...ok(obj({ run: playRunOut, added: int, duplicates: int, rejected: arr(obj({ row: int, reason: str }, ["row", "reason"])), rejectedCount: int }, ["run", "added", "duplicates", "rejected", "rejectedCount"])), ...res("400", "validation_error", errorBody), ...res("413", "payload_too_large", errorBody) },
        },
      },
      "/v1/agent/prospect": { post: { tags: ["Agents"], summary: "One-call agent workflow: describe who you want → verified leads + optional personalized emails", requestBody: j(obj({ query: str, limit: { type: "integer", default: 5, maximum: 10 }, generateEmails: bool, sender: { type: "object" }, save: bool }, ["query"])), responses: ok() } },
    },
  };
}

/**
 * Swagger UI, pinned to one exact release with Subresource Integrity.
 *
 * The page used to load `swagger-ui-dist@5` - whatever the CDN served for "5" that day - with
 * no integrity check, on the API's own origin. A changed or compromised file there would have
 * run with access to anything a visitor typed into the "Authorize" box. Now the browser
 * refuses the file unless it is byte-for-byte the one hashed here, and the page's
 * Content-Security-Policy (set in app.ts) allows these two URLs and nothing else.
 *
 * To upgrade: change the version, then recompute both hashes with
 *   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
 */
const SWAGGER_UI_VERSION = "5.33.1";
export const SWAGGER_UI = {
  version: SWAGGER_UI_VERSION,
  css: `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css`,
  cssIntegrity: "sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW",
  js: `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`,
  jsIntegrity: "sha384-ZPehFMQommnnuaZ4rpxgkgTT2DKFVp4hZC/7pLit+9Lek9T1YGSo23eHFbvNkXkw",
} as const;

/** JSON for embedding inside a <script>: `<` escaped so a value can never close the tag. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export const docsHtml = (specUrl: string, nonce = "") => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Scout API Docs</title>
<link rel="stylesheet" href="${SWAGGER_UI.css}" integrity="${SWAGGER_UI.cssIntegrity}" crossorigin="anonymous"></head>
<body><div id="ui"></div>
<script src="${SWAGGER_UI.js}" integrity="${SWAGGER_UI.jsIntegrity}" crossorigin="anonymous"></script>
<script${nonce ? ` nonce="${nonce}"` : ""}>SwaggerUIBundle({url:${scriptJson(specUrl)},dom_id:'#ui',persistAuthorization:true,validatorUrl:null})</script>
</body></html>`;
