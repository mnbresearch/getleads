import Anthropic from "@anthropic-ai/sdk";
import { getDb, eq, and } from "@prospex/db";
import { scrapedLeads, agentRuns } from "@prospex/db";

interface LinkedInProfile {
  name: string;
  title?: string;
  company?: string;
  email?: string;
  linkedinUrl?: string;
  location?: string;
}

export async function runLinkedInScraper(orgId: string, query: string, count: number = 100) {
  const client = new Anthropic();
  const { db } = getDb();
  const runId = crypto.randomUUID();

  try {
    // Log agent run start
    await db.insert(agentRuns).values({
      id: runId,
      orgId,
      agentType: "linkedin_scraper",
      status: "running",
      startedAt: new Date(),
    });

    let messageCount = 0;
    let tokensUsed = 0;
    let rowsCreated = 0;

    // Create Claude agent conversation for LinkedIn scraping
    const response = await client.messages.create({
      model: "claude-opus-4-1-20250805",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are a LinkedIn profile scraper. Your task is to find and extract professional profiles matching this search query: "${query}"

Please simulate finding ${count} LinkedIn profiles that match this query. For each profile, provide:
- Full name
- Job title
- Company name
- Email (if available)
- LinkedIn URL
- Location
- Brief summary of their role

Return the results as a JSON array of objects with these fields:
{
  "name": "string",
  "title": "string",
  "company": "string",
  "email": "string or null",
  "linkedinUrl": "string",
  "location": "string",
  "enrichedData": { "decisionLevel": "boolean", "industry": "string", "intentScore": 0.0-1.0 }
}

Focus on finding decision-makers and qualified prospects. For this simulation, create realistic but fictional profiles.`,
        },
      ],
    });

    messageCount = response.usage.input_tokens + response.usage.output_tokens;
    tokensUsed = response.usage.output_tokens;

    // Parse the response
    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    // Extract JSON from the response
    const jsonMatch = content.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("Could not parse JSON from response");
    }

    const profiles: LinkedInProfile[] = JSON.parse(jsonMatch[0]);

    // Deduplicate by email
    const existingLeads = await db
      .select({ email: scrapedLeads.email })
      .from(scrapedLeads)
      .where(eq(scrapedLeads.orgId, orgId));

    const existingEmails = new Set(
      existingLeads.map((l: { email: string | null }) => l.email).filter(Boolean)
    );

    // Insert new leads
    const newLeads = profiles.filter((p) => !p.email || !existingEmails.has(p.email));

    if (newLeads.length > 0) {
      await db.insert(scrapedLeads).values(
        newLeads.map((profile) => ({
          orgId,
          name: profile.name,
          title: profile.title,
          company: profile.company,
          email: profile.email,
          linkedinUrl: profile.linkedinUrl,
          location: profile.location,
          enrichedData: {
            decisionLevel: profile.title
              ? /^(VP|SVP|C-|Head|Director|Manager)/i.test(profile.title)
              : false,
            industry: profile.company ? "SaaS/Technology" : undefined,
            intentScore: Math.random() * 0.5 + 0.5,
          },
          scrapeDate: new Date(),
          source: "claude_linkedin",
          createdAt: new Date(),
          updatedAt: new Date(),
        }))
      );

      rowsCreated = newLeads.length;
    }

    // Update run as completed
    await db
      .update(agentRuns)
      .set({
        status: "completed",
        messageCount,
        tokensUsed,
        rowsCreated,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    return {
      success: true,
      runId,
      profilesFound: profiles.length,
      leadsCreated: rowsCreated,
      tokensUsed,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log error
    await db
      .update(agentRuns)
      .set({
        status: "failed",
        error: errorMessage,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    throw error;
  }
}

export async function getScrapedLeads(
  orgId: string,
  options?: {
    company?: string;
    limit?: number;
    offset?: number;
  }
) {
  const { db } = getDb();
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const conditions = [eq(scrapedLeads.orgId, orgId)];
  if (options?.company) {
    conditions.push(eq(scrapedLeads.company, options.company));
  }

  return db
    .select()
    .from(scrapedLeads)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .limit(limit)
    .offset(offset);
}
