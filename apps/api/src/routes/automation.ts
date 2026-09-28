import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb, scrapedLeads, eq } from "@prospex/db";
import { runLinkedInScraper, getScrapedLeads } from "../services/agents/linkedin-scraper.js";
import { requireAuth, orgId, type Env } from "../middleware.js";

export const automationRoutes = new Hono<Env>();
automationRoutes.use("*", requireAuth);

const scrapeInput = z.object({
  query: z.string().default("VP Sales at B2B SaaS companies"),
  count: z.coerce.number().min(1).max(1000).default(100),
});

const leadsQuery = z.object({
  company: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0),
});

// POST /automation/linkedin-scrape
// Start a LinkedIn scraping job
automationRoutes.post(
  "/linkedin-scrape",
  zValidator("json", scrapeInput),
  async (c) => {
    try {
      const org_id = orgId(c);
      const { query, count } = c.req.valid("json");

      const result = await runLinkedInScraper(org_id, query, count);

      return c.json({
        ...result,
        success: true,
      });
    } catch (error) {
      console.error("LinkedIn scraper error:", error);
      return c.json(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  }
);

// GET /automation/leads
// Query scraped leads
automationRoutes.get(
  "/leads",
  zValidator("query", leadsQuery),
  async (c) => {
    try {
      const org_id = orgId(c);
      const { company, limit, offset } = c.req.valid("query");

      const leads = await getScrapedLeads(org_id, {
        company,
        limit,
        offset,
      });

      return c.json({
        data: leads,
        count: leads.length,
      });
    } catch (error) {
      console.error("Get leads error:", error);
      return c.json(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  }
);
