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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

// Configure the connection before anything imports the db singleton.
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
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
    ({ withReschedule, ensureRecurringJobs, RECURRING_JOBS } = await import("./jobs.js"));
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
    it("charges aiMessages for every engine-sample, from the service itself", async () => {
      const org = await newOrg("vis-quota");
      const [prompt] = await db
        .insert(schema.visibilityPrompts)
        .values({ orgId: org.id, text: "What is the best B2B prospecting tool?", intent: "category", samplesPerRun: 2 })
        .returning();

      const before = (await getUsage(db, org.id)).usage.aiMessages.used;

      // A dummy key makes exactly one engine available; the calls themselves fail, which is
      // fine - the point is that the work was attempted and therefore billed. Metering only
      // successful calls would let a broken key run an org's sampling for free forever.
      const prevKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key-not-valid";
      try {
        const r = await sampleAcrossEngines(db, org.id, prompt, { samples: 2, plan: "free" });
        const after = (await getUsage(db, org.id)).usage.aiMessages.used;
        expect(after - before).toBe(2 * r.engines.length);
        expect(r.engines.length).toBeGreaterThan(0);
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
        await expect(sampleAcrossEngines(db, org.id, prompt, { plan: "free" })).rejects.toThrow(/No AI provider/i);
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
      // error, so the two are derived from the same constant and this pins that.
      expect(Object.keys(RECURRING_JOBS).sort()).toEqual(
        ["autopilots.tick", "campaign.tick", "monitors.tick", "signals.scan", "system.cleanup", "visibility.tick"].sort(),
      );
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
      return { r, rows, prior, cc, org };
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
      const { r, rows, prior } = await scenario("sending");
      expect(String(r.skipped)).toMatch(/unknown/i);
      expect(rows).toHaveLength(1);
      const row = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, prior.id) });
      // Recorded as uncertain rather than quietly marked sent or silently resent.
      expect(row!.status).toBe("unknown");
      expect(row!.error).toMatch(/never confirmed/i);
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
      expect(String(r.skipped ?? "")).not.toMatch(/already sent|unknown/i);
    });
  });

  afterAll(async () => {
    // Nothing to tear down: every test uses a fresh org, and the database is disposable.
  });
});
