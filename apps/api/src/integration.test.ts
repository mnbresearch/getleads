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
  let observationsFor: any;
  let knownBrands: any;

  beforeAll(async () => {
    const dbPkg = await import("@prospex/db");
    await dbPkg.runMigrations(TEST_DB);
    schema = dbPkg;
    db = dbPkg.getDb().db;
    ({ sendingHealthForAccount, experimentForStep } = await import("./services/campaigns.js"));
    ({ icpLearningSamples } = await import("./services/insights.js"));
    ({ visibilityOverview, observationsFor, knownBrands } = await import("./services/visibility.js"));
    ({ learnFromOutcomes } = await import("@prospex/core"));
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

  afterAll(async () => {
    // Nothing to tear down: every test uses a fresh org, and the database is disposable.
  });
});
