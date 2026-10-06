/**
 * Reading a competitor's pages for its customers: what is a customer, and what never is.
 *
 * The fixtures are shaped like real marketing sites - a customers page with a logo wall
 * next to an integrations wall, partner, investor and press rows, a navigation bar and a
 * footer full of logos - because the failure this guards against is a company turning up
 * as "a customer of Acme" when the page said no such thing.
 */
import { describe, expect, it } from "vitest";
import { caseSlugOf, cleanLogoName, customerLinksFromSitemap, extractCustomers, parseHeadline, slugCustomerName, verifyAiCustomers } from "./extractCustomers.js";
import { cleanCompanyName, isSameCompany, isVendorName, slugToName } from "./shared.js";
import { CUSTOMERS_PAGE, page } from "./kit.test.js";

const ACME = { name: "Acme", domain: "acme.com" };

const names = (html: string, url = "https://acme.com/customers") => extractCustomers(html, url, ACME).hits.map((h) => h.name).sort();

describe("a customers page: who is named, and who is not", () => {
  const out = extractCustomers(CUSTOMERS_PAGE, "https://acme.com/customers", ACME);
  const byName = new Map(out.hits.map((h) => [h.name, h]));

  it("finds the companies the page presents as customers", () => {
    expect([...byName.keys()].sort()).toEqual(["Globex", "Hooli", "Initech", "Oscorp", "Soylent", "Stark Industries", "Tyrell", "Umbrella Corp", "Wayne Enterprises"]);
  });

  it("never reports vendors, integrations, partners, investors, press, social links, badges or the competitor itself", () => {
    for (const no of ["Acme", "Google", "Stripe", "AWS", "Slack", "Salesforce", "Zapier", "Pied Piper", "Vandelay Industries", "Wonka Consulting", "Sequoia", "Massive Dynamic Ventures", "TechCrunch", "Cyberdyne Times", "LinkedIn", "Twitter", "G2", "SOC 2", "Benchmark Capital"]) {
      expect(byName.has(no), `${no} must not be a customer`).toBe(false);
    }
  });

  it("never reports navigation words, market segments, people or calls to action", () => {
    for (const no of ["Enterprise", "Remote Teams", "Remote teams", "Healthcare", "Become a reference", "Become A Reference", "Jane Doe", "Dana Scully", "Sam Lee", "Product", "Pricing", "All", "Page"]) {
      expect(byName.has(no), `${no} must not be a customer`).toBe(false);
    }
  });

  it("carries the words from the page for every hit", () => {
    expect(byName.get("Globex")).toMatchObject({ via: "logo", quote: "Globex logo" });
    expect(byName.get("Hooli")).toMatchObject({ via: "logo", quote: "Hooli logo" });
    expect(byName.get("Soylent")).toMatchObject({ via: "case_study", quote: "How Soylent cut onboarding time by 40%", headline: "How Soylent cut onboarding time by 40%" });
    expect(byName.get("Stark Industries")).toMatchObject({ via: "case_study", headline: "Why Stark Industries chose Acme for 12,000 employees" });
    expect(byName.get("Wayne Enterprises")).toMatchObject({ via: "case_study" });
    expect(byName.get("Wayne Enterprises")!.quote).toContain("Wayne Enterprises + Acme");
    expect(byName.get("Oscorp")).toMatchObject({ via: "testimonial", quote: "Dana Scully, VP Operations at Oscorp" });
    // A slug with no words around it: the quote is the link exactly as the page wrote it, and the confidence says so.
    expect(byName.get("Tyrell")).toMatchObject({ via: "case_study", quote: "/customers/tyrell", confidence: 0.55 });
    for (const h of out.hits) {
      expect(h.quote.length).toBeGreaterThan(0);
      expect(CUSTOMERS_PAGE.replace(/\s+/g, " ")).toContain(h.quote);
    }
  });

  it("takes a customer's domain only from a link the page itself makes", () => {
    expect(byName.get("Umbrella Corp")!.domain).toBe("umbrellacorp.com");
    expect(byName.get("Globex")!.domain).toBeUndefined();
    expect(byName.get("Soylent")!.domain).toBeUndefined();
  });

  it("offers the site's own customer pages to read next, and nothing off the site", () => {
    const urls = out.links.map((l) => l.url);
    expect(urls).toContain("https://acme.com/case-studies");
    expect(urls).toContain("https://acme.com/customers/soylent");
    expect(urls.every((u) => u.startsWith("https://acme.com/"))).toBe(true);
    expect(urls.some((u) => /pricing|integrations|product/.test(u))).toBe(false);
    expect(out.links.find((l) => l.url === "https://acme.com/case-studies")!.score).toBe(90);
    expect(out.links.find((l) => l.url === "https://acme.com/customers/soylent")!.score).toBe(60);
  });

  it("gives a model the page's content without navigation or footer", () => {
    expect(out.text).toContain("Trusted by teams at");
    expect(out.text).toContain("Dana Scully, VP Operations at Oscorp");
    expect(out.text).not.toContain("Pricing");
    expect(out.text).not.toContain("Built in Lisbon");
  });
});

describe("a home page: logos count only under a label that says they are customers", () => {
  it("reads a 'trusted by' strip and ignores everything else on the page", () => {
    const html = page(
      "Acme - onboarding that runs itself",
      `
<nav><a href="/customers">Customers</a><a href="/about">About</a></nav>
<section class="hero"><h1>Onboarding that runs itself</h1><img src="/img/dashboard.png" alt="Acme dashboard"><a href="/signup">Start free</a></section>
<div class="social-proof"><p>Trusted by 4,000+ teams</p>
  <div class="row"><img src="/a/1.svg" alt="Globex"><img src="/a/2.svg" alt="Initech"><img src="/a/3.svg" alt="Hooli"></div>
  <div class="row"><img src="/a/4.svg" alt="Soylent"><img src="/a/5.svg" alt="Tyrell Corp"></div>
</div>
<section class="features"><h2>Everything in one place</h2>
  <img src="/f/a.svg" alt="Analytics icon"><img src="/f/b.svg" alt="Workflow builder"><img src="/f/c.svg" alt="Reports"></section>
<section><h2>Works with your stack</h2><img src="/s/1.svg" alt="Okta logo"><img src="/s/2.svg" alt="Cyberdyne logo"><img src="/s/3.svg" alt="Workday logo"></section>
<footer><img src="/logo.svg" alt="Acme"></footer>`,
    );
    expect(names(html, "https://acme.com/")).toEqual(["Globex", "Hooli", "Initech", "Soylent", "Tyrell Corp"]);
  });

  it("finds nothing on a page with logos but no customer label", () => {
    const html = page(
      "Acme",
      `<main><h1>Meet Acme</h1><div class="grid"><img src="/x/1.svg" alt="Globex logo"><img src="/x/2.svg" alt="Initech logo"><img src="/x/3.svg" alt="Hooli logo"></div>
       <h2>Integrations</h2><div class="logos"><img alt="Globex logo" src="/x/1.svg"></div></main>`,
    );
    expect(names(html, "https://acme.com/")).toEqual([]);
  });

  it("a label that mixes customers and partners is not a customer label", () => {
    const html = page("Acme", `<main><h2>Trusted by our customers and partners</h2><div><img alt="Globex logo" src="/1.svg"><img alt="Initech logo" src="/2.svg"><img alt="Hooli logo" src="/3.svg"></div></main>`);
    expect(names(html, "https://acme.com/")).toEqual([]);
  });

  it("two unlabelled pictures after a label are not a logo wall", () => {
    const html = page("Acme", `<main><p>Loved by teams at</p><div><img alt="Team offsite" src="/a.png"><img alt="Launch party" src="/b.png"></div></main>`);
    expect(names(html, "https://acme.com/")).toEqual([]);
  });

  it("photos of people in a testimonial slider are not customers", () => {
    const html = page(
      "Acme",
      `<main><h2>Loved by teams at</h2>
       <div class="testimonial-slider">
         <div class="testimonial"><img src="/p/1.png" alt="Priya Shah"><blockquote>Great.</blockquote></div>
         <div class="testimonial"><img src="/p/2.png" alt="Tom Baker"><blockquote>Superb.</blockquote></div>
         <div class="testimonial"><img src="/p/3.png" alt="Lena Fox"><blockquote>Fast.</blockquote></div>
       </div></main>`,
    );
    expect(names(html, "https://acme.com/")).toEqual([]);
  });
});

describe("links and pictures that look like customers and are not", () => {
  it("site sections under /customers are not customers, however they are capitalised", () => {
    const html = page(
      "Customers | Acme",
      `<main><h1>Our customers</h1>
        <a href="/customers/globex"><h3>How Globex cut onboarding time</h3></a>
        <a href="/customers/initech"><h3>Initech case study</h3></a>
        <a href="/customers/hooli">Hooli</a>
        <a href="/customers/portal">Customer Portal</a>
        <a href="/customers/community">Join the Community</a>
        <a href="/customers/faq">FAQ</a>
        <a href="/customers/love">wall of love</a>
        <a href="/customers/soylent">read more</a>
      </main>`,
    );
    // Soylent is named only by its link (a short, distinctive slug on a page that is an index of stories).
    expect(names(html)).toEqual(["Globex", "Hooli", "Initech", "Soylent"]);
  });

  it("a lone link under /customers on a page that is not an index of stories names nobody", () => {
    const html = page("Acme", `<main><h1>Acme</h1><p>See what <a href="/customers/tyrell">one customer</a> says.</p></main>`);
    expect(names(html, "https://acme.com/")).toEqual([]);
  });

  it("story thumbnails under a 'customer stories' heading are not logos", () => {
    const html = page(
      "Acme",
      `<main><h2>Customer stories</h2><div class="grid">
        <div><img src="/t/1.png" alt="Warehouse Automation"><p>Faster picking</p></div>
        <div><img src="/t/2.png" alt="Remote Onboarding"><p>Hiring anywhere</p></div>
        <div><img src="/t/3.png" alt="Global Payroll"><p>One run</p></div>
        <div><img src="/t/4.svg" alt="Globex logo"><p>Logistics</p></div>
      </div></main>`,
    );
    expect(names(html, "https://acme.com/")).toEqual(["Globex"]);
  });

  it("a block classed 'customers' is a logo wall only for pictures that say they are logos", () => {
    const html = page(
      "Acme",
      `<main><section class="customers">
        <img src="/t/1.png" alt="Warehouse Automation"><img src="/t/2.png" alt="Remote Onboarding"><img src="/t/3.png" alt="Global Payroll">
        <img src="/c/globex.svg" alt="Globex logo">
      </section>
      <div class="customer-logos"><img src="/c/1.svg" alt="Initech"><img src="/c/2.svg" alt="Hooli"><img src="/c/3.svg" alt="Soylent"></div>
      <div class="partner-logos customers"><img src="/c/4.svg" alt="Vandelay logo"></div></main>`,
    );
    expect(names(html, "https://acme.com/")).toEqual(["Globex", "Hooli", "Initech", "Soylent"]);
  });

  it("a header and footer built from plain divs are still not content", () => {
    const html = page(
      "Acme",
      `<div class="header"><a href="/"><img src="/logo.svg" alt="Acme logo"></a><a href="/customers/hooli">Hooli story</a><span>Trusted by</span><img src="/n/1.svg" alt="Navco logo"><img src="/n/2.svg" alt="Menuco logo"></div>
       <div id="content"><h2>Trusted by</h2><div class="logos"><img src="/l/1.svg" alt="Globex logo"><img src="/l/2.svg" alt="Initech logo"></div></div>
       <div id="footer"><p>Our customers</p><img src="/f/1.svg" alt="Footco logo"><img src="/f/2.svg" alt="Basementco logo"></div>`,
    );
    expect(names(html, "https://acme.com/")).toEqual(["Globex", "Initech"]);
  });
});

describe("case-study headlines", () => {
  it.each([
    ["How Globex cut onboarding time by 40%", "Globex"],
    ["How Globex Cut Onboarding Time By 40%", "Globex"],
    ["How Globex's support team saved 200 hours a month", "Globex"],
    ["How the team at Initech doubled activation", "Initech"],
    ["How Acme helped Hooli scale to 30 countries", "Hooli"],
    ["Why Stark Industries chose Acme", "Stark Industries"],
    ["Wayne Enterprises + Acme", "Wayne Enterprises"],
    ["Acme x Tyrell", "Tyrell"],
    ["Case study: Soylent", "Soylent"],
    ["Customer story - Umbrella Corp", "Umbrella Corp"],
    ["Oscorp case study", "Oscorp"],
    ["Globex cuts onboarding time by 40% with Acme", "Globex"],
    ["Initech chooses Acme to onboard 5,000 people", "Initech"],
    ["How Globex cut onboarding time | Acme Customers", "Globex"],
  ])("%s -> %s", (headline, name) => {
    expect(parseHeadline(headline, "Acme")).toBe(name);
  });

  it.each([
    "How to cut onboarding time in half",
    "How we cut onboarding time in half",
    "How teams use Acme to onboard faster",
    "How Top Brands Use Acme",
    "How Acme works",
    "Read the story",
    "Onboarding made easy",
    "Customer stories",
    "Acme and the future of work",
    "A Fortune 500 retailer cuts onboarding time",
    "How a Fortune 500 retailer cut onboarding time",
    "Why customers love Acme",
    "40% faster onboarding with Acme",
  ])("%s names nobody", (headline) => {
    expect(parseHeadline(headline, "Acme")).toBeNull();
  });
});

describe("slugs and names", () => {
  it("reads a case-study slug only when it is a name, not a headline or a section", () => {
    expect(caseSlugOf("/customers/globex")).toBe("globex");
    expect(caseSlugOf("/resources/case-studies/globex-corp/")).toBe("globex-corp");
    expect(caseSlugOf("/customers/stories/initech")).toBe("initech");
    expect(caseSlugOf("/customers")).toBeNull();
    expect(caseSlugOf("/customers/page/2")).toBeNull();
    expect(caseSlugOf("/customers/industry")).toBeNull();
    expect(caseSlugOf("/blog/customer-success-tips")).toBeNull();
    expect(slugCustomerName("globex", "Acme")).toMatchObject({ name: "Globex", weak: false });
    expect(slugCustomerName("stark-industries-case-study", "Acme")).toMatchObject({ name: "Stark Industries" });
    expect(slugCustomerName("acme-and-wayne-enterprises", "Acme")).toMatchObject({ name: "Wayne Enterprises" });
    expect(slugCustomerName("remote-teams", "Acme")).toMatchObject({ weak: true });
    expect(slugCustomerName("how-globex-cut-onboarding-time", "Acme")).toBeNull();
    expect(slugCustomerName("globex-cuts-costs", "Acme")).toBeNull();
    expect(slugCustomerName("become-a-reference", "Acme")).toBeNull();
    expect(slugCustomerName("2024", "Acme")).toBeNull();
  });

  it("turns a slug into a readable name", () => {
    expect(slugToName("globex-corp")).toBe("Globex Corp");
    expect(slugToName("x1_labs")).toBe("X1 Labs");
    expect(slugToName("acme")).toBe("Acme");
  });

  it("cleans a logo's description down to the company", () => {
    expect(cleanLogoName("Globex logo")).toBe("Globex");
    expect(cleanLogoName("Logo of Umbrella Corp")).toBe("Umbrella Corp");
    expect(cleanLogoName("globex-logo-white.svg")).toBe("Globex");
    expect(cleanLogoName("Initech company logo (dark)")).toBe("Initech");
    expect(cleanLogoName("logo")).toBeNull();
    expect(cleanLogoName("Customer logo")).toBeNull();
    expect(cleanLogoName("Partner: Vandelay")).toBeNull();
    expect(cleanLogoName("G2 High Performer badge")).toBeNull();
    expect(cleanLogoName("Globex increased revenue by 40% using Acme")).toBeNull();
  });

  it("refuses anything that does not read as a company name", () => {
    for (const no of ["", "logo", "Read more", "read the story", "Learn more ->", "https://evil.example/x", "a@b.co", "Customers", "Our Customers", "Globex cuts costs", "How it works", "40% faster", "Teams", "Sales Leaders", "<script>", "..."]) {
      expect(cleanCompanyName(no), JSON.stringify(no)).toBeNull();
    }
    for (const yes of ["Globex", "Bank of America", "Procter & Gamble", "3M", "eBay", "monday.com", "Globex Inc.", "Stark Industries"]) {
      expect(cleanCompanyName(yes), yes).toBe(yes);
    }
    // Control and invisible characters never survive, and the length is capped.
    expect(cleanCompanyName("Glo\u200Bbex\u0000 \u202ECorp\u0007")).toBe("Globex Corp");
    expect(isVendorName("Goo\u200Bgle")).toBe(true);
    expect(cleanCompanyName("A".repeat(80))).toBeNull();
  });

  it("knows a vendor and the competitor itself", () => {
    for (const v of ["Google", "google cloud", "Slack", "Stripe", "AWS", "Amazon Web Services", "LinkedIn", "Google Analytics", "Mixpanel", "TechCrunch", "Y Combinator", "G2"]) expect(isVendorName(v), v).toBe(true);
    for (const c of ["Globex", "Initech", "Stark Industries"]) expect(isVendorName(c), c).toBe(false);
    expect(isSameCompany("Acme", ACME)).toBe(true);
    expect(isSameCompany("Acme Inc.", ACME)).toBe(true);
    expect(isSameCompany("Acme Cloud", ACME)).toBe(true);
    expect(isSameCompany("Globex", ACME)).toBe(false);
  });
});

describe("one case-study page", () => {
  it("names the company from the page's own headline", () => {
    const html = page("How Globex cut onboarding time by 40% | Acme", `<main><article><header><h1>How Globex cut onboarding time by 40%</h1></header><p>Globex, a logistics company, had a problem.</p></article></main>`);
    const out = extractCustomers(html, "https://acme.com/customers/globex", ACME);
    expect(out.hits).toEqual([expect.objectContaining({ name: "Globex", via: "case_study", quote: "How Globex cut onboarding time by 40%", confidence: 0.9 })]);
  });

  it("a page under /customers that is not about a customer names nobody", () => {
    const html = page("Customer reviews | Acme", `<main><h1>Customer reviews</h1><p>Read what people say.</p></main>`);
    expect(extractCustomers(html, "https://acme.com/customers/reviews", ACME).hits).toEqual([]);
    const program = page("Join the Acme advocacy program", `<main><h1>Join the Acme advocacy program</h1></main>`);
    expect(extractCustomers(program, "https://acme.com/customers/advocacy-program", ACME).hits).toEqual([]);
  });

  it("reads a review's employer from structured data only when the page shows it too", () => {
    const ld = (org: string) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Acme", review: [{ "@type": "Review", author: { "@type": "Person", name: "Kim", worksFor: { "@type": "Organization", name: org } } }] })}</script>`;
    const shown = page("Acme reviews", `<main><h1>What people say</h1><p>Kim runs people operations at Vehement Logistics.</p></main>`, ld("Vehement Logistics"));
    expect(names(shown, "https://acme.com/")).toEqual(["Vehement Logistics"]);
    const hidden = page("Acme reviews", `<main><h1>What people say</h1><p>Nothing here.</p></main>`, ld("Vehement Logistics"));
    expect(names(hidden, "https://acme.com/")).toEqual([]);
  });
});

describe("the sitemap", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://acme.com/</loc></url>
    <url><loc>https://acme.com/customers</loc></url>
    <url><loc>https://acme.com/customers/globex</loc></url>
    <url><loc>https://www.acme.com/case-studies/initech?utm=1</loc></url>
    <url><loc>https://acme.com/blog/customer-success-tips</loc></url>
    <url><loc>https://acme.com/customers/whitepaper.pdf</loc></url>
    <url><loc>https://evil.example/customers/hooli</loc></url>
    <url><loc>http://169.254.169.254/customers/meta</loc></url>
  </urlset>`;

  it("lists customer pages on the same site only", () => {
    const { links, children } = customerLinksFromSitemap(xml, "acme.com");
    expect(children).toEqual([]);
    expect(links.map((l) => l.url).sort()).toEqual(["https://acme.com/customers", "https://acme.com/customers/globex", "https://www.acme.com/case-studies/initech"]);
  });

  it("reads an index of sitemaps as child sitemaps, same site only", () => {
    const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://acme.com/sitemap-pages.xml</loc></sitemap><sitemap><loc>https://acme.com/sitemap-customers.xml</loc></sitemap><sitemap><loc>https://cdn.other.example/sitemap.xml</loc></sitemap></sitemapindex>`;
    expect(customerLinksFromSitemap(index, "acme.com")).toEqual({ links: [], children: ["https://acme.com/sitemap-pages.xml", "https://acme.com/sitemap-customers.xml"] });
  });
});

describe("a model's suggestions are kept only where the page backs them up", () => {
  const text = "Northwind Traders moved 900 stores onto Acme in six weeks.\nContoso's finance team closes the books two days sooner.\nWe integrate with Slack.\nAcme integrates with Pied Piper and Hooli Chat.";

  it("keeps a name whose quote is on the page, word for word", () => {
    const { hits, dropped } = verifyAiCustomers({ customers: [{ name: "Northwind Traders", quote: "Northwind Traders moved 900 stores onto Acme in six weeks." }] }, text, ACME);
    expect(dropped).toBe(0);
    expect(hits).toEqual([{ name: "Northwind Traders", quote: "Northwind Traders moved 900 stores onto Acme in six weeks.", via: "ai", confidence: 0.65 }]);
  });

  it("drops a quote that is not on the page, a name that is not on the page, a vendor, the competitor, and junk", () => {
    const { hits, dropped } = verifyAiCustomers(
      {
        customers: [
          { name: "Northwind Traders", quote: "Northwind Traders saved $2M with Acme last year." },
          { name: "Fabrikam", quote: "Contoso's finance team closes the books two days sooner." },
          { name: "Slack", quote: "We integrate with Slack." },
          // On the page, word for word - but the quote does not name the company it is attached to.
          { name: "Contoso", quote: "Northwind Traders moved 900 stores onto Acme in six weeks." },
          // On the page, word for word, and names the company - as an integration, which is not a customer.
          { name: "Pied Piper", quote: "Acme integrates with Pied Piper and Hooli Chat." },
          { name: "Acme", quote: "Northwind Traders moved 900 stores onto Acme in six weeks." },
          { name: "Contoso", quote: "short" },
          { name: { toString: () => "Contoso" }, quote: ["x"] },
          "Contoso",
          null,
        ],
      },
      text,
      ACME,
    );
    expect(hits).toEqual([]);
    expect(dropped).toBe(10);
  });

  it("tolerates anything a model might return instead of the shape asked for", () => {
    for (const raw of [null, undefined, "customers", 42, [], {}, { customers: "Northwind" }, { customers: { name: "x" } }]) {
      expect(verifyAiCustomers(raw, text, ACME)).toEqual({ hits: [], dropped: 0 });
    }
  });
});
