import { afterEach, describe, expect, it } from "vitest";
import { resolveCompanyDomainDetailed } from "./companies.js";
import { resetSearchCache, type SearchProvider } from "../search/index.js";
import type { SearchResult } from "../types.js";

const provider = (results: SearchResult[]): SearchProvider => ({
  name: "stub",
  available: () => true,
  search: async () => results,
});

const r = (url: string, title: string, snippet = ""): SearchResult => ({ url, title, snippet, provider: "stub" });

afterEach(() => resetSearchCache());

/**
 * Resolving a company name to a domain is an identity decision: everything downstream -
 * guessed email addresses, the website crawl, which company a lead is filed under - inherits
 * whatever comes back. A wrong domain is therefore much worse than none, because nothing
 * downstream can detect it.
 */
describe("company domain resolution refuses to guess", () => {
  it("resolves a domain the search results actually corroborate", async () => {
    const res = await resolveCompanyDomainDetailed("Razorpay", undefined, {
      providers: [provider([
        r("https://razorpay.com/", "Razorpay: Online Payment Gateway", "Razorpay is a payments company"),
        r("https://en.wikipedia.org/wiki/Razorpay", "Razorpay - Wikipedia"),
      ])],
    });
    expect(res.domain).toBe("razorpay.com");
    expect(res.confidence).toBeGreaterThan(0.5);
    expect(res.reason).toMatch(/domain contains razorpay/);
  });

  it("returns nothing when the results are unrelated, rather than the first plausible domain", async () => {
    const res = await resolveCompanyDomainDetailed("Northwind Logistics", undefined, {
      providers: [provider([
        // A directory page, a blog and a competitor. None of these is the company.
        r("https://www.indiamart.com/listing-12345", "Top logistics suppliers"),
        r("https://freightwaves.com/news/2026/market", "Freight market news"),
        r("https://bluedart.com/", "Blue Dart Express"),
      ])],
    });
    // The old fallback returned indiamart.com or bluedart.com here with no caveat at all.
    expect(res.domain).toBeNull();
    expect(res.confidence).toBe(0);
    expect(res.reason).toMatch(/corroborated/i);
  });

  it("accepts a title match when the domain shares no word with the name", async () => {
    const res = await resolveCompanyDomainDetailed("Bharti Airtel", undefined, {
      providers: [provider([r("https://www.airtel.in/", "Bharti Airtel Limited - Official Site")])],
    });
    expect(res.domain).toBe("airtel.in");
    expect(res.reason).toMatch(/title names the company/);
  });

  it("does not treat an empty result set as a company without a website", async () => {
    const res = await resolveCompanyDomainDetailed("Anything", undefined, { providers: [provider([])] });
    expect(res.domain).toBeNull();
    expect(res.reason).toMatch(/provider failure/i);
  });

  it("never reports certainty, even on a perfect match", async () => {
    const res = await resolveCompanyDomainDetailed("Zomato", undefined, {
      providers: [provider([r("https://www.zomato.com/", "Zomato", "Zomato food delivery")])],
    });
    expect(res.confidence).toBeLessThanOrEqual(0.95);
  });
});
