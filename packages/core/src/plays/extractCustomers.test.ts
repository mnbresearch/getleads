/**
 * Reading a competitor's pages for its customers: what is a customer, and what never is.
 *
 * The fixtures are shaped like real marketing sites - a customers page with a logo wall
 * next to an integrations wall, partner, investor and press rows, a navigation bar and a
 * footer full of logos - because the failure this guards against is a company turning up
 * as "a customer of Acme" when the page said no such thing.
 */
import { describe, expect, it } from "vitest";
import { caseSlugOf, cleanLogoName, customerLinksFromSitemap, extractCustomers, parseHeadline, readLogoName, slugCustomerName, storyWorthOpening, verifyAiCustomers } from "./extractCustomers.js";
import { cleanCompanyName, isDescriptorName, isSameCompany, isVendorName, slugToName } from "./shared.js";
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

/* ───────────────────────────────── patterns met on real customer pages ───────────────────────────────── */

describe("a story about a customer the page does not name", () => {
  const LISTING = page(
    "Case studies | Acme",
    `<main><h1>Case studies</h1><section>
      <a href="/case-studies/environmental-services-company"><img src="/l/placeholder.svg" alt="Success Story Logo"><p class="card-name">Environmental Services Company</p></a>
      <a href="/case-studies/austrian-agency"><p class="card-name">Austrian Agency</p></a>
      <a href="/case-studies/pharmadata-company"><p class="card-name">A Pharmadata Company</p></a>
      <a href="/case-studies/polish-trade-org"><p class="card-name">Polish Trade Org</p></a>
      <a href="/case-studies/globex"><p class="card-name">Globex</p></a>
      <a href="/case-studies/allica-bank"><p class="card-name">Allica Bank</p></a>
      <a href="/case-studies/ford-motor-company"><p class="card-name">Ford Motor Company</p></a>
    </section></main>`,
  );

  it("a description standing in for a name is not a customer; a name with such a word in it is", () => {
    const out = extractCustomers(LISTING, "https://acme.com/case-studies", ACME);
    expect(out.hits.map((h) => h.name).sort()).toEqual(["Allica Bank", "Ford Motor Company", "Globex"]);
    // The listing has said all there is to say about the unnamed ones too: their stories are not worth opening.
    expect(out.told).toContain("acme.com/case-studies/austrian-agency");
    expect(out.told).toContain("acme.com/case-studies/globex");
  });

  it.each([
    ["Environmental Services Company", undefined, true],
    ["Austrian Agency", undefined, true],
    ["Polish Trade Org", undefined, true],
    ["Large Retailer", undefined, true],
    ["Fortune 500 Bank", undefined, true],
    ["Pharmadata Company", "A Pharmadata Company", true],
    ["Global Logistics Leader", "A Global Logistics Leader", true],
    ["Pharmadata Company", "Pharmadata Company", false],
    ["Allica Bank", undefined, false],
    ["Ford Motor Company", undefined, false],
    ["Cloud Guru", "The Cloud Guru story", false],
    ["Globex", "A Globex story", false],
    ["Initech", undefined, false],
  ])("%s (from %j) is a description: %s", (name, source, expected) => {
    expect(isDescriptorName(name, source)).toBe(expected);
  });
});

describe("a story card is read piece by piece, never as one line", () => {
  it("a tag next to the headline is not part of the name or of the headline", () => {
    const html = page(
      "Customers | Acme",
      `<main><h1>Customers</h1><div class="grid">
        <a href="/customers/hoolis-boosting-conversion-rates-with-acme" class="Link Cards_card__B5">
          <div class="Cards_eyebrow__l2"><span>SaaS</span></div>
          <div class="Cards_logo__rV"><img alt="Logo" src="/u/hooli-dark-1.svg"></div>
          <div class="Type_bold__nC Cards_title__pb">Hooli's Recipe for Success: Boosting Conversion Rates by 7.8% with Acme</div>
        </a>
        <a href="/customers/how-initech-improved-the-player-experience" class="Link Cards_card__B5">
          <div class="Cards_eyebrow__l2"><span>Gaming</span></div>
          <div class="Cards_title__pb">How Initech improved the player experience</div>
        </a>
        <a href="/customers/umbrella-corp-case-study" class="Link Cards_card__B5"><div class="Cards_title__pb">Umbrella Corp doubles its pipeline</div></a>
      </div></main>`,
    );
    const out = extractCustomers(html, "https://acme.com/customers", ACME);
    const byName = new Map(out.hits.map((h) => [h.name, h]));
    expect([...byName.keys()].sort()).toEqual(["Hooli", "Initech", "Umbrella Corp"]);
    expect(byName.get("Hooli")).toMatchObject({ headline: "Hooli's Recipe for Success: Boosting Conversion Rates by 7.8% with Acme", quote: "Hooli's Recipe for Success: Boosting Conversion Rates by 7.8% with Acme", storyUrl: "https://acme.com/customers/hoolis-boosting-conversion-rates-with-acme" });
    expect(byName.get("Initech")).toMatchObject({ headline: "How Initech improved the player experience" });
    // Every quote is on the page word for word: nothing was glued together.
    for (const h of out.hits) expect(html.replace(/\s+/g, " ")).toContain(h.quote);
  });

  it("a figure, an industry, a date and a teaser around the headline stay out of it", () => {
    const html = page(
      "Customers | Acme",
      `<main><h1>Customers</h1><div role="list">
        <div role="listitem"><a href="/customers/soylent-snacks" class="card">
          <div class="stat">100%</div><div class="stat-label">100% of managers completed reviews on time</div>
          <div class="card-company">Soylent Snacks</div><div class="tag">Food and Beverage</div>
          <h3>SOYLENT's 2-Phase Blueprint for a Transformative Employee Experience</h3>
        </a></div>
        <div role="listitem"><a href="/customers/wonka/" class="tile">
          <div class="thumb"><img src="/a/wonka-partner-header.webp" alt="Wonka partner header"></div>
          <div><h3>How the #1 Chocolate App Keeps Performance Fast and Errors Down for Millions Globally</h3>
          <p class="date">Aug 12, 2025</p>
          <p>TL;DR Wonka Health, makers of the world's leading chocolate app, uses Acme to ship fast and fix faster. With full-s...</p></div>
        </a></div>
        <div role="listitem"><a href="/customers/tyrell/" class="tile">
          <div><h3>How one influencer marketing platform replaced three tools with Acme\u2014and sped up debugging 20x</h3>
          <p class="date">Sep 26, 2025</p><p>Tyrell is an influencer platform that had three tools too many.</p></div>
        </a></div>
      </div></main>`,
    );
    const byName = new Map(extractCustomers(html, "https://acme.com/customers", ACME).hits.map((h) => [h.name, h]));
    expect([...byName.keys()].sort()).toEqual(["Soylent Snacks", "Tyrell", "Wonka Health"]);
    expect(byName.get("Soylent Snacks")).toMatchObject({ headline: "SOYLENT's 2-Phase Blueprint for a Transformative Employee Experience", quote: "Soylent Snacks", confidence: 0.9 });
    expect(byName.get("Wonka Health")!.headline).toBe("How the #1 Chocolate App Keeps Performance Fast and Errors Down for Millions Globally");
    expect(byName.get("Wonka Health")!.quote).toContain("TL;DR Wonka Health, makers of");
    expect(byName.get("Tyrell")!.headline).toBe("How one influencer marketing platform replaced three tools with Acme\u2014and sped up debugging 20x");
    expect(byName.get("Tyrell")!.quote).toBe("Tyrell is an influencer platform that had three tools too many.");
  });

  it("loose text is a headline only when it reads like one about the company: not a pull quote, not the line under it", () => {
    const html = page(
      "Acme",
      `<main><h2>Our customers</h2><div class="stories">
        <a href="/case-studies/vandelay"><p>"Acme helped us grow our pipeline by 40% in a quarter."</p><p>Director of Business Development, Vandelay</p></a>
        <a href="/case-studies/globex"><p>Globex cuts onboarding time by 40% with Acme</p></a>
        <a href="/case-studies/initech"><p>Initech</p><p>We could not have done it without them.</p></a>
      </div></main>`,
    );
    const byName = new Map(extractCustomers(html, "https://acme.com/", ACME).hits.map((h) => [h.name, h]));
    expect(byName.get("Vandelay")).toMatchObject({ via: "case_study", quote: "Director of Business Development, Vandelay", mention: "attribution" });
    expect(byName.get("Vandelay")!.headline).toBeUndefined();
    expect(byName.get("Globex")).toMatchObject({ headline: "Globex cuts onboarding time by 40% with Acme" });
    expect(byName.get("Initech")!.headline).toBeUndefined();
    expect(byName.get("Initech")!.mention).toBeUndefined();
  });
});

describe("logo walls", () => {
  it("one logo is not a wall, and a file name for a description is not a company", () => {
    expect(names(page("Acme", `<main><h2>Trusted by</h2><div class="logos"><img src="/l/globex-logo.svg" alt="Globex logo"></div></main>`), "https://acme.com/")).toEqual([]);
    // A second picture described as "Main" (the logo file of somebody whose name the page never writes) does not make two.
    expect(names(page("Customers | Acme", `<main><h2>Trusted by</h2><div class="logos"><img src="/l/hooli-logo.svg" alt="Main"><img src="/l/globex-logo.svg" alt="Globex logo"><img src="/l/3.svg" alt=""></div></main>`))).toEqual([]);
    // The same logo twice (a scrolling strip repeats itself) is still one.
    expect(names(page("Acme", `<main><h2>Trusted by</h2><div class="logos"><img src="/l/g.svg" alt="Globex logo"><img src="/l/g.svg" alt="Globex logo"></div></main>`), "https://acme.com/")).toEqual([]);
    expect(names(page("Acme", `<main><h2>Trusted by</h2><div class="logos"><img src="/l/g.svg" alt="Globex logo"><img src="/l/i.svg" alt="Initech logo"></div></main>`), "https://acme.com/")).toEqual(["Globex", "Initech"]);
  });

  it.each(["Main", "Logo", "Header", "Thumbnail", "Primary", "Desktop"])("%s is a word for a picture, not a company", (word) => {
    expect(cleanCompanyName(word)).toBeNull();
    expect(cleanLogoName(`${word} logo`)).toBeNull();
  });
});

describe("the company's full name", () => {
  const card = (href: string, inner: string): string => page("Customers | Acme", `<main><h1>Customers</h1><div class="grid"><div class="item"><a href="${href}">${inner}</a></div><div class="item"><a href="/customers/globex"><h3>How Globex cut onboarding time</h3></a></div><div class="item"><a href="/customers/oscorp"><h3>How Oscorp cut onboarding time</h3></a></div></div></main>`);
  const first = (href: string, inner: string) => extractCustomers(card(href, inner), "https://acme.com/customers", ACME).hits.find((h) => h.name !== "Globex" && h.name !== "Oscorp");

  it("takes the fuller name from the card's logo when the address has the short one", () => {
    expect(first("/customers/hooli/", `<img src="/l/logo-hooli.png" alt="Hooli Games logo"><h3>How Hooli Gaming Levels Up With Acme</h3>`)).toMatchObject({ name: "Hooli Games", quote: "Hooli Games logo", headline: "How Hooli Gaming Levels Up With Acme" });
  });

  it("carries a name on through a headline up to its verb", () => {
    expect(first("/customer-stories/initech", `<h3>How Initech Global Logistics saved 1,000 hours in 15 months with Acme</h3>`)).toMatchObject({ name: "Initech Global Logistics" });
    expect(first("/customers/virtanen", `<h3>How Virtanen Health resolves critical issues 3x faster by monitoring their frontend and backend services</h3>`)).toMatchObject({ name: "Virtanen Health" });
    expect(first("/customers/fashn", `<h3>How FASHN AI Went From 4-Hour Outages To Automatic Fixes With Acme</h3>`)).toMatchObject({ name: "FASHN AI" });
    expect(first("/customers/wonka", `<h3>Keeping a chocolate app fast</h3><p>TL;DR Wonka Health, makers of the leading chocolate app, uses Acme.</p>`)).toMatchObject({ name: "Wonka Health" });
  });

  it("stops where the name stops: a verb it does not know, a job title, a figure, running text", () => {
    // In A Title Case Headline every word has a capital; only a verb it knows ends a name there.
    expect(first("/customers/umbrella", `<h3>How Umbrella Reorganised What It Means to Give Feedback</h3>`)).toMatchObject({ name: "Umbrella" });
    expect(first("/customers/vandelay", `<h3>How Vandelay Connects 1:1s, Engagement, and Performance with Acme</h3>`)).toMatchObject({ name: "Vandelay" });
    expect(first("/customers/tyrell", `<h3>How Tyrell Creates Customer Trust with Acme</h3>`)).toMatchObject({ name: "Tyrell" });
    // A photo's description is not where a company's name is spelled out.
    expect(first("/customers/soylent", `<img src="/p/steven.webp" alt="Soylent CEO Steven Smith"><h3>Built to sell better: How Soylent garnered 2,200 organic leads</h3>`)).toMatchObject({ name: "Soylent" });
    expect(first("/customers/elevenco", `<h3>Elevenco GTM team books 3x more meetings</h3>`)).toMatchObject({ name: "Elevenco" });
    // Capitals in running text prove nothing.
    expect(first("/customers/stark", `<h3>Shipping fixes before the doors open</h3><p>The Stark Consumer Products team is responsible for the app.</p>`)).toMatchObject({ name: "Stark" });
  });

  it("a headline that shortens the name in the address gives the name in the address", () => {
    expect(first("/customers/wonka-peninsula-beverages", `<h3>How Wonka Drove Change and Strengthened Alignment with Acme</h3>`)).toMatchObject({ name: "Wonka Peninsula Beverages", headline: "How Wonka Drove Change and Strengthened Alignment with Acme", storyUrl: "https://acme.com/customers/wonka-peninsula-beverages" });
    // Words in the address that are page furniture are not part of a name.
    expect(first("/customers/hooli-onboarding-success", `<h3>How Hooli Drove Change with Acme</h3>`)).toMatchObject({ name: "Hooli" });
    // An address that names nobody: the card's headline is not taken on trust (see "a name read from a line of a card").
    expect(first("/customers/how-we-helped-a-bank", `<h3>How Initech Drove Change with Acme</h3>`)).toBeUndefined();
  });

  it("one story is one customer: two names for it become the fuller one", () => {
    const html = page(
      "Customers | Acme",
      `<main><h1>Customers</h1>
        <div class="featured"><a href="/customers/soylent-snacks"><h2>SOYLENT's 2-Phase Blueprint for a Transformative Employee Experience</h2></a></div>
        <div class="grid">
          <div class="cell"><a href="/customers/globex"><h3>How Globex cut onboarding time</h3></a></div>
          <div class="cell"><a href="/customers/initech"><h3>How Initech cut onboarding time</h3></a></div>
        </div>
        <div class="more"><span class="company-name">Soylent Snacks</span> <a href="/customers/soylent-snacks/">Read the story</a></div>
      </main>`,
    );
    const hits = extractCustomers(html, "https://acme.com/customers", ACME).hits;
    expect(hits.map((h) => h.name).sort()).toEqual(["Globex", "Initech", "Soylent Snacks"]);
    expect(hits.find((h) => h.name === "Soylent Snacks")).toMatchObject({ storyUrl: "https://acme.com/customers/soylent-snacks", headline: "SOYLENT's 2-Phase Blueprint for a Transformative Employee Experience" });
  });
});

describe("a well-known name with a case study of its own", () => {
  const html = page(
    "Customers | Acme",
    `<main><h1>Customers</h1>
      <div class="logo-cards">
        <a class="logo-card" href="/customers/cloudflare/"><img src="/l/logo-cloudflare.png" alt="Cloudflare logo"></a>
        <a class="logo-card" href="/customers/atlassian/"><img src="/l/logo-atlassian.png" alt="Atlassian logo"></a>
        <a class="logo-card" href="/customers/globex/"><img src="/l/logo-globex.png" alt="Globex logo"></a>
        <a class="logo-card" href="/customers/how-acme-helped-reddit-ship/"><h3>How Acme helped Reddit ship faster</h3></a>
        <a class="logo-card" href="/customers/hooli/"><h3>How Hooli moved off Salesforce in a month</h3></a>
      </div>
      <h2>Trusted by</h2><div class="logos"><img src="/l/slack.svg" alt="Slack logo"><img src="/l/stripe.svg" alt="Stripe logo"><img src="/l/initech.svg" alt="Initech logo"><img src="/l/umbrella.svg" alt="Umbrella Corp logo"></div>
      <figure><blockquote>It paid for itself.</blockquote><figcaption>Dana Scully, CTO at Stripe</figcaption></figure>
    </main>`,
  );
  const byName = new Map(extractCustomers(html, "https://acme.com/customers", ACME).hits.map((h) => [h.name, h]));

  it("is a customer when the story's own address names it", () => {
    expect(byName.get("Cloudflare")).toMatchObject({ via: "case_study", dedicated: true, storyUrl: "https://acme.com/customers/cloudflare/" });
    expect(byName.get("Atlassian")).toMatchObject({ via: "case_study", dedicated: true });
    expect(byName.get("Reddit")).toMatchObject({ via: "case_study", dedicated: true });
    expect(byName.has("Globex") && byName.has("Hooli")).toBe(true);
  });

  it("is still not one on a logo wall, in a quote's attribution, or as the tool a story mentions", () => {
    expect(byName.has("Slack")).toBe(false);
    expect(byName.has("Stripe")).toBe(false);
    expect(byName.has("Salesforce")).toBe(false);
    expect([...byName.keys()].sort()).toEqual(["Atlassian", "Cloudflare", "Globex", "Hooli", "Initech", "Reddit", "Umbrella Corp"]);
  });
});

describe("which stories are worth opening", () => {
  it.each([
    ["https://acme.com/customers/tyrell", true],
    ["https://acme.com/customers/docusign-accelerates-growth", true],
    ["https://acme.com/customers/how-initech-cut-costs", true],
    ["https://acme.com/customers/healthcare", false],
    ["https://acme.com/customers/remote-teams", false],
    ["https://acme.com/customers/become-a-reference", false],
    ["https://acme.com/customers", true],
  ])("%s: %s", (url, expected) => {
    expect(storyWorthOpening(url, "Acme")).toBe(expected);
  });
});

describe("labels that say the logos under them are customers", () => {
  it.each(["Real customers loving Acme and its assistant:", "Teams trusting Acme every day", "Companies relying on Acme"])("%s", (label) => {
    const html = page("Acme", `<main><div><p class="eyebrow">${label}</p><ul><li><img src="/l/logo--globex.svg" alt="Globex"></li><li><img src="/l/logo--initech.svg" alt="Initech"></li><li><img src="/l/logo--hooli.svg" alt="Hooli"></li></ul></div></main>`);
    expect(names(html, "https://acme.com/")).toEqual(["Globex", "Hooli", "Initech"]);
  });

  it("the same logos under words that say something else are not", () => {
    for (const label of ["Customers love our integrations with", "Loving these partners", "Works with the tools you use"]) {
      const html = page("Acme", `<main><div><p class="eyebrow">${label}</p><ul><li><img src="/l/logo--globex.svg" alt="Globex"></li><li><img src="/l/logo--initech.svg" alt="Initech"></li></ul></div></main>`);
      expect(names(html, "https://acme.com/"), label).toEqual([]);
    }
  });
});

describe("more of what real story pages do", () => {
  it("a download of a story is not the story, and a button is not a headline", () => {
    const story = page(
      "Hooli Networks - Customer Stories | Acme",
      `<main><article><h1>Hooli Networks responds to critical emails in 15 mins or less with Acme</h1>
        <p>Hooli Networks is a world leader in managed services.</p>
        <div><a href="https://acme.com/assets/customer-stories/Hooli-Networks.pdf"><h3>Download the full Hooli Networks story</h3></a></div>
      </article></main>`,
    );
    const hits = extractCustomers(story, "https://acme.com/customer-stories/hooli-networks", ACME).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: "Hooli Networks", headline: "Hooli Networks responds to critical emails in 15 mins or less with Acme", storyUrl: "https://acme.com/customer-stories/hooli-networks" });
    // On a listing, a card whose only heading is a button has no headline to quote.
    const listing = page("Customers | Acme", `<main><h1>Customers</h1><div class="grid"><div><a href="/customers/globex"><h3>Read the Globex story</h3></a></div><div><a href="/customers/initech"><h3>Watch how Initech did it</h3></a></div><div><a href="/customers/hooli"><h3>How Hooli cut onboarding time</h3></a></div></div></main>`);
    const by = new Map(extractCustomers(listing, "https://acme.com/customers", ACME).hits.map((h) => [h.name, h]));
    expect(by.get("Globex")!.headline).toBeUndefined();
    expect(by.get("Initech")!.headline).toBeUndefined();
    expect(by.get("Hooli")!.headline).toBe("How Hooli cut onboarding time");
  });

  it("a name the address joins with 'and' is the name the page writes with '&'", () => {
    const story = page("Reedly &amp; Mackson - Customer Stories | Acme", `<main><article><h1>With a +97% CSAT, Reedly &amp; Mackson go the extra mile with Acme</h1><p>Text.</p></article></main>`);
    expect(extractCustomers(story, "https://acme.com/customer-stories/reedly-and-mackson", ACME).hits[0]).toMatchObject({ name: "Reedly & Mackson", confidence: 0.9 });
  });

  it("a brand that writes itself in lower case is named when the story's address is that word and the headline is about it", () => {
    const story = page("How initrode Transformed Its Compensation and Benefits with Acme | Acme", `<main><article><h1>How initrode Transformed Its Compensation and Benefits with Acme</h1><p>Text.</p></article></main>`);
    expect(extractCustomers(story, "https://acme.com/customers/initrode", ACME).hits[0]).toMatchObject({ name: "initrode", headline: "How initrode Transformed Its Compensation and Benefits with Acme" });
    // An everyday word in lower case is still a word, and a lower-case word that is not the headline's subject is not a name.
    expect(names(page("How teams transformed onboarding | Acme", `<main><article><h1>How teams transformed onboarding</h1></article></main>`), "https://acme.com/customers/teams")).toEqual([]);
    expect(names(page("Stories | Acme", `<main><article><h1>Closing the loop on feedback</h1></article></main>`), "https://acme.com/customers/loop")).toEqual([]);
  });
});

/* ───────────────────────── what a second look at unseen sites found ───────────────────────── */

describe("a name read from a line of a card is the story's customer only when the story's address carries it", () => {
  const listing = (cards: string): string => page("Customers | Acme", `<main><h1>Customers</h1><div class="grid">${cards}<div class="item"><a href="/customers/globex"><h3>How Globex cut onboarding time</h3></a></div><div class="item"><a href="/customers/hooli"><h3>How Hooli ships faster</h3></a></div></div></main>`);
  const read = (cards: string, url = "https://acme.com/customers") => extractCustomers(listing(cards), url, ACME);

  it("a figure's caption on a story card names nobody: 'Volume increase supported' is not a company called Volume", () => {
    // The card of a story whose company writes itself in lower case, with a figure beside its headline.
    const out = read(`<div class="item"><a href="/customers/q9z"><p>How q9z built support that answers itself</p><div><span>3x</span><span>Volume increase supported</span></div></a></div>`);
    const names = out.hits.map((h) => h.name);
    expect(names).not.toContain("Volume");
    // The headline's subject is the story's whole address, after "How": that is the customer, written as the page writes it.
    expect(out.hits.find((h) => h.storyUrl === "https://acme.com/customers/q9z")).toMatchObject({ name: "q9z", confidence: 0.9, headline: "How q9z built support that answers itself" });
  });

  it("a headline about one company on a card that leads to another's story is not that story's customer", () => {
    const out = read(`<div class="item"><a href="/customers/initech"><div>Soylent doubles its pipeline</div></a></div>`);
    expect(out.hits.map((h) => h.name)).not.toContain("Soylent");
    // The story is not counted as told: opening it is how its customer is learned.
    expect(out.told).not.toContain("acme.com/customers/initech");
  });

  it("the address may carry the name whole, in part, joined up, or as its initials", () => {
    const one = (href: string, headline: string) => read(`<div class="item"><a href="${href}"><h3>${headline}</h3></a></div>`).hits.find((h) => h.name !== "Globex" && h.name !== "Hooli");
    expect(one("/customers/how-initech-drove-change", "How Initech Drove Change with Acme")).toMatchObject({ name: "Initech" });
    expect(one("/customers/vandelay", "How Vandelay Industries cut costs")).toMatchObject({ name: "Vandelay Industries" });
    expect(one("/customers/cityhealth-story", "How City Health doubled its bookings")).toMatchObject({ name: "City Health" });
    expect(one("/customers/csw", "How Central Storage & Warehouse unified five warehouses")).toMatchObject({ name: "Central Storage & Warehouse" });
    // A word any address might have ("global", "company") is not the name's.
    expect(one("/customers/global-rollout", "How Global Payments rolled out in a month")).toBeUndefined();
  });

  it("on the story's own page, a headline's name counts when the address carries it or the page says it twice", () => {
    const story = (path: string, title: string, h1: string) => extractCustomers(page(title, `<main><article><h1>${h1}</h1><p>Some text about the work.</p></article></main>`), `https://acme.com${path}`, ACME).hits.map((h) => h.name);
    expect(story("/customers/how-we-helped-a-bank", "How Initech Drove Change with Acme | Acme", "How Initech Drove Change with Acme")).toEqual(["Initech"]);
    // Said once, under an address that names nobody: not enough.
    expect(story("/customers/how-we-helped-a-bank", "Customer stories | Acme", "Volume increase supported")).toEqual([]);
    expect(story("/customers/q9z", "How q9z built support that answers itself | Acme", "How q9z built support that answers itself")).toEqual(["q9z"]);
    // Three letters in lower case are a name only as the story's whole address and the headline's subject.
    expect(story("/customers/all", "How all teams ship faster | Acme", "How all teams ship faster")).toEqual([]);
  });
});

describe("a name followed by a description of the company", () => {
  it("ends at the comma: the description is not part of the name", () => {
    expect(parseHeadline("How Globex, Ruritania's Fastest Growing EdTech, Drove Sales Efficiency", "Acme")).toBe("Globex");
    expect(parseHeadline("How Globex, the leading importer, cut costs by a third", "Acme")).toBe("Globex");
    expect(parseHeadline("Globex, Inc. doubles its pipeline with Acme", "Acme")).toBe("Globex");
    // No comma, no change.
    expect(parseHeadline("How Globex Global Logistics saved 1,000 hours", "Acme")).toBe("Globex Global Logistics");
    expect(parseHeadline("How Globex's team cut costs", "Acme")).toBe("Globex");
  });
});

describe("a logo described by its file's name", () => {
  it("loses what the file name says about the picture, and keeps the company", () => {
    expect(readLogoName("voltage-park-logo-full")).toEqual({ name: "Voltage Park", fromFileName: true });
    expect(readLogoName("globex_logo_dark_2x.png")).toEqual({ name: "Globex", fromFileName: true });
    expect(readLogoName("logo-initech-wordmark-white")).toEqual({ name: "Initech", fromFileName: true });
    expect(readLogoName("customer-soylent-icon-200x80")).toEqual({ name: "Soylent", fromFileName: true });
    // An abbreviation gets its capitals back, on its own or run into a word.
    expect(readLogoName("qvxz-securities-logo")).toEqual({ name: "QVXZ Securities", fromFileName: true });
    expect(readLogoName("tvscredit")).toEqual({ name: "TVS Credit", fromFileName: true });
    // A name somebody wrote is as it was written - and may end in a word a file name would not.
    expect(readLogoName("Voltage Park Full logo")).toEqual({ name: "Voltage Park Full", fromFileName: false });
    expect(readLogoName("Globex Logo")).toEqual({ name: "Globex", fromFileName: false });
    expect(readLogoName("PW")).toEqual({ name: "PW", fromFileName: false });
    expect(cleanLogoName("globex-logo-white.svg")).toBe("Globex");
  });

  it("names nobody when fewer than four letters are left, or one word that is two everyday words run together", () => {
    for (const raw of ["pw", "pw_logo", "3m-logo-black", "logo-full", "logo", "angelone_logo", "angelone", "dropbox-logo", "firstbank"]) expect(readLogoName(raw), raw).toBeNull();
    // One word that is not two: reported, as a file name gives it.
    expect(readLogoName("soylent")).toEqual({ name: "Soylent", fromFileName: true });
    expect(readLogoName("unext_logo")).toEqual({ name: "Unext", fromFileName: true });
  });

  it("ranks below every logo the page names in words, so a list fills with those first", () => {
    const html = page(
      "Acme",
      `<main><h2>Trusted by teams everywhere</h2><div class="strip">
        <img src="/l/1.svg" alt="qvxz-securities-logo"><img src="/l/2.svg" alt="tvscredit"><img src="/l/3.svg" alt="pw"><img src="/l/4.svg" alt="angelone_logo">
        <img src="/l/5.svg" alt="Globex logo"><img src="/l/6.svg" alt="Initech"><img src="/l/7.svg" alt="Hooli"><img src="/l/8.svg" alt="voltage-park-logo-full">
      </div></main>`,
    );
    const hits = extractCustomers(html, "https://acme.com/", ACME).hits.sort((a, b) => b.confidence - a.confidence);
    expect(hits.map((h) => [h.name, h.confidence])).toEqual([
      ["Globex", 0.8],
      ["Initech", 0.65],
      ["Hooli", 0.65],
      ["QVXZ Securities", 0.4],
      ["Voltage Park", 0.4],
      ["TVS Credit", 0.35],
    ]);
    // The words shown as proof are the page's own.
    expect(hits.find((h) => h.name === "Voltage Park")!.quote).toBe("voltage-park-logo-full");
  });

  it("does not stretch a story's name with what its logo's file is called", () => {
    const out = extractCustomers(
      page("Customers | Acme", `<main><h1>Customers</h1><div class="grid"><div class="item"><a href="/customers/voltage-park"><img src="/l/vp.svg" alt="voltage-park-logo-full"><h3>Why Voltage Park switched to Acme</h3></a></div><div class="item"><a href="/customers/globex"><h3>How Globex cut onboarding time</h3></a></div><div class="item"><a href="/customers/hooli"><h3>How Hooli ships faster</h3></a></div></div></main>`),
      "https://acme.com/customers",
      ACME,
    );
    expect(out.hits.map((h) => h.name).sort()).toEqual(["Globex", "Hooli", "Voltage Park"]);
  });
});

describe("logos drawn without an image: the layer's name is the logo's", () => {
  const leaf = (name: string): string => `<li><div class="f-1" data-framer-name="${name}"><div data-framer-component-type="SVG" class="f-2" style="background-image:url('data:image/svg+xml,x')"></div></div></li>`;
  const wall = (names: string[], label = "Trusted by fast-growing companies around the world"): string =>
    page("Acme", `<main><div data-framer-name="Section"><div data-framer-name="Container Large"><p>${label}</p><div data-framer-name="Ticker Dark Logos"><ul>${names.map(leaf).join("")}</ul></div><div data-framer-name="16px"></div></div></div></main>`);

  it("reads a wall of them under a label that says they are customers", () => {
    const hits = extractCustomers(wall(["Globex", "Initech", "Hooli", "Soylent"]), "https://acme.com/", ACME).hits;
    expect(hits.map((h) => h.name)).toEqual(["Globex", "Initech", "Hooli", "Soylent"]);
    expect(hits[0]).toMatchObject({ via: "logo", quote: "Globex", confidence: 0.65, headline: "Trusted by fast-growing companies around the world" });
  });

  it("the same with data-name", () => {
    const html = page("Acme", `<main><h2>Our customers</h2><div class="row">${["Globex", "Initech", "Hooli"].map((n) => `<div data-name="${n}"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></div>`).join("")}</div></main>`);
    expect(extractCustomers(html, "https://acme.com/", ACME).hits.map((h) => h.name)).toEqual(["Globex", "Initech", "Hooli"]);
  });

  it("layers that are furniture are not names, and neither is a layer with words or other layers in it", () => {
    const hits = extractCustomers(wall(["Globex", "Initech", "Hooli", "Icon Wrapper", "Line", "Plus", "64px - Recommended for Desktop", "Variant 1", "Logo Wrapper", "Rectangle 9144", "Profile Image"]), "https://acme.com/", ACME).hits;
    expect(hits.map((h) => h.name)).toEqual(["Globex", "Initech", "Hooli"]);
    // "Ticker Dark Logos" and "Container Large" hold the logos; they are not one.
    expect(hits.some((h) => /Ticker|Container|Section/.test(h.name))).toBe(false);
    const worded = page("Acme", `<main><h2>Trusted by teams</h2><div><div data-framer-name="Globex"><p>Read our story</p><svg></svg></div><div data-framer-name="Initech"><p>Read more</p><svg></svg></div><div data-framer-name="Hooli"><p>More</p><svg></svg></div></div></main>`);
    expect(extractCustomers(worded, "https://acme.com/", ACME).hits).toEqual([]);
  });

  it("without a label that says customers, or under one that says something else, they name nobody", () => {
    expect(extractCustomers(wall(["Globex", "Initech", "Hooli"], "Everything in one place"), "https://acme.com/", ACME).hits).toEqual([]);
    expect(extractCustomers(wall(["Globex", "Initech", "Hooli"], "Integrates with the tools you use"), "https://acme.com/", ACME).hits).toEqual([]);
    expect(extractCustomers(wall(["Globex", "Initech", "Hooli"], "Backed by the best investors"), "https://acme.com/", ACME).hits).toEqual([]);
  });
});

describe("testimonial cards with no quote markup", () => {
  const card = (who: string, role: string, said: string): string =>
    `<div class="p-4 border"><div class="flex"><a href="https://social.example/post/1"><img class="w-10 rounded-full" alt="Profile image of ${role}" src="/a/x.jpg"><div><div class="font-bold">${who}</div><div class="text-xs">${role}</div></div></a></div><div class="text">${said}</div></div>`;
  // The paragraph under the heading is too long to be a label of its own: the heading is what says who is speaking.
  const section = (label: string, cards: string): string =>
    page("Acme", `<main><div class="container"><h2>${label}</h2><p>From the smallest sites to the very largest ones, in every part of the world there is, and on every day of the week, this is where the work gets done, and where it has been getting done for years.</p><div class="grid">${cards}</div></div></main>`);
  const CARDS =
    card("Jane Doe", "Co-founder and CEO at Globex", "We are massive users of Acme here at Globex.") +
    card("Sam Lee", "Founder and CTO at 42things", "Been a very happy customer of Acme. Wonderful to see new, better options.") +
    card("Dana Scully", "SEO consultant and former Initech lead", "My favourite alternative so far is Acme. Not free, but so easy to use.") +
    card("Rob Hope", "Product designer and founder", "Just replaced my whole network's analytics with Acme and I am impressed.");

  it("the line that says where the speaker works names a customer, under a heading that says customers are speaking", () => {
    for (const label of ["People \u2764\uFE0F Acme", "What our customers say", "Testimonials", "Loved by teams everywhere", "Wall of love"]) {
      const hits = extractCustomers(section(label, CARDS), "https://acme.com/", ACME).hits;
      expect(hits.map((h) => h.name), label).toEqual(["Globex", "42things"]);
      expect(hits[0], label).toMatchObject({ via: "testimonial", quote: "Co-founder and CEO at Globex", confidence: 0.65 });
    }
  });

  it("the same cards under a heading that says something else name nobody", () => {
    for (const label of ["Our speakers", "Meet the team", "Our investors", "Latest from the blog"]) expect(extractCustomers(section(label, CARDS), "https://acme.com/", ACME).hits, label).toEqual([]);
  });

  it("a line with nothing said beside it, an investor, and the site's own people are not customers", () => {
    const bare = `<div class="p-4"><div class="font-bold">Jane Doe</div><div class="text-xs">Co-founder and CEO at Globex</div></div>`;
    expect(extractCustomers(section("What our customers say", bare), "https://acme.com/", ACME).hits).toEqual([]);
    // A grid of people and their jobs, with nothing said by any of them.
    const people = ["Globex", "Initech", "Hooli", "Soylent"].map((c, i) => `<div class="p-4"><div class="font-bold">Person ${i} Doe</div><div class="text-xs">Head of Operations at ${c}</div></div>`).join("");
    expect(extractCustomers(section("Trusted by teams everywhere", people), "https://acme.com/", ACME).hits).toEqual([]);
    const others = card("Pat Kim", "General Partner at Massive Dynamic Ventures", "We backed Acme early and have never looked back since then.") + card("Lee Wong", "Head of Support at Acme", "We built Acme for teams like ours, and we use it every single day.");
    expect(extractCustomers(section("What our customers say", others), "https://acme.com/", ACME).hits).toEqual([]);
  });
});

describe("how much of the site a page links to", () => {
  it("counts the site's other pages, not the page's own section or other sites", () => {
    const html = page("Clients | Acme", `<body><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/docs/">Docs</a><a href="https://acme.com/blog?x=1">Blog</a><a href="https://other.example/">Other</a></nav><main><a href="/clients/leads">Leads</a><a href="/clients/win">Win</a><a href="/pricing/">Pricing again</a></main></body>`);
    expect(extractCustomers(html, "https://acme.com/clients", ACME).siteLinks).toBe(4);
    const booking = page("Rhonda | Acme", `<main><h1>Rhonda</h1><a href="/clients/leads">Leads</a><a href="/clients/win">Win</a><a href="/clients/client-update">Client Update</a></main>`);
    expect(extractCustomers(booking, "https://acme.com/clients", ACME).siteLinks).toBe(0);
  });
});
