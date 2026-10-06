/**
 * The small shared pieces every play depends on: what makes two findings the same
 * candidate, what a reason may contain before it can go near an email, and how the
 * bookkeeping of two runs is added up.
 */
import { describe, expect, it } from "vitest";
import type { PlayFinding } from "./types.js";
import { finishFinding, rankFindings } from "./shared.js";
import { cleanLine, cutAtWord, emptyTrace, mailSafeReason, mergeTrace, normCompanyName, plainDashes, playDedupeKey, safeSentence } from "./util.js";

const f = (over: Partial<PlayFinding>): PlayFinding => ({ kind: "person", relevantBecause: "Asked on LinkedIn for an alternative to Acme.", signalType: "public_ask", confidence: 0.7, ...over });

describe("playDedupeKey", () => {
  it("uses the LinkedIn profile first, however the link is written", () => {
    const a = playDedupeKey(f({ linkedinUrl: "https://www.linkedin.com/in/Jane-Doe-1a2b3c/", email: "jane@globex.com", fullName: "Jane Doe" }));
    expect(a).toBe("li:jane-doe-1a2b3c");
    expect(playDedupeKey(f({ linkedinUrl: "http://linkedin.com/in/jane-doe-1a2b3c?trk=public_post" }))).toBe(a);
    expect(playDedupeKey(f({ linkedinUrl: "https://in.linkedin.com/in/jane-doe-1a2b3c/detail/recent-activity" }))).toBe(a);
  });

  it("then the email address, then the name at the company's domain", () => {
    expect(playDedupeKey(f({ email: " Jane@Globex.COM ", fullName: "Jane Doe" }))).toBe("em:jane@globex.com");
    expect(playDedupeKey(f({ fullName: "Jane  Doe", companyDomain: "https://www.Globex.com/about" }))).toBe("pn:jane doe@globex.com");
    expect(playDedupeKey(f({ firstName: "Jane", lastName: "Doe", companyDomain: "globex.com" }))).toBe("pn:jane doe@globex.com");
    // Not an email: it does not become the key.
    expect(playDedupeKey(f({ email: "not an email", fullName: "Jane Doe", companyDomain: "globex.com" }))).toBe("pn:jane doe@globex.com");
  });

  it("a company is its domain, or failing that its name - never the page it was found on", () => {
    const page = "https://acme.com/customers";
    expect(playDedupeKey(f({ kind: "company", companyName: "Globex", companyDomain: "www.globex.com", evidenceUrl: page }))).toBe("co:globex.com");
    const globex = playDedupeKey(f({ kind: "company", companyName: "Globex Inc.", evidenceUrl: page }));
    const initech = playDedupeKey(f({ kind: "company", companyName: "Initech", evidenceUrl: page }));
    expect(globex).toBe("cn:globex");
    expect(initech).toBe("cn:initech");
    // Two customers named on the same page are two candidates.
    expect(globex).not.toBe(initech);
    expect(playDedupeKey(f({ kind: "company", companyName: "The GLOBEX Corporation" }))).toBe("cn:globex");
  });

  it("a person known only by name and employer", () => {
    expect(playDedupeKey(f({ fullName: "Jane Doe", companyName: "Globex, Inc." }))).toBe("pn:jane doe@globex");
    // A company finding and a person at that company never collide.
    expect(playDedupeKey(f({ fullName: "Jane Doe", companyDomain: "globex.com" }))).not.toBe(playDedupeKey(f({ kind: "company", companyDomain: "globex.com" })));
  });

  it("a public conversation is its page, without tracking parameters or fragment", () => {
    const a = playDedupeKey(f({ kind: "post", evidenceUrl: "https://www.reddit.com/r/sales/comments/abc123/looking_for_an_alternative/?utm_source=share#comment-1" }));
    expect(a).toBe("ev:reddit.com/r/sales/comments/abc123/looking_for_an_alternative");
    expect(playDedupeKey(f({ kind: "post", evidenceUrl: "https://news.ycombinator.com/item?id=111" }))).toBe("ev:news.ycombinator.com/item?id=111");
    expect(playDedupeKey(f({ kind: "post", evidenceUrl: "https://news.ycombinator.com/item?id=222" }))).not.toBe(playDedupeKey(f({ kind: "post", evidenceUrl: "https://news.ycombinator.com/item?id=111" })));
  });

  it("is always lower-case, bounded, and never empty", () => {
    const long = playDedupeKey(f({ kind: "company", companyName: "X".repeat(1000) }));
    expect(long.length).toBeLessThanOrEqual(300);
    expect(playDedupeKey(f({ kind: "post", evidenceUrl: "javascript:alert(1)" }))).toMatch(/^tx:/);
    expect(playDedupeKey(f({})).length).toBeGreaterThan(3);
    for (const k of [playDedupeKey(f({ email: "A@B.CO" })), playDedupeKey(f({ kind: "company", companyName: "GLOBEX" }))]) expect(k).toBe(k.toLowerCase());
  });
});

describe("mailSafeReason", () => {
  it("leaves an ordinary reason exactly as it is", () => {
    for (const s of [
      'Named as a customer of Acme in their case study "How Globex cut onboarding time by 40%".',
      "Raised $12M Series A, reported by TechCrunch on 2 Oct 2026.",
      "Raised about $1.5B, reported by The Economic Times on 12 Sep 2026.",
      "Hiring a Sales Development Representative - open posting on Greenhouse.",
      "Asked on LinkedIn for an alternative to Acme.",
      "Visited your pricing page 3 times in the last 7 days.",
    ]) {
      expect(mailSafeReason(s)).toBe(s);
    }
  });

  it("removes links however they are written", () => {
    expect(mailSafeReason("See https://evil.example/pay?acct=1 now")).toBe("See now");
    expect(mailSafeReason("Visit www.evil.example today")).toBe("Visit today");
    expect(mailSafeReason("Pay at evil.example/pay or 203.0.113.9/pay or 203.0.113.9:8080")).toBe("Pay at or or");
    expect(mailSafeReason("ftp://files.evil.example/x and javascript://x")).toBe("and");
    expect(mailSafeReason("[click here](https://evil.example) for more")).toBe("[click here] for more");
    // A bare name with a dotted ending would be turned into a link by a mail client.
    expect(mailSafeReason("Named as a customer of Booking.com on their website.")).toBe("Named as a customer of Booking on their website.");
    expect(mailSafeReason("Go to evil.example now")).toBe("Go to evil now");
    // What is kept of a dotted name is the part that says whose it is, not whichever label came first.
    expect(mailSafeReason("docs.evil.co.uk is the place")).toBe("evil is the place");
    expect(mailSafeReason("reported by app.dealroom.co yesterday")).toBe("reported by dealroom yesterday");
  });

  it("removes email addresses and @handles", () => {
    expect(mailSafeReason("Write to attacker@evil.example today")).toBe("Write to today");
    expect(mailSafeReason("Post by @some_handle about Acme")).toBe("Post by about Acme");
    expect(mailSafeReason("Senior SDR @ Globex")).toBe("Senior SDR at Globex");
  });

  it("removes markup, template braces, control and invisible characters, and line breaks", () => {
    expect(mailSafeReason('<script>alert(1)</script><img src=x onerror=alert(1)>Hello <b>there</b>')).toBe("alert(1) Hello there");
    expect(mailSafeReason("Hi {{sender_name}} and `code` \\ slash")).toBe("Hi sender_name and code slash");
    expect(mailSafeReason("line one\r\nBcc: someone\n\tline three")).toBe("line one Bcc: someone line three");
    expect(mailSafeReason("a\u0000b\u0007c\u202Ed\u200Be\u00ADf\uFEFFg")).toBe("a b cdefg");
    // An invisible character cannot hide a link from the link rules.
    expect(mailSafeReason("pay at evil\u200B.example/pay now")).toBe("pay at now");
  });

  it("is one line of at most 200 characters, cut at a word", () => {
    const long = mailSafeReason(`Named as a customer of Acme in their case study "${"very long headline ".repeat(30)}".`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("...")).toBe(true);
    expect(long).not.toMatch(/[\r\n]/);
  });

  it("changes nothing when applied twice, and survives anything that is not a string", () => {
    for (const s of ["See https://evil.example/pay now", "Booking.com and @handle", "a\nb", "x".repeat(500), 'He said "hi" - ok.']) {
      expect(mailSafeReason(mailSafeReason(s))).toBe(mailSafeReason(s));
    }
    for (const v of [null, undefined, 42, {}, ["x"]]) expect(mailSafeReason(v as never)).toBe("");
  });

  it("does not hang on hostile input", () => {
    const started = Date.now();
    for (const s of ["a.".repeat(50_000), "@".repeat(50_000), "http://".repeat(20_000), " ".repeat(100_000), "<".repeat(50_000), "a-".repeat(50_000) + ".b"]) mailSafeReason(s);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("safeSentence: the reason a reviewer reads", () => {
  it("keeps a company's name as the page wrote it, but never a link", () => {
    expect(safeSentence("Named as a customer of Booking.com on their website.")).toBe("Named as a customer of Booking.com on their website.");
    expect(safeSentence("See https://evil.example/pay or evil.example/pay.")).toBe("See or");
    expect(safeSentence("one\ntwo")).toBe("one two");
    expect(safeSentence("x ".repeat(400)).length).toBeLessThanOrEqual(300);
  });
});

describe("finishFinding: nothing leaves an engine unchecked", () => {
  it("cleans every text field, bounds them, and drops an evidence URL that is not http(s)", () => {
    const out = finishFinding({
      kind: "company",
      companyName: `Glo\u200Bbex\u0000${" Corp".repeat(60)}`,
      relevantBecause: "Shown as a customer of Acme\non their website. https://evil.example/x",
      evidenceUrl: "javascript:alert(1)",
      evidenceTitle: "T".repeat(500),
      evidenceQuote: `quote\u0007 with   spaces ${"q".repeat(900)}`,
      signalType: "competitor_customer",
      signalAt: new Date("not a date"),
      confidence: 7,
    })!;
    expect(out.companyName!.length).toBeLessThanOrEqual(160);
    expect(out.companyName).not.toMatch(/[\u0000-\u001F\u200B]/);
    expect(out.relevantBecause).toBe("Shown as a customer of Acme on their website.");
    expect(out.evidenceUrl).toBeUndefined();
    expect(out.evidenceTitle!.length).toBe(200);
    expect(out.evidenceQuote!.length).toBeLessThanOrEqual(500);
    expect(out.signalAt).toBeUndefined();
    expect(out.confidence).toBe(1);
    expect(finishFinding({ kind: "post", relevantBecause: "https://only-a-link.example/", signalType: "public_ask", confidence: 0.5 })).toBeNull();
  });

  it("keeps an identifier only in its canonical, safe form", () => {
    const person = (over: Partial<PlayFinding>) => finishFinding(f({ fullName: "Jane Doe", ...over }))!;
    expect(person({ linkedinUrl: "http://uk.linkedin.com/in/Jane-Doe/?trk=x" }).linkedinUrl).toBe("https://www.linkedin.com/in/jane-doe");
    expect(person({ linkedinUrl: "https://evil.example/in/jane" }).linkedinUrl).toBeUndefined();
    expect(person({ linkedinUrl: "javascript:alert(1)" }).linkedinUrl).toBeUndefined();
    expect(person({ email: " Jane@Globex.com " }).email).toBe("jane@globex.com");
    expect(person({ email: "jane@globex.com\nBcc: x@evil.example" }).email).toBeUndefined();
    expect(person({ email: "not an email" }).email).toBeUndefined();
    expect(person({ companyDomain: "https://www.Globex.com/about" }).companyDomain).toBe("globex.com");
    for (const bad of ["127.0.0.1", "localhost", "intranet.corp.local", "169.254.169.254", "user@10.0.0.1"]) expect(person({ companyDomain: bad }).companyDomain, bad).toBeUndefined();
  });

  it("ranks by confidence, one per candidate, within the limit", () => {
    const ranked = rankFindings(
      [
        f({ kind: "company", companyName: "Globex", confidence: 0.55 }),
        f({ kind: "company", companyName: "Globex Inc", confidence: 0.9 }),
        f({ kind: "company", companyName: "Initech", confidence: 0.7 }),
        f({ kind: "company", companyName: "Hooli", confidence: 0.8 }),
      ],
      2,
    );
    expect(ranked.map((r) => [r.companyName, r.confidence])).toEqual([
      ["Globex Inc", 0.9],
      ["Hooli", 0.8],
    ]);
  });
});

describe("traces", () => {
  it("an empty trace is not blocked and adds nothing", () => {
    expect(emptyTrace()).toEqual({ searches: 0, failedSearches: 0, pagesFetched: 0, pagesRefused: 0, aiCalls: 0, notes: [], blocked: false });
    const t = { searches: 3, failedSearches: 1, pagesFetched: 5, pagesRefused: 2, aiCalls: 1, notes: ["one"], blocked: false };
    expect(mergeTrace(emptyTrace(), t)).toEqual(t);
    expect(mergeTrace(t, emptyTrace())).toEqual(t);
  });

  it("adds the counts and keeps each note once, in order", () => {
    const a = { searches: 2, failedSearches: 0, pagesFetched: 4, pagesRefused: 1, aiCalls: 1, notes: ["first", "shared"], blocked: false };
    const b = { searches: 3, failedSearches: 3, pagesFetched: 0, pagesRefused: 0, aiCalls: 0, notes: ["shared", "second"], blocked: true, blockedReason: "Every search failed." };
    expect(mergeTrace(a, b)).toEqual({ searches: 5, failedSearches: 3, pagesFetched: 4, pagesRefused: 1, aiCalls: 1, notes: ["first", "shared", "second"], blocked: false });
  });

  it("is blocked only when every part that did anything was blocked", () => {
    const blocked = { ...emptyTrace(), searches: 2, failedSearches: 2, blocked: true, blockedReason: "Every search failed." };
    const other = { ...emptyTrace(), pagesRefused: 1, blocked: true, blockedReason: "Not a public address." };
    expect(mergeTrace(blocked, other)).toMatchObject({ blocked: true, blockedReason: "Every search failed." });
    expect(mergeTrace(emptyTrace(), blocked)).toMatchObject({ blocked: true, blockedReason: "Every search failed." });
    expect(mergeTrace(blocked, { ...emptyTrace(), searches: 1 })).toMatchObject({ blocked: false });
    expect(mergeTrace(blocked, { ...emptyTrace(), searches: 1 }).blockedReason).toBeUndefined();
  });

  it("does not trust the numbers it is given", () => {
    const odd = { searches: -5, failedSearches: Number.NaN, pagesFetched: 2.9, pagesRefused: Infinity, aiCalls: "3" as never, notes: [1 as never, "", "ok"], blocked: false };
    expect(mergeTrace(odd, emptyTrace())).toEqual({ searches: 0, failedSearches: 0, pagesFetched: 2, pagesRefused: 0, aiCalls: 0, notes: ["ok"], blocked: false });
  });
});

describe("names", () => {
  it("normalises a company name to what identifies it", () => {
    for (const n of ["Globex", "globex", "The Globex Corporation", "Globex, Inc.", "GLOBEX LLC", "Globex Ltd."]) expect(normCompanyName(n)).toBe("globex");
    expect(normCompanyName("Procter & Gamble")).toBe("procterandgamble");
    expect(normCompanyName("Caf\u00E9 Nero")).toBe("cafenero");
    expect(normCompanyName(null)).toBe("");
  });

  it("cleanLine strips what cannot be shown and caps the length", () => {
    expect(cleanLine("  a\tb\n<b>c</b>  d\u200B ", 50)).toBe("a b c d");
    expect(cleanLine("x".repeat(500), 10)).toBe("xxxxxxxxxx");
    expect(cleanLine({ toString: () => "boom" }, 10)).toBe("");
  });
});

describe("shortening and dashes", () => {
  it("never stops inside a word: the cut falls on a space, and three dots say something was left out", () => {
    const headline = "How Initech rebuilt its sales motion, grew conversion by seventy-five percent in sixty days and never looked back";
    const cut = cutAtWord(headline, 110);
    expect(cut).toBe("How Initech rebuilt its sales motion, grew conversion by seventy-five percent in sixty days and never...");
    expect(cut.length).toBeLessThanOrEqual(110);
    // The words before the dots are whole words of the original.
    expect(headline.startsWith(cut.slice(0, -3))).toBe(true);
    expect(/\s/.test(headline[cut.length - 3])).toBe(true);
    // The cut can land exactly at the end of a word.
    expect(cutAtWord("alpha beta gamma delta", 13)).toBe("alpha beta...");
    expect(cutAtWord("alpha beta gamma", 16)).toBe("alpha beta gamma");
    // No punctuation is left dangling before the dots.
    expect(cutAtWord("one, two, three, four, five, six", 20)).toBe("one, two, three...");
    for (const max of [20, 37, 64, 80]) {
      const c = cutAtWord("The quick brown fox jumps over the lazy dog while nobody is watching the fence at all today", max);
      expect(c.length).toBeLessThanOrEqual(max);
      expect(c.endsWith("...")).toBe(true);
      expect(/[a-z]\.\.\.$/.test(c) && " quick brown fox jumps over the lazy dog while nobody is watching the fence at all today ".includes(` ${c.slice(0, -3).split(" ").pop()} `)).toBe(true);
    }
  });

  it("writes long dashes the plain way", () => {
    expect(plainDashes("cut crashes by 60x \u2014 and made Acme the source of truth")).toBe("cut crashes by 60x - and made Acme the source of truth");
    expect(plainDashes("fast\u2014and cheap")).toBe("fast - and cheap");
    expect(plainDashes("2019\u20132024 pre\u2011seed")).toBe("2019 - 2024 pre-seed");
    expect(plainDashes("already - plain")).toBe("already - plain");
  });
});
