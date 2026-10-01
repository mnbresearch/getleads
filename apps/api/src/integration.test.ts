/**
 * Database integration tests.
 *
 * These exist because a broken query once shipped to production while 34 unit tests
 * passed: `sendingHealthForAccount` interpolated a JS Date into a raw sql`` template,
 * which the postgres driver cannot bind, so GET /v1/analytics/sending-health returned
 * 500 for any org that had a sender account. Nothing in a pure-function test suite can
 * catch that, because the bug lives in SQL that unit tests never execute.
 *
 * So anything whose risk is in the query rather than the arithmetic belongs here.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 *
 * Without TEST_DATABASE_URL the whole suite skips rather than fails, so `npm test`
 * stays green on a machine with no database. That is a deliberate trade: a skipped
 * suite is visible in the output, whereas a failing one would train people to ignore it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

// Configure the connection before anything imports the db singleton.
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  // Pinned, not defaulted. The send tests exercise the real sendStep, and a developer with
  // RESEND_API_KEY or SMTP_HOST in their shell or .env would otherwise have this suite make
  // live API calls - failing on an expired key, and on a working one actually sending mail
  // to the fake addresses these tests invent and burning their quota.
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  process.env.SMTP_PROBE_ENABLED = "false";
}

/**
 * Without a database these suites skip rather than fail, so `npm test` stays green on a
 * machine that has none. That is a deliberate trade - but a skipped suite that says nothing
 * trains people to read green as "everything passed", so it says something.
 */
if (!TEST_DB) {
  // stderr directly: vitest captures console output and prints it per-test, so a warning
  // about tests that are NOT running would itself never be shown.
  process.stderr.write(
    `\n[!] ${JSON.stringify("database integration")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests that cover SQL, auth, tenancy and the job pipeline.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("database integration", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  let schema: any;
  let sendingHealthForAccount: any;
  let experimentForStep: any;
  let icpLearningSamples: any;
  let learnFromOutcomes: any;
  let visibilityOverview: any;
  let withReschedule: any;
  let sampleAcrossEngines: any;
  let getUsage: any;
  let ensureRecurringJobs: any;
  let RECURRING_JOBS: any;
  let jobHandlers: any;
  let observationsFor: any;
  let knownBrands: any;

  beforeAll(async () => {
    const dbPkg = await import("@prospex/db");
    await dbPkg.runMigrations(TEST_DB);
    schema = dbPkg;
    db = dbPkg.getDb().db;
    ({ sendingHealthForAccount, experimentForStep } = await import("./services/campaigns.js"));
    ({ icpLearningSamples } = await import("./services/insights.js"));
    ({ visibilityOverview, observationsFor, knownBrands, sampleAcrossEngines } = await import("./services/visibility.js"));
    ({ getUsage } = await import("@prospex/db"));
    ({ learnFromOutcomes } = await import("@prospex/core"));
    ({ withReschedule, ensureRecurringJobs, RECURRING_JOBS, handlers: jobHandlers } = await import("./jobs.js"));
  }, 60_000);

  /** Each test gets its own org so they cannot contaminate one another. */
  async function newOrg(name = "test") {
    const [org] = await db
      .insert(schema.organizations)
      .values({ name, slug: `${name}-${randomUUID().slice(0, 8)}` })
      .returning();
    return org;
  }

  async function newAccount(orgId: string, dailyLimit = 500, ageDays = 60) {
    const [acct] = await db
      .insert(schema.emailAccounts)
      .values({ orgId, provider: "system", fromName: "T", fromEmail: `t-${randomUUID().slice(0, 8)}@example.com`, dailyLimit })
      .returning();
    await db.execute(schema.sql`UPDATE email_accounts SET created_at = now() - (${ageDays} || ' days')::interval WHERE id = ${acct.id}`);
    return (await db.query.emailAccounts.findFirst({ where: schema.eq(schema.emailAccounts.id, acct.id) }))!;
  }

  describe("sendingHealthForAccount", () => {
    async function seed(sent: number, bounced: number, opts: { ageDays?: number; dailyLimit?: number } = {}) {
      const org = await newOrg("health");
      const acct = await newAccount(org.id, opts.dailyLimit ?? 500, opts.ageDays ?? 60);
      const [cp] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id }).returning();
      if (sent > 0) {
        await db.insert(schema.messages).values(
          Array.from({ length: sent }, (_, i) => ({
            orgId: org.id,
            campaignId: cp.id,
            toEmail: `x${i}@example.com`,
            subject: "s",
            bodyText: "b",
            status: "sent",
            sentAt: new Date(),
            bouncedAt: i < bounced ? new Date() : null,
          })),
        );
      }
      return { org, acct };
    }

    it("runs at all (regression: the driver cannot bind a JS Date into a raw sql template)", async () => {
      const { org, acct } = await seed(30, 0);
      // The original bug threw TypeError at Bind time, before reaching Postgres.
      await expect(sendingHealthForAccount(db, org.id, acct)).resolves.toBeDefined();
    });

    it("reports healthy sending as ok at the configured cap", async () => {
      const { org, acct } = await seed(200, 1);
      const h = await sendingHealthForAccount(db, org.id, acct);
      expect(h.status).toBe("ok");
      expect(h.recommendedDailyCap).toBe(500);
    });

    it("halts and zeroes the cap once bounces cross the hard limit", async () => {
      const { org, acct } = await seed(200, 12); // 6%
      const h = await sendingHealthForAccount(db, org.id, acct);
      expect(h.status).toBe("halt");
      expect(h.recommendedDailyCap).toBe(0);
    });

    it("warns and halves volume on elevated but survivable bounces", async () => {
      const { org, acct } = await seed(200, 6); // 3%
      const h = await sendingHealthForAccount(db, org.id, acct);
      expect(h.status).toBe("warn");
      expect(h.recommendedDailyCap).toBe(250);
    });

    it("ignores a scary-looking rate from a volume too small to mean anything", async () => {
      const { org, acct } = await seed(5, 1); // 20%, but only 5 sends
      const h = await sendingHealthForAccount(db, org.id, acct);
      expect(h.status).toBe("ok");
    });

    it("holds a cold sending identity to the warm-up ladder", async () => {
      const { org, acct } = await seed(0, 0, { ageDays: 1, dailyLimit: 500 });
      const h = await sendingHealthForAccount(db, org.id, acct);
      expect(h.recommendedDailyCap).toBe(20);
      expect(h.rampDay).toBe(1);
    });

    it("counts only this account's messages, not the whole org", async () => {
      const { org, acct } = await seed(200, 0);
      // A second, badly-behaved account in the same org must not poison the first.
      const other = await newAccount(org.id);
      const [cp2] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C2", emailAccountId: other.id }).returning();
      await db.insert(schema.messages).values(
        Array.from({ length: 100 }, (_, i) => ({
          orgId: org.id, campaignId: cp2.id, toEmail: `y${i}@example.com`, subject: "s", bodyText: "b",
          status: "sent", sentAt: new Date(), bouncedAt: new Date(),
        })),
      );
      expect((await sendingHealthForAccount(db, org.id, acct)).status).toBe("ok");
      expect((await sendingHealthForAccount(db, org.id, other)).status).toBe("halt");
    });
  });

  describe("experimentForStep", () => {
    async function seedStep(variants: { sent: number; replied: number }[]) {
      const org = await newOrg("ab");
      const [cp] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C" }).returning();
      const [step] = await db
        .insert(schema.sequenceSteps)
        .values({
          campaignId: cp.id, stepNo: 1, subjectTemplate: "A", bodyTemplate: "b",
          variants: variants.slice(1).map((_, i) => ({ subjectTemplate: `V${i + 1}`, bodyTemplate: "b" })),
        })
        .returning();
      const rows: any[] = [];
      variants.forEach((v, idx) => {
        for (let i = 0; i < v.sent; i++) {
          rows.push({
            orgId: org.id, campaignId: cp.id, stepId: step.id, variant: idx,
            toEmail: `v${idx}-${i}@example.com`, subject: "s", bodyText: "b", status: "sent",
            sentAt: new Date(), repliedAt: i < v.replied ? new Date() : null,
          });
        }
      });
      if (rows.length) await db.insert(schema.messages).values(rows);
      return step;
    }

    it("returns null for a step with no variants to compare", async () => {
      expect(await experimentForStep(db, await seedStep([{ sent: 10, replied: 2 }]))).toBeNull();
    });

    it("stays inconclusive and evenly split while underpowered", async () => {
      const r = await experimentForStep(db, await seedStep([{ sent: 5, replied: 3 }, { sent: 5, replied: 0 }]));
      expect(r.confident).toBe(false);
      expect(r.allocation).toEqual({ 0: 0.5, 1: 0.5 });
    });

    it("attributes sends and replies to the right variant and calls a clear winner", async () => {
      const r = await experimentForStep(db, await seedStep([{ sent: 200, replied: 40 }, { sent: 200, replied: 6 }]));
      expect(r.ranked.find((v: any) => v.variant === 0)).toMatchObject({ sent: 200, positives: 40 });
      expect(r.ranked.find((v: any) => v.variant === 1)).toMatchObject({ sent: 200, positives: 6 });
      expect(r.confident).toBe(true);
      expect(r.winner).toBe(0);
    });
  });

  describe("icpLearningSamples", () => {
    it("counts only emailed leads, and marks replies and positive intent as wins", async () => {
      const org = await newOrg("icp");
      const [co] = await db.insert(schema.companies).values({ orgId: org.id, domain: "acme.com", industry: "Fintech", size: "51-200" }).returning();
      const mk = async (seniority: string) => {
        const [l] = await db.insert(schema.leads).values({ orgId: org.id, companyId: co.id, fullName: "X", seniority, country: "IN", email: `${randomUUID().slice(0, 8)}@acme.com` }).returning();
        return l;
      };
      const contactedReplied = await mk("vp");
      const contactedIntent = await mk("vp");
      const contactedSilent = await mk("manager");
      const neverContacted = await mk("c_level");

      await db.insert(schema.messages).values([
        { orgId: org.id, leadId: contactedReplied.id, toEmail: "a@acme.com", subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date(), repliedAt: new Date() },
        { orgId: org.id, leadId: contactedIntent.id, toEmail: "b@acme.com", subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date() },
        { orgId: org.id, leadId: contactedIntent.id, toEmail: "b@acme.com", subject: "re", bodyText: "b", direction: "inbound", status: "received", intent: "interested" },
        { orgId: org.id, leadId: contactedSilent.id, toEmail: "c@acme.com", subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date() },
      ]);

      const samples = await icpLearningSamples(db, org.id);
      // The never-emailed lead must not appear: it is not evidence either way.
      expect(samples).toHaveLength(3);
      expect(samples.filter((s: any) => s.positive)).toHaveLength(2);
      expect(samples.every((s: any) => s.attributes.industry === "Fintech")).toBe(true);
      expect(samples.some((s: any) => s.attributes.seniority === "c_level")).toBe(false);
      expect(neverContacted).toBeDefined();

      // And the pure function refuses to draw conclusions from three rows.
      expect(learnFromOutcomes(samples).sufficient).toBe(false);
    });

    it("does not leak samples across orgs", async () => {
      const a = await newOrg("icp-a");
      const b = await newOrg("icp-b");
      const [lead] = await db.insert(schema.leads).values({ orgId: a.id, fullName: "X", seniority: "vp", email: `${randomUUID().slice(0, 8)}@a.com` }).returning();
      await db.insert(schema.messages).values({ orgId: a.id, leadId: lead.id, toEmail: "a@a.com", subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date() });
      expect(await icpLearningSamples(db, a.id)).toHaveLength(1);
      expect(await icpLearningSamples(db, b.id)).toHaveLength(0);
    });
  });

  /**
   * The schedulers keep themselves alive: each run's last act schedules the next. They are
   * enqueued with maxAttempts: 1, so a failed run is never retried - which meant that before
   * `withReschedule`, one transient error killed campaign sending, monitors, autopilots,
   * visibility sampling or cleanup permanently and silently, until the next deploy.
   */
  /**
   * Sampling costs one model call per engine per sample. It used to be charged by the manual
   * route only, so the scheduled path - fanned out hourly to every active prompt in every
   * org - ran entirely free. The charge now lives in the function that does the work.
   */
  describe("visibility sampling is metered wherever it is triggered", () => {
    /**
     * An engine with a dead key must not be billed.
     *
     * An earlier version of this test asserted the opposite - that an attempt is billed
     * whether or not it succeeded - and so locked in the defect it was written next to: an
     * expired key was charged its full share every hour, every day, forever, and returned
     * nothing. It also hid a subtler mistake. `runVisibilityPrompt` CATCHES the provider
     * error and returns a run row with `error` set, so billing keyed off "this call did not
     * throw" counts a dead key as a successful call. The row's own error field is the only
     * honest signal, and this test is what holds that distinction in place.
     */
    it("does not charge for an engine whose key is dead", async () => {
      const org = await newOrg("vis-quota");
      const [prompt] = await db
        .insert(schema.visibilityPrompts)
        .values({ orgId: org.id, text: "What is the best B2B prospecting tool?", intent: "category", samplesPerRun: 2 })
        .returning();

      const before = (await getUsage(db, org.id)).usage.aiMessages.used;

      const prevKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key-not-valid";
      try {
        const r = await sampleAcrossEngines(db, org.id, prompt, { samples: 2, plan: "free" });
        expect(r.engines.length).toBeGreaterThan(0);
        // Every sample failed, so every sample is recorded as unusable...
        expect(r.results.every((x: any) => !x.ok)).toBe(true);
        expect(r.usable).toBe(0);
        // ...and nothing is billed.
        expect((await getUsage(db, org.id)).usage.aiMessages.used - before).toBe(0);
      } finally {
        if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevKey;
      }
    }, 120_000);

    it("charges nothing when no engine is configured, because no work happens", async () => {
      const org = await newOrg("vis-noengine");
      const [prompt] = await db
        .insert(schema.visibilityPrompts)
        .values({ orgId: org.id, text: "q", intent: "category", samplesPerRun: 3 })
        .returning();
      const saved: Record<string, string | undefined> = {};
      for (const k of ["GEMINI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      try {
        const before = (await getUsage(db, org.id)).usage.aiMessages.used;
        await expect(sampleAcrossEngines(db, org.id, prompt, { plan: "free" })).rejects.toThrow(/No AI (provider|engine)/i);
        expect((await getUsage(db, org.id)).usage.aiMessages.used).toBe(before);
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      }
    });
  });

  describe("recurring scheduler survival", () => {
    async function recurringRows(type: string) {
      return db
        .select()
        .from(schema.jobs)
        .where(schema.and(schema.eq(schema.jobs.type, type), schema.eq(schema.jobs.status, "queued")));
    }

    it("schedules the next run even when the body throws", async () => {
      const type = `test.recurring.${randomUUID().slice(0, 8)}`;
      const before = await recurringRows(type);
      expect(before).toHaveLength(0);

      await expect(
        withReschedule(db, { payload: { recurring: true } }, type, async () => {
          throw new Error("the select at the top of the handler failed");
        }),
      ).rejects.toThrow("the select at the top of the handler failed");

      // The chain survives its own body failing. This is the whole point.
      const after = await recurringRows(type);
      expect(after).toHaveLength(1);
      expect(after[0].payload.recurring).toBe(true);
      // And it still reports the failure rather than swallowing it - see the rejects above.
    });

    it("does not reschedule a one-off invocation of the same handler", async () => {
      const type = `test.oneoff.${randomUUID().slice(0, 8)}`;
      // A manual "run now" passes no `recurring` flag and must not start a chain.
      await withReschedule(db, { payload: {} }, type, async () => "ok");
      expect(await recurringRows(type)).toHaveLength(0);
    });

    it("revives a scheduler whose chain has died, and reports which", async () => {
      // Kill one chain the way a real failure does: mark it failed, leaving nothing queued.
      await db
        .update(schema.jobs)
        .set({ status: "failed" })
        .where(schema.and(schema.eq(schema.jobs.type, "system.cleanup"), schema.eq(schema.jobs.status, "queued")));
      expect(await recurringRows("system.cleanup")).toHaveLength(0);

      const revived = await ensureRecurringJobs();
      expect(revived).toContain("system.cleanup");
      expect(await recurringRows("system.cleanup")).toHaveLength(1);
    });

    it("is idempotent, so two processes booting together cannot double the chain", async () => {
      await ensureRecurringJobs();
      const counts = new Map<string, number>();
      for (const type of Object.keys(RECURRING_JOBS)) counts.set(type, (await recurringRows(type)).length);

      // Render starts the web service and the worker at the same time and both call this.
      await Promise.all([ensureRecurringJobs(), ensureRecurringJobs(), ensureRecurringJobs()]);

      for (const type of Object.keys(RECURRING_JOBS)) {
        expect((await recurringRows(type)).length, `${type} chain count`).toBe(counts.get(type));
      }
    });

    it("covers every scheduler the seeder knows about", () => {
      // A scheduler present in one list and missing from the other stops running with no
      // error, so the two are derived from the same constant and this pins that. The list
      // is written out deliberately: adding a scheduler should require saying so here.
      expect(Object.keys(RECURRING_JOBS).sort()).toEqual(
        ["autopilots.tick", "campaign.tick", "jobchanges.tick", "monitors.tick", "signals.scan", "system.cleanup", "visibility.tick"].sort(),
      );
    });

    it("has a handler for every scheduler it will enqueue", async () => {
      // The other half of the same failure: a scheduler in RECURRING_JOBS with no handler
      // is enqueued forever and fails every time, and nothing says so out loud.
      const { handlers } = await import("./jobs.js");
      const missing = Object.keys(RECURRING_JOBS).filter((t) => !(t in handlers));
      expect(missing).toEqual([]);
    });
  });

  describe("ai visibility", () => {
    async function seedRuns(rows: { mentioned: boolean; usable?: boolean; position?: number | null; brands?: string[]; daysAgo?: number }[]) {
      const org = await newOrg("vis");
      const [prompt] = await db
        .insert(schema.visibilityPrompts)
        .values({ orgId: org.id, text: "best b2b prospecting tools", samplesPerRun: 3 })
        .returning();
      for (const r of rows) {
        const [run] = await db
          .insert(schema.visibilityRuns)
          .values({
            orgId: org.id, promptId: prompt.id, engine: "groq", answer: "x",
            mentioned: r.mentioned, cited: false, position: r.position ?? (r.mentioned ? 2 : null),
            brands: r.brands ?? (r.mentioned ? ["Apollo", "Scout"] : ["Apollo"]),
            usable: r.usable ?? true,
          })
          .returning();
        if (r.daysAgo) {
          await db.execute(schema.sql`UPDATE visibility_runs SET created_at = now() - (${r.daysAgo} || ' days')::interval WHERE id = ${run.id}`);
        }
      }
      await db.execute(schema.sql`UPDATE organizations SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{visibility}', ${JSON.stringify({ brand: { name: "Scout", aliases: [], domain: "scout.mnbresearch.com" }, competitors: [{ name: "Apollo", domain: "apollo.io" }] })}::jsonb) WHERE id = ${org.id}`);
      return { org, prompt };
    }

    it("excludes refusals from the denominator instead of counting them as absence", async () => {
      // 10 usable runs, all mentioning us, plus 10 refusals. Mention rate must be 100%,
      // not 50%: counting refusals as absence would invent a visibility collapse.
      const { org } = await seedRuns([
        ...Array.from({ length: 10 }, () => ({ mentioned: true })),
        ...Array.from({ length: 10 }, () => ({ mentioned: false, usable: false })),
      ]);
      const obs = await observationsFor(db, org.id, { days: 30 });
      expect(obs).toHaveLength(10);
      const o = await visibilityOverview(db, org.id, 30);
      expect(o.metrics.mentionRate.value).toBe(1);
      expect(o.excludedRuns).toBe(10);
    });

    it("reports a rate with an interval and never leaks across orgs", async () => {
      const { org } = await seedRuns(Array.from({ length: 30 }, (_, i) => ({ mentioned: i < 15 })));
      const other = await newOrg("vis-other");
      const o = await visibilityOverview(db, org.id, 30);
      expect(o.metrics.runs).toBe(30);
      expect(o.metrics.mentionRate.value).toBeCloseTo(0.5, 5);
      expect(o.metrics.mentionRate.ci.lower).toBeLessThan(0.5);
      expect(o.brand.name).toBe("Scout");
      expect((await visibilityOverview(db, other.id, 30)).metrics.runs).toBe(0);
    });

    it("refuses to call an overlapping week-on-week move a trend", async () => {
      // Older half 50%, newer half 40%. Small samples, overlapping intervals.
      const { org } = await seedRuns([
        ...Array.from({ length: 20 }, (_, i) => ({ mentioned: i < 10, daysAgo: 25 })),
        ...Array.from({ length: 20 }, (_, i) => ({ mentioned: i < 8, daysAgo: 2 })),
      ]);
      const o = await visibilityOverview(db, org.id, 30);
      expect(o.change.significant).toBe(false);
      expect(o.change.direction).toBe("flat");
    });

    it("surfaces the rival winning answers we are absent from", async () => {
      const { org } = await seedRuns(Array.from({ length: 20 }, () => ({ mentioned: false, brands: ["Apollo", "Clay"] })));
      const o = await visibilityOverview(db, org.id, 30);
      expect(o.competitors[0].name).toBe("Apollo");
      expect(o.competitors[0].beatsYou).toBe(20);
      expect(o.gaps[0].prompt).toBe("best b2b prospecting tools");
    });

    it("learns rival names from past answers to rank untracked brands later", async () => {
      const { org } = await seedRuns(Array.from({ length: 5 }, () => ({ mentioned: false, brands: ["Instantly", "Apollo"] })));
      expect(await knownBrands(db, org.id)).toContain("Instantly");
    });
  });

  /**
   * Writes that used to destroy data they had nothing to say about.
   *
   * An update should be able to add what it knows and leave the rest alone. These two could
   * not: a caller with only an email blanked the stored name, and a crawl that reached
   * nothing erased the harvested address list that email discovery depends on.
   */
  describe("an update never replaces real data with nothing", () => {
    let upsertLead: any;
    let upsertCompany: any;

    beforeAll(async () => {
      ({ upsertLead, upsertCompany } = await import("./services/leads.js"));
    });

    it("keeps a lead's name when the next write does not carry one", async () => {
      const org = await newOrg("upsert-name");
      const email = `keep-${randomUUID().slice(0, 8)}@example.com`;

      await upsertLead(org.id, { firstName: "Priya", lastName: "Sharma", email, title: "VP Sales" });
      // A perfectly ordinary CSV row: an email and a title, no name columns.
      const { lead } = await upsertLead(org.id, { email, title: "SVP Sales" });

      expect(lead.fullName).toBe("Priya Sharma");
      expect(lead.firstName).toBe("Priya");
      expect(lead.title).toBe("SVP Sales");
    });

    it("keeps harvested addresses when a later crawl finds none", async () => {
      const org = await newOrg("upsert-raw");
      const domain = `acme-${randomUUID().slice(0, 8)}.test`;

      await upsertCompany(org.id, domain, { emailsFound: ["hello@acme.test", "jobs@acme.test"], socials: { linkedin: "https://www.linkedin.com/company/acme" } });
      // crawlCompanyWebsite always returns both keys, and [] and {} are truthy - which is
      // how the empty version used to overwrite the real one.
      const after = await upsertCompany(org.id, domain, { emailsFound: [], socials: {} });

      expect((after.raw as { emailsFound?: string[] })?.emailsFound).toEqual(["hello@acme.test", "jobs@acme.test"]);
    });

    it("does record addresses when a crawl actually finds some", async () => {
      const org = await newOrg("upsert-raw2");
      const domain = `beta-${randomUUID().slice(0, 8)}.test`;
      await upsertCompany(org.id, domain, { emailsFound: ["a@beta.test"], socials: {} });
      const after = await upsertCompany(org.id, domain, { emailsFound: ["a@beta.test", "b@beta.test"], socials: {} });
      expect((after.raw as { emailsFound?: string[] })?.emailsFound).toHaveLength(2);
    });
  });

  /**
   * `consume(...).then(() => true, () => false)` reported every failure as "out of quota",
   * including a database fault. The customer was told they hit a cap they had not hit, and
   * the real error was recorded nowhere.
   */
  describe("quota refusals are told apart from faults", () => {
    let tryConsume: any;

    beforeAll(async () => {
      ({ tryConsume } = await import("./lib/quota.js"));
    });

    it("says ok when the org is within its plan", async () => {
      const org = await newOrg("quota-ok");
      expect(await tryConsume(db, org.id, "leads", 1)).toEqual({ ok: true });
    });

    it("calls a plan limit a plan limit", async () => {
      const org = await newOrg("quota-over");
      // Pin the limit rather than reading it from the plan table, so this test keeps
      // testing the same thing when pricing changes - and so it cannot quietly assert
      // nothing if a limit key is ever renamed.
      await db.update(schema.organizations).set({ planLimits: { leadsPerMonth: 2 } }).where(schema.eq(schema.organizations.id, org.id));

      expect(await tryConsume(db, org.id, "leads", 1)).toEqual({ ok: true });
      expect(await tryConsume(db, org.id, "leads", 1)).toEqual({ ok: true });

      const over = await tryConsume(db, org.id, "leads", 1);
      expect(over.ok).toBe(false);
      expect(over.reason).toBe("quota");
      expect(over.message).toMatch(/2\/2|quota/i);

      // And the rollback means the org is not left stuck above its own limit.
      expect((await getUsage(db, org.id)).usage.leads.used).toBe(2);
    });

    it("calls a database fault a fault, not a plan limit", async () => {
      const broken = {
        query: { organizations: { findFirst: async () => { throw new Error("connection terminated unexpectedly"); } } },
        select: () => { throw new Error("connection terminated unexpectedly"); },
        insert: () => { throw new Error("connection terminated unexpectedly"); },
      };
      const r = await tryConsume(broken as never, randomUUID(), "leads", 1);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("error");
      expect(r.message).toMatch(/connection terminated/);
    });
  });

  /**
   * The retry that emailed a prospect twice.
   *
   * The BILLING side of a retry was fixed and the SENDING side was not: the provider call
   * succeeded, the row update or the contact advance then failed - a dropped pool
   * connection is enough - the handler threw, failJob requeued it, and sendStep re-ran
   * from the top with currentStep unchanged. For cold outreach a duplicate is the worse
   * failure: it reads as broken and it costs sending reputation.
   */
  describe("a retried send does not email the prospect twice", () => {
    let sendStep: any;

    beforeAll(async () => {
      ({ sendStep } = await import("./services/campaigns.js"));
    });

    async function scenario(priorStatus: "sent" | "sending") {
      const org = await newOrg("resend");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id, status: "active" }).returning();
      const [step] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "Hi", bodyTemplate: "Hello" }).returning();
      const [lead] = await db.insert(schema.leads).values({ orgId: org.id, email: `p-${randomUUID().slice(0, 8)}@example.com`, fullName: "P", emailStatus: "valid" }).returning();
      const [cc] = await db.insert(schema.campaignContacts).values({ orgId: org.id, campaignId: campaign.id, leadId: lead.id, status: "active", currentStep: 0 }).returning();

      // What the crashed first attempt left behind.
      const [prior] = await db
        .insert(schema.messages)
        .values({ orgId: org.id, campaignId: campaign.id, stepId: step.id, leadId: lead.id, toEmail: lead.email!, subject: "Hi", bodyText: "Hello", status: priorStatus })
        .returning();

      const r = await sendStep(campaign.id, cc.id, step.id, { attempt: 2 });
      const rows = await db.select().from(schema.messages).where(schema.eq(schema.messages.campaignId, campaign.id));
      return { r, rows, prior, cc, org, campaign };
    }

    it("does not send again when the first attempt is known to have delivered", async () => {
      const { r, rows, prior, cc } = await scenario("sent");
      expect(r.sent).toBeUndefined();
      expect(String(r.skipped)).toMatch(/already sent/i);
      // No second message row, so no second email.
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(prior.id);
      // The contact still moves on, so the sequence is not stuck on this step forever.
      const after = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, cc.id) });
      expect(after!.currentStep).toBe(1);
    });

    it("does not gamble a second copy when the first attempt's outcome is unknown", async () => {
      const { r, rows, prior, cc } = await scenario("sending");
      expect(String(r.skipped)).toMatch(/unknown/i);
      expect(rows).toHaveLength(1);
      const row = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, prior.id) });
      // Recorded as uncertain rather than quietly marked sent or silently resent.
      expect(row!.status).toBe("unknown");
      expect(row!.error).toMatch(/never recorded/i);

      // sendMail returns {ok:false} rather than throwing, so a row stuck at "sending" means
      // the write recording the outcome failed - and that write is the same one for a
      // success as for a failure. We cannot know whether it went out, so the contact is
      // neither advanced (which would skip this step forever) nor left active (which would
      // resend). It stops, visibly.
      const after = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, cc.id) });
      expect(after!.currentStep).toBe(0);
      expect(after!.status).toBe("failed");
    });

    it("gives a stopped contact a way back into its sequence", async () => {
      const { cc, prior } = await scenario("sending");
      const stopped = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, cc.id) });
      expect(stopped!.status).toBe("failed");

      // "failed" is terminal - the tick only picks up queued/active - so without a way back
      // one dropped connection would end this prospect's sequence forever.
      const { resumeContact } = await import("./services/campaigns.js");
      const r = await resumeContact(cc.id, { resend: false });
      expect(r.ok).toBe(true);

      const after = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, cc.id) });
      // "completed", not "active": this scenario's campaign has a single step, so moving on
      // from it finishes the sequence. The point is that it is no longer stuck at "failed".
      expect(after!.status).toBe("completed");
      expect(after!.currentStep).toBe(1);

      // The message is resolved too. Left at "unknown", a delivered message stays filed as
      // uncertain forever and any later count of what was sent disagrees with the
      // contact's own progress.
      const msg = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, prior.id) });
      expect(msg!.status).toBe("sent");
    });

    it("clears the uncertain message when a person says it never arrived", async () => {
      const { cc, prior } = await scenario("sending");
      const { resumeContact } = await import("./services/campaigns.js");
      await resumeContact(cc.id, { resend: true });

      const msg = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, prior.id) });
      // Left at "unknown", the guard would stop the very next attempt again.
      expect(msg!.status).toBe("failed");
      const after = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, cc.id) });
      expect(after!.status).toBe("active");
      expect(after!.currentStep).toBe(0);
    });

    it("resolves only the stopped step's message, not an earlier one", async () => {
      // The single-step scenario above cannot catch this: with one step there is only ever
      // one message to match, so scoping by stepId is untestable there.
      const org = await newOrg("resume-multi");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id, status: "active" }).returning();
      const [s1] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "One", bodyTemplate: "One" }).returning();
      const [s2] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 2, channel: "email", subjectTemplate: "Two", bodyTemplate: "Two" }).returning();
      const [lead] = await db.insert(schema.leads).values({ orgId: org.id, email: `p-${randomUUID().slice(0, 8)}@example.com`, fullName: "P", emailStatus: "valid" }).returning();
      // Step 1's outcome was lost and a person said it arrived; step 2's is lost too.
      const [m1] = await db.insert(schema.messages).values({ orgId: org.id, campaignId: campaign.id, stepId: s1.id, leadId: lead.id, toEmail: lead.email!, subject: "One", bodyText: "One", status: "unknown" }).returning();
      const [m2] = await db.insert(schema.messages).values({ orgId: org.id, campaignId: campaign.id, stepId: s2.id, leadId: lead.id, toEmail: lead.email!, subject: "Two", bodyText: "Two", status: "unknown" }).returning();
      const [cc] = await db.insert(schema.campaignContacts).values({ campaignId: campaign.id, leadId: lead.id, status: "failed", currentStep: 1 }).returning();

      const { resumeContact } = await import("./services/campaigns.js");
      await resumeContact(cc.id, { resend: true });

      const after1 = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, m1.id) });
      const after2 = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, m2.id) });
      // Step 2 is the one being retried; step 1 must not be stamped "never arrived", which
      // would contradict what the same person said about it.
      expect(after2!.status).toBe("failed");
      expect(after1!.status).toBe("unknown");
    });

    it("does not leave a contact silently stuck when there is no sending account", async () => {
      // tickCampaign clears nextSendAt before enqueueing, and the due query needs a date -
      // so a bare `return { skipped }` here left the contact reading "active" with nothing
      // able to pick it up again, and nothing anywhere saying so.
      const org = await newOrg("no-account");
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", status: "active" }).returning();
      const [step] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "Hi", bodyTemplate: "Hello" }).returning();
      const [lead] = await db.insert(schema.leads).values({ orgId: org.id, email: `p-${randomUUID().slice(0, 8)}@example.com`, fullName: "P", emailStatus: "valid" }).returning();
      const [cc] = await db.insert(schema.campaignContacts).values({ campaignId: campaign.id, leadId: lead.id, status: "active", currentStep: 0 }).returning();

      const r = await sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(String(r.skipped)).toMatch(/no sending account/i);

      const after = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, cc.id) });
      // Visible, and recoverable through resumeContact - not "active" forever.
      expect(after!.status).toBe("failed");
    });

    it("refuses to resume a contact that is not stopped", async () => {
      const { cc } = await scenario("sent");
      const { resumeContact } = await import("./services/campaigns.js");
      const r = await resumeContact(cc.id, { resend: false });
      expect(r.ok).toBe(false);
    });

    it("does not advance a contact twice when the earlier attempt already advanced it", async () => {
      const org = await newOrg("resend-advanced");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id, status: "active" }).returning();
      const [s1] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "One", bodyTemplate: "One" }).returning();
      await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 2, channel: "email", subjectTemplate: "Two", bodyTemplate: "Two" });
      const [lead] = await db.insert(schema.leads).values({ orgId: org.id, email: `p-${randomUUID().slice(0, 8)}@example.com`, fullName: "P", emailStatus: "valid" }).returning();
      // The first attempt sent AND advanced; something after that threw, so the job retries.
      const [cc] = await db.insert(schema.campaignContacts).values({ orgId: org.id, campaignId: campaign.id, leadId: lead.id, status: "active", currentStep: 1 }).returning();
      await db.insert(schema.messages).values({ orgId: org.id, campaignId: campaign.id, stepId: s1.id, leadId: lead.id, toEmail: lead.email!, subject: "One", bodyText: "One", status: "sent" });

      await sendStep(campaign.id, cc.id, s1.id, { attempt: 2 });

      const after = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, cc.id) });
      // Still on step 2. Advancing again would have jumped to 3, and step 2 would never
      // have been sent to this person at all.
      expect(after!.currentStep).toBe(1);
    });

    it("leaves a genuinely failed attempt free to be retried", async () => {
      const org = await newOrg("resend-failed");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id, status: "active" }).returning();
      const [step] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "Hi", bodyTemplate: "Hello" }).returning();
      const [lead] = await db.insert(schema.leads).values({ orgId: org.id, email: `p-${randomUUID().slice(0, 8)}@example.com`, fullName: "P", emailStatus: "valid" }).returning();
      const [cc] = await db.insert(schema.campaignContacts).values({ orgId: org.id, campaignId: campaign.id, leadId: lead.id, status: "active", currentStep: 0 }).returning();
      await db.insert(schema.messages).values({ orgId: org.id, campaignId: campaign.id, stepId: step.id, leadId: lead.id, toEmail: lead.email!, subject: "Hi", bodyText: "Hello", status: "failed" });

      const r = await sendStep(campaign.id, cc.id, step.id, { attempt: 2 });
      // A failed row is not evidence of delivery, so the guard must not block the retry.
      // Asserted positively rather than as "not one of these strings", which would also
      // pass if sendStep bailed out for an unrelated reason like a missing account.
      expect(r.skipped).toBeUndefined();
      expect(r.sent).toBe(true);
    });
  });

  /**
   * Job change detection, against the real query.
   *
   * The scan's selection logic is where it can quietly stop working: too narrow and it
   * checks nobody, too broad and it spends a provider call on every lead in the database
   * every night. These pin the selection, not the provider call.
   */
  describe("job change scanning picks the right leads", () => {
    let scanJobChanges: any;

    beforeAll(async () => {
      ({ scanJobChanges } = await import("./services/jobChanges.js"));
    });

    async function leadWith(orgId: string, patch: Record<string, unknown>) {
      const [row] = await db
        .insert(schema.leads)
        .values({ orgId, fullName: "P", email: `jc-${randomUUID().slice(0, 8)}@example.com`, linkedinUrl: `https://www.linkedin.com/in/x-${randomUUID().slice(0, 8)}`, ...patch })
        .returning();
      return row;
    }

    it("checks engaged leads and high scorers, and leaves the rest alone", async () => {
      const org = await newOrg("jc-select");
      await leadWith(org.id, { status: "replied", score: 10 }); // engaged, low score -> in
      await leadWith(org.id, { status: "new", score: 95 }); // cold but strong fit -> in
      await leadWith(org.id, { status: "new", score: 10 }); // neither -> out

      const r = await scanJobChanges(org.id, { limit: 50, minScore: 70 });
      expect(r.checked).toBe(2);
    });

    it("does not re-check someone confirmed recently", async () => {
      const org = await newOrg("jc-stale");
      const lead = await leadWith(org.id, { status: "replied", score: 90 });
      await db.update(schema.leads).set({ jobCheckedAt: new Date() }).where(schema.eq(schema.leads.id, lead.id));

      expect((await scanJobChanges(org.id, { staleDays: 30 })).checked).toBe(0);
      // ...but does once the check has gone stale.
      await db.execute(schema.sql`UPDATE leads SET job_checked_at = now() - interval '60 days' WHERE id = ${lead.id}`);
      expect((await scanJobChanges(org.id, { staleDays: 30 })).checked).toBe(1);
    });

    it("skips a lead with nothing to look them up by", async () => {
      const org = await newOrg("jc-noid");
      await db.insert(schema.leads).values({ orgId: org.id, fullName: "No Handle", status: "replied", score: 90 });
      expect((await scanJobChanges(org.id, {})).checked).toBe(0);
    });

    it("does not record a check it could not actually make", async () => {
      // A lead with no company on file whose title is unchanged: the comparison returns
      // "none" because nothing visible changed, but the EMPLOYER was never compared. An
      // earlier version stamped jobCheckedAt here, which suppressed the next real check for
      // a month while a provider was quietly reporting a new employer.
      const { detectJobChange } = await import("@prospex/core");
      const r = detectJobChange({ previous: { title: "VP Sales" }, current: { companyName: "Somewhere New", title: "VP Sales" } });
      expect(r.kind).toBe("none");
      expect(r.comparedCompany).toBe(false);
    });

    /**
     * The distinction the whole feature rests on. With no provider configured, every lookup
     * comes back empty - and that must be reported as "we could not ask", never as a month
     * in which nobody moved, and it must not stamp jobCheckedAt and suppress the next real
     * check for a month.
     */
    it("reports an unanswerable scan as blocked, not as nobody having moved", async () => {
      const org = await newOrg("jc-blocked");
      const lead = await leadWith(org.id, { status: "replied", score: 90 });

      const r = await scanJobChanges(org.id, {});
      expect(r.checked).toBe(1);
      expect(r.changed).toBe(0);
      expect(r.unconfirmed).toBe(1);
      expect(r.blocked).toMatch(/provider|credential/i);

      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
      expect(after!.jobCheckedAt).toBeNull();
    });

    /**
     * Refusing to stamp `jobCheckedAt` on a lookup nothing answered is right. Retrying that
     * same lead every night forever is not the same thing - it is a provider call per lead
     * per run for an answer that is not going to change. The attempt is stamped separately,
     * and gates a short backoff that never outlasts the success window.
     */
    it("backs off a lead nothing could be confirmed about, without recording it as checked", async () => {
      const org = await newOrg("jc-backoff");
      const lead = await leadWith(org.id, { status: "replied", score: 90 });

      expect((await scanJobChanges(org.id, {})).checked).toBe(1);
      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
      // Attempted, emphatically not checked.
      expect(after!.jobCheckAttemptedAt).not.toBeNull();
      expect(after!.jobCheckedAt).toBeNull();

      // Not picked up again tomorrow...
      expect((await scanJobChanges(org.id, {})).checked).toBe(0);
      // ...but picked up again well before the 30-day success window would have allowed.
      await db.execute(schema.sql`UPDATE leads SET job_check_attempted_at = now() - interval '5 days' WHERE id = ${lead.id}`);
      expect((await scanJobChanges(org.id, { retryDays: 3 })).checked).toBe(1);
    });

    it("never lets the retry backoff outlast the confirmed-check window", async () => {
      const org = await newOrg("jc-backoff-clamp");
      const lead = await leadWith(org.id, { status: "replied", score: 90 });
      await scanJobChanges(org.id, { staleDays: 2, retryDays: 90 });
      await db.execute(schema.sql`UPDATE leads SET job_check_attempted_at = now() - interval '3 days' WHERE id = ${lead.id}`);
      // retryDays was clamped to staleDays, so three days is stale enough to look again. An
      // unclamped 90 would mean a failed lookup suppressed checks for longer than a
      // successful one, which inverts the entire point of the two timestamps.
      expect((await scanJobChanges(org.id, { staleDays: 2, retryDays: 90 })).checked).toBe(1);
    });

    /**
     * The backoff must not launder an outage into an empty result.
     *
     * Day one, nothing answers: checked 40, unconfirmed 40, blocked, 502. Day two, every
     * one of those leads is inside the backoff window, so there is nothing left to check -
     * and `checked: 0, changed: 0` with no note is character-for-character what an org
     * where nobody moved gets. The outage has not resolved; the scan must still say so.
     */
    it("still reports an unresolved outage on the day after, when the backoff leaves nothing to check", async () => {
      const org = await newOrg("jc-backoff-blocked");
      await leadWith(org.id, { status: "replied", score: 90 });
      await leadWith(org.id, { status: "replied", score: 90 });

      const day1 = await scanJobChanges(org.id, {});
      expect(day1.checked).toBe(2);
      expect(day1.blocked).toBeTruthy();

      const day2 = await scanJobChanges(org.id, {});
      expect(day2.checked).toBe(0);
      expect(day2.skippedRecentlyAttempted).toBe(2);
      // The distinction the whole module exists for.
      expect(day2.blocked).toMatch(/not a month in which nobody moved/i);
    });

    /**
     * Detection, dedup, and the second move - the behaviours the backoff work was most
     * likely to have broken, and the ones nothing covered.
     */
    describe("with a provider that answers", () => {
      async function withEnrichment<T>(answers: Record<string, unknown>[], fn: () => Promise<T>): Promise<T> {
        const core = await import("@prospex/core");
        let i = 0;
        const spy = vi.spyOn(core, "enrichWithProviders").mockImplementation(async () => (answers[Math.min(i++, answers.length - 1)] ?? null) as never);
        try {
          return await fn();
        } finally {
          spy.mockRestore();
        }
      }

      /** Clear the backoff so the next scan in a test picks the lead up again. */
      const makeDue = (id: string) => db.execute(schema.sql`UPDATE leads SET job_check_attempted_at = NULL, job_checked_at = NULL WHERE id = ${id}`);

      it("raises a move once, then stops raising it", async () => {
        const org = await newOrg("jc-dedup");
        const [co] = await db.insert(schema.companies).values({ orgId: org.id, name: "Acme", domain: "acme.test" }).returning();
        const lead = await leadWith(org.id, { status: "replied", score: 90, title: "VP Sales", companyId: co.id });
        const answer = { companyName: "Globex", companyDomain: "globex.test", title: "VP Sales" };

        const first = await withEnrichment([answer], () => scanJobChanges(org.id, {}));
        expect(first.changed).toBe(1);
        expect(first.alreadyKnown).toBe(0);

        await makeDue(lead.id);
        const second = await withEnrichment([answer], () => scanJobChanges(org.id, {}));
        // Still true, still counted - but not announced a second time. The lead's own
        // company row is deliberately not rewritten (whether the CRM record follows the
        // person is the org's call), so the same move is detected again every scan.
        expect(second.changed).toBe(0);
        expect(second.alreadyKnown).toBe(1);

        const rows = await db.select().from(schema.signals).where(schema.and(schema.eq(schema.signals.orgId, org.id), schema.eq(schema.signals.type, "job_change")));
        expect(rows.length).toBe(1);
      });

      /**
       * The hole the first dedup had. Providers return a company website with no company
       * name constantly, so two different destinations both arrive as
       * `to: { company: null, title: "VP Sales" }` - identical on every key the dedup
       * matched on. The second, genuinely new move was counted as already known and never
       * alerted: a silenced signal, produced by the code added to stop noise.
       */
      it("raises a second move to a different company even when neither destination has a name", async () => {
        const org = await newOrg("jc-dedup-domain");
        const [co] = await db.insert(schema.companies).values({ orgId: org.id, name: "Acme", domain: "acme.test" }).returning();
        const lead = await leadWith(org.id, { status: "replied", score: 90, title: "VP Sales", companyId: co.id });

        const first = await withEnrichment([{ companyName: null, companyDomain: "beta.test", title: "VP Sales" }], () => scanJobChanges(org.id, {}));
        expect(first.changed).toBe(1);

        await makeDue(lead.id);
        const second = await withEnrichment([{ companyName: null, companyDomain: "gamma.test", title: "VP Sales" }], () => scanJobChanges(org.id, {}));
        expect(second.changed).toBe(1);
        expect(second.alreadyKnown).toBe(0);
      });

      it("stamps a confirmed check and stops there", async () => {
        const org = await newOrg("jc-confirmed");
        const [co] = await db.insert(schema.companies).values({ orgId: org.id, name: "Acme", domain: "acme.test" }).returning();
        const lead = await leadWith(org.id, { status: "replied", score: 90, title: "VP Sales", companyId: co.id });

        const r = await withEnrichment([{ companyName: "Acme", companyDomain: "https://www.acme.test/careers", title: "VP Sales" }], () => scanJobChanges(org.id, {}));
        expect(r.changed).toBe(0);
        expect(r.unconfirmed).toBe(0);
        const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
        // A scheme and a path on the fresh side used to read as a different employer.
        expect(after!.jobCheckedAt).not.toBeNull();
      });
    });

    /**
     * The rotation has to rotate.
     *
     * It used to order orgs by `max(job_checked_at)` over their leads, NULLS FIRST - and
     * that column is deliberately only written on a confirmed comparison, so an org with no
     * leads, no provider coverage or nothing comparable never got one and sat at the head
     * of every tick forever while the orgs behind it were never reached.
     */
    it("advances an org that can never be scanned, instead of parking it at the head", async () => {
      // Every other org in this database is put behind us, so the head of the rotation is
      // deterministic. All ticks start null, and null sorts first.
      await db.execute(schema.sql`UPDATE organizations SET job_check_tick_at = now()`);
      const empty = await newOrg("jc-tick-empty");
      const withLead = await newOrg("jc-tick-lead");
      await leadWith(withLead.id, { status: "replied", score: 90 });
      await db.execute(schema.sql`UPDATE organizations SET job_check_tick_at = NULL WHERE id IN (${empty.id}, ${withLead.id})`);

      const ctx = { db, log: () => {} };
      const tickOf = async (id: string) => (await db.select().from(schema.organizations).where(schema.eq(schema.organizations.id, id)))[0].jobCheckTickAt;
      const run = () => jobHandlers["jobchanges.tick"]({ id: randomUUID(), type: "jobchanges.tick", payload: {}, attempts: 0 }, ctx);

      await run();
      // The org with nothing to scan is stamped anyway - that is exactly what lets the
      // orgs behind it through on the next tick.
      const emptyFirst = await tickOf(empty.id);
      expect(emptyFirst).not.toBeNull();
      expect(await tickOf(withLead.id)).not.toBeNull();

      // And a newcomer, not a previously-stamped org, is at the head next time.
      const newcomer = await newOrg("jc-tick-new");
      await db.execute(schema.sql`UPDATE organizations SET job_check_tick_at = NULL WHERE id = ${newcomer.id}`);
      await run();
      expect(await tickOf(newcomer.id)).not.toBeNull();
    });

    it("keeps one org's leads out of another's scan", async () => {
      const a = await newOrg("jc-a");
      const b = await newOrg("jc-b");
      await leadWith(a.id, { status: "replied", score: 90 });
      expect((await scanJobChanges(b.id, {})).checked).toBe(0);
    });
  });

  /**
   * Funnel, source performance and attribution, against real rows.
   *
   * These are pure SQL over joins, which is exactly where a metric goes wrong silently: a
   * denominator that quietly includes rows the step could never apply to, a join that
   * double-counts, a rate computed from three data points and printed as a finding.
   */
  describe("analytics answer the three questions honestly", () => {
    let leadFunnel: any;
    let sourcePerformance: any;
    let campaignAttribution: any;

    beforeAll(async () => {
      ({ leadFunnel, sourcePerformance, campaignAttribution } = await import("./services/analytics.js"));
    });

    async function seedLeads(orgId: string, spec: { status: string; source?: string; score?: number; n: number }[]) {
      for (const s of spec) {
        for (let i = 0; i < s.n; i++) {
          await db.insert(schema.leads).values({
            orgId,
            fullName: `L${i}`,
            email: `${s.status}-${i}-${randomUUID().slice(0, 6)}@example.com`,
            status: s.status,
            source: s.source ?? "search",
            score: s.score ?? 50,
          });
        }
      }
    }

    it("counts reaching a stage cumulatively, because a reply implies a contact", async () => {
      const org = await newOrg("funnel");
      await seedLeads(org.id, [
        { status: "new", n: 40 },
        { status: "contacted", n: 30 },
        { status: "replied", n: 10 },
        { status: "customer", n: 5 },
      ]);

      const f = await leadFunnel(org.id, 90);
      expect(f.entered).toBe(85);
      const byStage = Object.fromEntries(f.stages.map((s: any) => [s.stage, s.count]));
      // Everyone reached "new"; the 5 customers also reached replied, contacted and new.
      expect(byStage.new).toBe(85);
      expect(byStage.contacted).toBe(45);
      expect(byStage.replied).toBe(15);
      expect(byStage.customer).toBe(5);
      expect(f.sufficient).toBe(true);
    });

    /**
     * The case the first version got wrong. `rank("lost")` is -1, so lost leads were in the
     * denominator and in none of the stage counts - showing 20% of leads failing to reach
     * the FIRST stage, which cannot happen, because every lead reaches it.
     */
    it("does not show leads failing to reach the first stage of the funnel", async () => {
      const org = await newOrg("funnel-lost");
      await seedLeads(org.id, [
        { status: "new", n: 80 },
        { status: "lost", n: 20 },
      ]);

      const f = await leadFunnel(org.id, 90);
      // Lost leads sit beside the funnel, not inside it: only the current status is stored,
      // so where each one was lost is unknowable, and guessing either end is a lie.
      expect(f.lost).toBe(20);
      expect(f.entered).toBe(80);
      expect(f.stages[0].count).toBe(80);
      expect(f.stages[0].conversionFromStart).toBe(1);
      expect(f.lostNote).toMatch(/not in the rates/i);
    });

    /**
     * A status the funnel does not model must be accounted for out loud.
     *
     * `unsubscribed` is a live example - routes/leads.ts already filters on it - and it is
     * in neither the stages nor the lost count. Leaving it unmentioned meant the funnel's
     * own totals did not add up to the org's lead count with nothing on the page to say
     * why, which is the same silent narrowing this module refuses everywhere else.
     */
    it("accounts for statuses the funnel does not model instead of dropping them", async () => {
      const org = await newOrg("funnel-other");
      await seedLeads(org.id, [
        { status: "new", n: 50 },
        { status: "lost", n: 10 },
        { status: "unsubscribed", n: 7 },
      ]);

      const f = await leadFunnel(org.id, 90);
      expect(f.entered).toBe(50);
      expect(f.lost).toBe(10);
      expect(f.other).toBe(7);
      // The three buckets reconcile to the window's population, which is the point. The
      // window is said out loud too, because "created in the last 90 days" and "every lead
      // you have" are very different denominators and only one of them is on screen.
      expect(f.entered + f.lost + f.other).toBe(f.totalInWindow);
      expect(f.totalInWindow).toBe(67);
      expect(f.otherStatuses).toEqual([{ status: "unsubscribed", count: 7 }]);
      expect(f.otherNote).toMatch(/unsubscribed: 7/);
      expect(f.windowNote).toMatch(/last 90 days/);
    });

    it("withholds conversion rates when there are too few leads to mean anything", async () => {
      const org = await newOrg("funnel-thin");
      await seedLeads(org.id, [{ status: "contacted", n: 3 }]);
      const f = await leadFunnel(org.id, 90);
      expect(f.sufficient).toBe(false);
      expect(f.biggestDropOff).toBeNull();
      expect(f.note).toMatch(/too few/i);
    });

    it("keeps one org's funnel out of another's", async () => {
      const a = await newOrg("funnel-a");
      const b = await newOrg("funnel-b");
      await seedLeads(a.id, [{ status: "replied", n: 25 }]);
      expect((await leadFunnel(b.id, 90)).entered).toBe(0);
    });

    /**
     * The denominator decision that matters most. A source that produced 500 leads of which
     * 10 were emailed has a 20% reply rate and a contact problem - not a 0.4% reply rate.
     * Those two readings call for opposite actions.
     */
    it("computes reply rate per lead contacted, not per lead acquired", async () => {
      const org = await newOrg("sources");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id }).returning();

      await seedLeads(org.id, [{ status: "new", source: "linkedin", n: 50 }]);
      const leadRows = await db.select().from(schema.leads).where(schema.eq(schema.leads.orgId, org.id));

      // Only 10 of the 50 were ever emailed; 2 of those replied.
      for (let i = 0; i < 10; i++) {
        await db.insert(schema.messages).values({
          orgId: org.id,
          campaignId: campaign.id,
          leadId: leadRows[i].id,
          toEmail: leadRows[i].email!,
          subject: "s",
          bodyText: "b",
          direction: "outbound",
          status: "sent",
          sentAt: new Date(),
          repliedAt: i < 2 ? new Date() : null,
        });
      }

      const r = await sourcePerformance(org.id, 90);
      const row = r.sources.find((s: any) => s.source === "linkedin");
      expect(row.leads).toBe(50);
      expect(row.contacted).toBe(10);
      expect(row.replied).toBe(2);
      expect(row.replyRate).toBeCloseTo(0.2, 4); // not 2/50
      expect(row.sufficient).toBe(false); // 10 contacted is too few to call it a rate
    });

    it("does not double-count a lead that received several messages", async () => {
      const org = await newOrg("sources-dupe");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id }).returning();
      await seedLeads(org.id, [{ status: "new", source: "search", n: 1 }]);
      const [lead] = await db.select().from(schema.leads).where(schema.eq(schema.leads.orgId, org.id));

      for (let i = 0; i < 4; i++) {
        await db.insert(schema.messages).values({
          orgId: org.id, campaignId: campaign.id, leadId: lead.id, toEmail: lead.email!,
          subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date(),
          repliedAt: i === 3 ? new Date() : null,
        });
      }

      const row = (await sourcePerformance(org.id, 90)).sources.find((s: any) => s.source === "search");
      // One lead, four touches. The join must not make that four leads.
      expect(row.leads).toBe(1);
      expect(row.contacted).toBe(1);
      expect(row.replied).toBe(1);
    });

    /**
     * Two qualified leads reached by DIFFERENT steps. A per-step count cannot be recombined
     * afterwards - summing double-counts anyone who got several steps, and taking the max
     * reports the campaign's qualified leads as the size of its busiest step cohort, which
     * is what the first version did.
     */
    it("counts a campaign's qualified leads once, across all its steps", async () => {
      const org = await newOrg("attribution-qualified");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "Split", emailAccountId: acct.id }).returning();
      const [s1] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "a", bodyTemplate: "a" }).returning();
      const [s2] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 2, channel: "email", subjectTemplate: "b", bodyTemplate: "b" }).returning();
      await seedLeads(org.id, [{ status: "qualified", n: 2 }]);
      const [a, b] = await db.select().from(schema.leads).where(schema.eq(schema.leads.orgId, org.id));

      // Lead A only ever received step 1; lead B only ever received step 2.
      await db.insert(schema.messages).values({ orgId: org.id, campaignId: campaign.id, stepId: s1.id, leadId: a.id, toEmail: a.email!, subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date() });
      await db.insert(schema.messages).values({ orgId: org.id, campaignId: campaign.id, stepId: s2.id, leadId: b.id, toEmail: b.email!, subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date() });

      const c = (await campaignAttribution(org.id, 90)).campaigns.find((x: any) => x.campaign === "Split");
      // Max across step rows would say 1. Summing would also say 2 here but double-counts
      // the moment one lead receives both steps, which the next assertion covers.
      expect(c.qualifiedLeads).toBe(2);
    });

    it("counts each qualified lead once per campaign, however many steps reached it", async () => {
      /**
       * Three qualified leads, reached unevenly: one by step 1 only, one by step 2 only,
       * one by both.
       *
       * The uneven part is the whole test. An earlier version seeded a single lead that
       * received both steps and asserted 1, which passes against the broken implementation
       * too: per-step counts of 1 and 1 recombined with `max` give 1. Here the per-step
       * cohorts are 2 and 2, so `max` reports 2 and summing reports 4, and only counting
       * distinct leads per campaign gives 3.
       */
      const org = await newOrg("attribution-onelead");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "Both", emailAccountId: acct.id }).returning();
      const [s1] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "a", bodyTemplate: "a" }).returning();
      const [s2] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 2, channel: "email", subjectTemplate: "b", bodyTemplate: "b" }).returning();
      await seedLeads(org.id, [{ status: "customer", n: 3 }]);
      const rows = await db.select().from(schema.leads).where(schema.eq(schema.leads.orgId, org.id));
      expect(rows.length).toBe(3);

      const reach = async (lead: (typeof rows)[number], step: typeof s1) => {
        await db.insert(schema.messages).values({ orgId: org.id, campaignId: campaign.id, stepId: step.id, leadId: lead.id, toEmail: lead.email!, subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date() });
      };
      await reach(rows[0], s1);
      await reach(rows[1], s2);
      await reach(rows[2], s1);
      await reach(rows[2], s2);

      const c = (await campaignAttribution(org.id, 90)).campaigns.find((x: any) => x.campaign === "Both");
      expect(c.qualifiedLeads).toBe(3);
      // And the per-step cohorts really are uneven, so the assertion above discriminates.
      expect(c.steps.map((x: any) => x.sent).sort()).toEqual([2, 2]);
    });

    it("credits a reply to its campaign and step, and withholds a best step on thin data", async () => {
      const org = await newOrg("attribution");
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "Outbound Q4", emailAccountId: acct.id }).returning();
      const [s1] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "a", bodyTemplate: "a" }).returning();
      await seedLeads(org.id, [{ status: "replied", n: 3 }]);
      const leadRows = await db.select().from(schema.leads).where(schema.eq(schema.leads.orgId, org.id));

      for (const l of leadRows) {
        await db.insert(schema.messages).values({
          orgId: org.id, campaignId: campaign.id, stepId: s1.id, leadId: l.id, toEmail: l.email!,
          subject: "s", bodyText: "b", direction: "outbound", status: "sent", sentAt: new Date(), repliedAt: new Date(),
        });
      }

      const a = await campaignAttribution(org.id, 90);
      const c = a.campaigns.find((x: any) => x.campaign === "Outbound Q4");
      expect(c.sent).toBe(3);
      expect(c.replied).toBe(3);
      expect(c.steps[0].stepNo).toBe(1);
      // Three sends is not evidence that step 1 is the best step.
      expect(c.sufficient).toBe(false);
      expect(c.bestStep).toBeNull();
      expect(a.model).toMatch(/last-touch/i);
    });
  });

  /**
   * Client workspaces: every lead belongs to a client or waits in the pool.
   *
   * These pin the rules that stop leads going to waste or going to the wrong place: one
   * owner per lead, counts that say what was NOT done, routing that acts only on evidence,
   * and a public report that never carries contact data.
   */
  describe("client workspaces", () => {
    let svc: any;
    beforeAll(async () => {
      svc = await import("./services/clients.js");
    });

    async function lead(orgId: string, patch: Record<string, unknown> = {}) {
      const [row] = await db
        .insert(schema.leads)
        .values({ orgId, fullName: "Person", email: `cw-${randomUUID().slice(0, 8)}@example.com`, emailStatus: "valid", ...patch })
        .returning();
      return row;
    }

    async function companyRow(orgId: string, patch: Record<string, unknown>) {
      const [row] = await db
        .insert(schema.companies)
        .values({ orgId, domain: `${randomUUID().slice(0, 8)}.example.com`, ...patch })
        .returning();
      return row;
    }

    async function icp(orgId: string, criteria: Record<string, unknown>) {
      const [row] = await db.insert(schema.icps).values({ orgId, name: `icp-${randomUUID().slice(0, 6)}`, criteria }).returning();
      return row;
    }

    it("creates a client and reports what was delivered to it", async () => {
      const org = await newOrg("cw-overview");
      const c = await svc.createClient(org.id, { name: "Acme", monthlyLeadTarget: 100 });
      const a = await lead(org.id);
      const b = await lead(org.id, { email: null, emailStatus: "unknown" });
      await lead(org.id); // stays in the pool

      const r = await svc.assignLeads(org.id, c.id, [a.id, b.id]);
      expect(r.assigned).toBe(2);

      const o = await svc.clientOverview(org.id);
      const row = o.clients.find((x: any) => x.id === c.id);
      expect(row.stats.leads).toBe(2);
      expect(row.stats.deliveredThisMonth).toBe(2);
      expect(row.stats.verified).toBe(1);
      expect(row.target.target).toBe(100);
      expect(row.attention.noEmail).toBe(1);
      expect(o.pool.leads).toBe(1);
      // The share token is a credential and must not leak through the list endpoint.
      expect(row.shareToken).toBeUndefined();
    });

    it("never takes a lead from another client unless a move is asked for, and says so", async () => {
      const org = await newOrg("cw-exclusive");
      const a = await svc.createClient(org.id, { name: "A" });
      const b = await svc.createClient(org.id, { name: "B" });
      const l = await lead(org.id);

      await svc.assignLeads(org.id, a.id, [l.id]);
      const again = await svc.assignLeads(org.id, b.id, [l.id, randomUUID()]);
      expect(again.assigned).toBe(0);
      expect(again.ownedByAnotherClient).toBe(1);
      expect(again.notFound).toBe(1);

      const same = await svc.assignLeads(org.id, a.id, [l.id]);
      expect(same.alreadyThisClient).toBe(1);

      const moved = await svc.assignLeads(org.id, b.id, [l.id], { move: true });
      expect(moved.assigned).toBe(1);
      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, l.id) });
      expect(after.clientId).toBe(b.id);
    });

    it("keeps one workspace's leads and clients out of another's", async () => {
      const orgA = await newOrg("cw-ten-a");
      const orgB = await newOrg("cw-ten-b");
      const clientA = await svc.createClient(orgA.id, { name: "Mine" });
      const theirs = await lead(orgB.id);

      const r = await svc.assignLeads(orgA.id, clientA.id, [theirs.id]);
      expect(r.assigned).toBe(0);
      expect(r.notFound).toBe(1);
      await expect(svc.requireClient(orgB.id, clientA.id)).rejects.toThrow();
      // Another workspace's ICP cannot be attached either.
      const foreignIcp = await icp(orgB.id, { titles: ["CEO"] });
      await expect(svc.createClient(orgA.id, { name: "X", icpId: foreignIcp.id })).rejects.toThrow(/does not exist/);
    });

    it("rejects a duplicate client name in the same workspace", async () => {
      const org = await newOrg("cw-dupe");
      await svc.createClient(org.id, { name: "Globex" });
      await expect(svc.createClient(org.id, { name: "globex" })).rejects.toThrow(/already exists/);
    });

    it("returns a deleted client's leads to the pool instead of losing them", async () => {
      const org = await newOrg("cw-delete");
      const c = await svc.createClient(org.id, { name: "Gone" });
      const l = await lead(org.id);
      await svc.assignLeads(org.id, c.id, [l.id]);
      const r = await svc.deleteClient(org.id, c.id);
      expect(r.leadsReturnedToPool).toBe(1);
      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, l.id) });
      expect(after).toBeTruthy();
      expect(after.clientId).toBeNull();
    });

    it("counts ready-but-idle leads: verified, uncontacted, a week old, in no campaign", async () => {
      const org = await newOrg("cw-idle");
      const c = await svc.createClient(org.id, { name: "Idle Co" });
      const old = await lead(org.id);
      const fresh = await lead(org.id);
      const unverified = await lead(org.id, { emailStatus: "unknown" });
      const bad = await lead(org.id, { emailStatus: "invalid" });
      await svc.assignLeads(org.id, c.id, [old.id, fresh.id, unverified.id, bad.id]);
      await db.execute(schema.sql`UPDATE leads SET client_assigned_at = now() - interval '9 days' WHERE id = ${old.id}`);

      const d = await svc.clientDetail(org.id, c.id);
      expect(d.attention.readyButIdle).toBe(1);
      expect(d.attention.unverified).toBe(1);
      expect(d.attention.badEmail).toBe(1);
      expect((await svc.attentionLeadIds(org.id, c.id, "readyButIdle")).ids).toEqual([old.id]);

      // Once it is in a campaign it is being used, and stops counting as waste.
      const acct = await newAccount(org.id);
      const [camp] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id }).returning();
      await db.insert(schema.campaignContacts).values({ campaignId: camp.id, leadId: old.id });
      expect((await svc.clientDetail(org.id, c.id)).attention.readyButIdle).toBe(0);
    });

    describe("routing the pool", () => {
      it("routes a clear fit, holds a contested one, and never routes on no data", async () => {
        const org = await newOrg("cw-route");
        const fintechIcp = await icp(org.id, { industries: ["fintech"], titles: ["head of growth", "vp growth"] });
        const healthIcp = await icp(org.id, { industries: ["healthcare"], titles: ["head of growth", "vp growth"] });
        const fin = await svc.createClient(org.id, { name: "FinClient", icpId: fintechIcp.id });
        await svc.createClient(org.id, { name: "HealthClient", icpId: healthIcp.id });
        await svc.createClient(org.id, { name: "NoIcpClient" });

        const finCo = await companyRow(org.id, { name: "PayCo", industry: "Fintech" });
        const clear = await lead(org.id, { title: "VP Growth", companyId: finCo.id });
        // Fits neither industry, identical title match for both: a coin toss.
        const otherCo = await companyRow(org.id, { name: "RetailCo", industry: "Retail" });
        const tie = await lead(org.id, { title: "Head of Growth", companyId: otherCo.id });
        // Nothing to score on at all.
        const blank = await lead(org.id, { title: null });
        // Right title, known-wrong industry. Scores above the bar on title alone; must not
        // be handed to the fintech client without a person looking.
        const retailCo = await companyRow(org.id, { name: "ShopLane", industry: "Retail" });
        const wrongIndustry = await lead(org.id, { title: "VP Growth", companyId: retailCo.id });

        const r = await svc.routeSuggestions(org.id);
        const routable = r.routable.map((x: any) => x.leadId);
        expect(routable).toContain(clear.id);
        expect(r.routable.find((x: any) => x.leadId === clear.id).best.clientId).toBe(fin.id);
        expect(routable).not.toContain(tie.id);
        expect(routable).not.toContain(blank.id);
        expect(routable).not.toContain(wrongIndustry.id);
        const partial = r.held.partialFit.find((x: any) => x.leadId === wrongIndustry.id);
        expect(partial).toBeTruthy();
        expect(partial.mismatches).toContain("industry match");
        // The client that can never receive anything is named, with the reason.
        expect(r.unroutableClients.map((u: any) => u.reason)).toContain("no_icp");

        const auto = await svc.autoRoute(org.id);
        expect(auto.routed).toBe(1);
        const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, clear.id) });
        expect(after.clientId).toBe(fin.id);
        const tieAfter = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, tie.id) });
        expect(tieAfter.clientId).toBeNull();
      });

      it("does not route to archived or paused clients", async () => {
        const org = await newOrg("cw-route-archived");
        const i = await icp(org.id, { industries: ["fintech"], titles: ["vp growth"] });
        const c = await svc.createClient(org.id, { name: "Paused", icpId: i.id, status: "paused" });
        const co = await companyRow(org.id, { name: "P", industry: "Fintech" });
        await lead(org.id, { title: "VP Growth", companyId: co.id });
        const r = await svc.routeSuggestions(org.id);
        expect(r.routable).toHaveLength(0);
        await expect(svc.assignLeads(org.id, (await svc.updateClient(org.id, c.id, { status: "archived" })).id, [randomUUID()])).rejects.toThrow(/archived/);
      });
    });

    it("claims a search's leads for its client without stealing another client's", async () => {
      const org = await newOrg("cw-claim");
      const a = await svc.createClient(org.id, { name: "A" });
      const b = await svc.createClient(org.id, { name: "B" });
      const mine = await lead(org.id);
      const hers = await lead(org.id);
      await svc.assignLeads(org.id, b.id, [hers.id]);
      const r = await svc.claimSearchLeads(db, org.id, a.id, [mine.id, hers.id]);
      expect(r).toEqual({ claimed: 1, ownedByAnotherClient: 1 });
      const hersAfter = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, hers.id) });
      expect(hersAfter.clientId).toBe(b.id);
    });

    describe("fixes from review", () => {
      it("never routes on an ICP made only of exclusions", async () => {
        const org = await newOrg("cw-exclude-only");
        const excl = await icp(org.id, { excludeKeywords: ["student"] });
        await svc.createClient(org.id, { name: "ExcludeOnly", icpId: excl.id });
        const barista = await lead(org.id, { title: "Barista" });
        const r = await svc.routeSuggestions(org.id);
        expect(r.routable.map((x: any) => x.leadId)).not.toContain(barista.id);
        expect(r.unroutableClients.map((u: any) => u.name)).toContain("ExcludeOnly");
      });

      it("does not write a search's leads to a client deleted or archived since it was submitted", async () => {
        const org = await newOrg("cw-claim-gone");
        const gone = await svc.createClient(org.id, { name: "Gone" });
        const shelved = await svc.createClient(org.id, { name: "Shelved" });
        const l = await lead(org.id);
        await svc.deleteClient(org.id, gone.id);
        await svc.updateClient(org.id, shelved.id, { status: "archived" });
        expect(await svc.claimSearchLeads(db, org.id, gone.id, [l.id])).toMatchObject({ claimed: 0, skipped: "client_deleted" });
        expect(await svc.claimSearchLeads(db, org.id, shelved.id, [l.id])).toMatchObject({ claimed: 0, skipped: "client_archived" });
        expect((await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, l.id) })).clientId).toBeNull();
      });

      it("routes only the leads a person was shown", async () => {
        const org = await newOrg("cw-route-shown");
        const i = await icp(org.id, { industries: ["fintech"], titles: ["vp growth"] });
        const c = await svc.createClient(org.id, { name: "Fin", icpId: i.id });
        const co = await companyRow(org.id, { name: "P", industry: "Fintech" });
        const shown = await lead(org.id, { title: "VP Growth", companyId: co.id });
        const notShown = await lead(org.id, { title: "VP Growth", companyId: co.id });
        const r = await svc.autoRoute(org.id, { leadIds: [shown.id] });
        expect(r.routed).toBe(1);
        expect((await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, shown.id) })).clientId).toBe(c.id);
        expect((await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, notShown.id) })).clientId).toBeNull();
      });

      it("counts a delivery once, however many times the lead comes back through the pool", async () => {
        const org = await newOrg("cw-redeliver");
        const c = await svc.createClient(org.id, { name: "Once" });
        const l = await lead(org.id);
        await svc.assignLeads(org.id, c.id, [l.id]);
        // First delivered two months ago.
        await db.execute(schema.sql`UPDATE client_lead_deliveries SET delivered_at = now() - interval '60 days' WHERE lead_id = ${l.id}`);
        await svc.unassignLeads(org.id, [l.id]);
        await svc.assignLeads(org.id, c.id, [l.id]);
        const row = (await svc.clientOverview(org.id)).clients.find((x: any) => x.id === c.id);
        expect(row.stats.leads).toBe(1);
        expect(row.stats.deliveredThisMonth).toBe(0);

        // A genuinely new client for that person is a new delivery - once.
        const other = await svc.createClient(org.id, { name: "Other" });
        await svc.assignLeads(org.id, other.id, [l.id], { move: true });
        const o = (await svc.clientOverview(org.id)).clients.find((x: any) => x.id === other.id);
        expect(o.stats.deliveredThisMonth).toBe(1);
      });

      it("stops the previous client's sequence when a lead is moved, and not when it is pooled", async () => {
        const org = await newOrg("cw-move-stop");
        const a = await svc.createClient(org.id, { name: "A" });
        const b = await svc.createClient(org.id, { name: "B" });
        const l = await lead(org.id);
        await svc.assignLeads(org.id, a.id, [l.id]);
        const acct = await newAccount(org.id);
        const [camp] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "A seq", emailAccountId: acct.id, clientId: a.id }).returning();
        await db.insert(schema.campaignContacts).values({ campaignId: camp.id, leadId: l.id, status: "active" });

        await svc.unassignLeads(org.id, [l.id]);
        let cc = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.leadId, l.id) });
        expect(cc.status).toBe("active");

        await svc.assignLeads(org.id, a.id, [l.id]);
        const r = await svc.assignLeads(org.id, b.id, [l.id], { move: true });
        expect(r.stoppedSequences).toBe(1);
        cc = await db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.leadId, l.id) });
        expect(cc.status).toBe("reassigned");
        expect(cc.nextSendAt).toBeNull();
      });

      it("accounts for every id when returning leads to the pool", async () => {
        const org = await newOrg("cw-unassign-counts");
        const c = await svc.createClient(org.id, { name: "C" });
        const owned = await lead(org.id);
        const pooled = await lead(org.id);
        await svc.assignLeads(org.id, c.id, [owned.id]);
        const r = await svc.unassignLeads(org.id, [owned.id, pooled.id, randomUUID(), owned.id]);
        expect(r).toEqual({ requested: 3, returnedToPool: 1, alreadyInPool: 1, notFound: 1 });
      });

      it("keeps a client campaign to that client's leads, claiming unowned ones", async () => {
        const org = await newOrg("cw-enrol");
        const a = await svc.createClient(org.id, { name: "A" });
        const b = await svc.createClient(org.id, { name: "B" });
        const mine = await lead(org.id);
        const theirs = await lead(org.id);
        const nobodys = await lead(org.id);
        await svc.assignLeads(org.id, a.id, [mine.id]);
        await svc.assignLeads(org.id, b.id, [theirs.id]);
        const p = await svc.partitionForClientCampaign(db, org.id, a.id, [mine.id, theirs.id, nobodys.id]);
        expect(p.allowed.sort()).toEqual([mine.id, nobodys.id].sort());
        expect(p.claimed).toBe(1);
        expect(p.ownedByAnotherClient).toBe(1);
        expect((await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, nobodys.id) })).clientId).toBe(a.id);
      });

      it("does not let one client's ICP link overwrite another's, and releases it on switch", async () => {
        const org = await newOrg("cw-icp-link");
        const shared = await icp(org.id, { titles: ["cto"] });
        const a = await svc.createClient(org.id, { name: "A", icpId: shared.id });
        await svc.createClient(org.id, { name: "B", icpId: shared.id });
        expect((await db.query.icps.findFirst({ where: schema.eq(schema.icps.id, shared.id) })).clientId).toBe(a.id);

        const own = await icp(org.id, { titles: ["cfo"] });
        await svc.updateClient(org.id, a.id, { icpId: own.id });
        expect((await db.query.icps.findFirst({ where: schema.eq(schema.icps.id, shared.id) })).clientId).toBeNull();
        expect((await db.query.icps.findFirst({ where: schema.eq(schema.icps.id, own.id) })).clientId).toBe(a.id);
      });

      it("reports the true size of an attention bucket, not just what one action takes", async () => {
        const org = await newOrg("cw-bucket-total");
        const c = await svc.createClient(org.id, { name: "C" });
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push((await lead(org.id, { emailStatus: "unknown" })).id);
        await svc.assignLeads(org.id, c.id, ids);
        const r = await svc.attentionLeadIds(org.id, c.id, "unverified", 2);
        expect(r.ids).toHaveLength(2);
        expect(r.total).toBe(3);
      });

      it("tells a client the list is complete when the only leads left out are lost ones", async () => {
        const org = await newOrg("cw-report-lost");
        const c = await svc.createClient(org.id, { name: "C" });
        const live = await lead(org.id);
        const lostOne = await lead(org.id, { status: "lost" });
        await svc.assignLeads(org.id, c.id, [live.id, lostOne.id]);
        const { shareToken } = await svc.enableSharing(org.id, c.id);
        const r = await svc.publicReport(shareToken);
        expect(r.shownLeads).toBe(1);
        expect(r.listTruncated).toBe(false);
      });
    });

    describe("the public client report", () => {
      it("shows the pipeline without a single email address, phone or profile URL", async () => {
        const org = await newOrg("cw-report");
        const c = await svc.createClient(org.id, { name: "Shared" });
        const l = await lead(org.id, { email: "secret.person@target.example", phone: "+1 555 0100", linkedinUrl: "https://linkedin.com/in/secret" });
        await svc.assignLeads(org.id, c.id, [l.id]);
        const { shareToken } = await svc.enableSharing(org.id, c.id);

        const r = await svc.publicReport(shareToken);
        expect(r.client.name).toBe("Shared");
        // Whether a client sees "behind target" is the agency's decision, off by default.
        expect(r.target).toBeNull();
        expect(r.leads).toHaveLength(1);
        const blob = JSON.stringify(r);
        expect(blob).not.toContain("secret.person");
        expect(blob).not.toContain("555");
        expect(blob).not.toContain("linkedin.com");

        await svc.updateClient(org.id, c.id, { monthlyLeadTarget: 10, reportShowTarget: true });
        expect((await svc.publicReport(shareToken)).target.target).toBe(10);
      });

      it("stops working the moment sharing is turned off, and never answers a guess", async () => {
        const org = await newOrg("cw-report-off");
        const c = await svc.createClient(org.id, { name: "Revoked" });
        const { shareToken } = await svc.enableSharing(org.id, c.id);
        expect(await svc.publicReport(shareToken)).not.toBeNull();
        await svc.disableSharing(org.id, c.id);
        expect(await svc.publicReport(shareToken)).toBeNull();
        expect(await svc.publicReport("short")).toBeNull();
        expect(await svc.publicReport("x".repeat(43))).toBeNull();
      });
    });
  });

  afterAll(async () => {
    // Nothing to tear down: every test uses a fresh org, and the database is disposable.
  });
});
