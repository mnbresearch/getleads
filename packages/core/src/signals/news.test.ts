import { describe, expect, it } from "vitest";
import { parseRss } from "./news.js";

/**
 * A feed is parsed on the event loop like a page, and the parser for it slows down the
 * same way with nesting: 80,000 elements inside each other took 3.6 s, a megabyte of
 * them minutes. A feed is checked by the same guard as a page before it is parsed.
 */
/** Milliseconds the work kept this process busy: the smaller of the time that passed and the processor time used (other tests slow the clock, not the code). */
async function busy(work: () => unknown): Promise<number> {
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  await work();
  const used = process.cpuUsage(cpu);
  return Math.min(performance.now() - t0, (used.user + used.system) / 1000);
}

describe("parseRss", () => {
  const item = (title: string, more = ""): string => `<item><title>${title}</title><link>https://news.example/a</link><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate><source url="https://techcrunch.com">TechCrunch</source><description>&lt;a href="https://news.example/a"&gt;Globex raises $5M&lt;/a&gt;&amp;nbsp;&lt;font color="#6f6f6f"&gt;TechCrunch&lt;/font&gt;</description>${more}</item>`;
  const feed = (items: string): string => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>News</title>${items}</channel></rss>`;

  it("reads a feed's items", () => {
    const items = parseRss(feed(item("Globex raises $5M Series A - TechCrunch").repeat(3)));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ title: "Globex raises $5M Series A", url: "https://news.example/a", source: "TechCrunch", summary: "Globex raises $5M TechCrunch" });
    expect(items[0].publishedAt?.toISOString()).toBe("2026-10-06T10:00:00.000Z");
  });

  it.each([
    ["80,000 elements inside each other", feed("<a>".repeat(80_000))],
    ["500,000 elements inside each other", feed("<item>".repeat(250_000))],
    ["100,000 items", feed("<item/>".repeat(100_000))],
    ["an element with 100,000 attributes", feed(`<item ${Array.from({ length: 100_000 }, (_, i) => `a${i.toString(36)}="1"`).join(" ")}/>`)],
  ])("a feed of %s is not parsed", async (_what, xml) => {
    expect(parseRss(xml)).toEqual([]);
    expect(await busy(() => parseRss(xml))).toBeLessThan(250);
  });

  it("a description built like a hostile page gives no summary and does not hold the process; overlong fields are cut", async () => {
    const nested = `&lt;div&gt;`.repeat(50_000);
    const xml = feed(item("Initech raises $2M", "") + `<item><title>${"Hooli ".repeat(2_000)}</title><link>https://news.example/b</link><description>${nested}</description></item>`);
    const items = parseRss(xml);
    expect(await busy(() => parseRss(xml))).toBeLessThan(1_000);
    expect(items).toHaveLength(2);
    expect(items[1].title.length).toBeLessThanOrEqual(500);
    expect(items[1].summary).toBe("");
  });
});
