/**
 * The guard every fetched page goes through before (and while) it is parsed.
 *
 * A page somebody else wrote could keep the parser - and with it the whole process - busy
 * for minutes: 320 KB of nested <div> took 33 s to parse, 95 KB of unclosed <b id=N> 7 s,
 * one tag with 40,000 attributes 4 s. These tests hold the guard to three things: such a
 * page is refused, refusing it is quick, and a real page is parsed exactly as before.
 */
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { HTML_LIMITS, depthAllowed, fitHtml, loadHtml, scanHtml, shortText, unreadableHtml, unreadableXml } from "./html.js";

const SIZE = 800_000;
const fill = (unit: string, size = SIZE): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const numbered = (make: (i: number) => string, size = SIZE): string => {
  const out: string[] = [];
  for (let i = 0, n = 0; n < size; i++) {
    const s = make(i);
    out.push(s);
    n += s.length;
  }
  return out.join("");
};
const attributes = (size: number): string => numbered((i) => `a${i.toString(36)} `, size);
/**
 * Milliseconds a piece of work keeps the process busy: the smaller of the time that passed
 * and the processor time this process used, and the best of a few goes when over the
 * limit. Other tests run at the same time and slow the clock; they do not make the code slower.
 */
const timed = (run: () => unknown, limit = 250): number => {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= limit; i++) {
    const cpu = process.cpuUsage();
    const t0 = performance.now();
    run();
    const used = process.cpuUsage(cpu);
    best = Math.min(best, performance.now() - t0, (used.user + used.system) / 1000);
  }
  return best;
};

const ORDINARY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Customers | Acme</title>
<script>if (a<b && c>d) { document.write("<div><div><div>"); }</script>
<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
<style>.a > .b { color: red }</style></head>
<body><!-- a comment with <div><div> in it --><header><nav><a href="/customers">Customers</a></nav></header>
<main><h1>Trusted by teams</h1><ul><li>One<li>Two<li>Three</ul><p>First<p>Second
<table><tr><td>a<td>b<tr><td>c</table>
<svg viewBox="0 0 10 10"><title>Globex</title><path d="M0 0L10 10"/><circle r="2"/></svg>
<img alt="Globex logo" src="data:image/png;base64,${"A".repeat(20_000)}">
<textarea><div><div></textarea><select><option>a<option>b</select></main>
<footer><p>&copy; Acme</p></footer></body></html>`;

describe("a page's shape, read in one pass", () => {
  it("measures an ordinary page the way a browser reads it", () => {
    const shape = scanHtml(ORDINARY);
    expect(shape.reason).toBeNull();
    // html, head, body and the elements a browser closes by itself (li, p, td, option) are not levels.
    expect(shape.depth).toBeLessThan(12);
    expect(shape.depth).toBeGreaterThan(2);
    // What is inside a script, a style, a textarea or a comment is text, not elements.
    expect(shape.elements).toBe(36);
    // A long quoted value (an image written into the page) does not make its tag long.
    expect(shape.tagChars).toBeLessThan(100);
  });

  it.each([
    ["elements nested deeper than 400", "<div>".repeat(401) + "x", "nesting"],
    ["the same with closing tags", "<div>".repeat(401) + "x" + "</div>".repeat(401), "nesting"],
    ["unclosed elements that pile up", numbered((i) => `<b id=${i}>x`, 20_000), "nesting"],
    ["more than 60,000 elements", "<i></i>".repeat(60_001), "elements"],
    ["a tag longer than 4,000 characters", `<a ${"x".repeat(4_001)}>`, "tag"],
    ["a tag crowded with attributes", `<a ${attributes(60_000)}>`, "tag"],
    ["a closing tag crowded with attributes", `<a></a ${attributes(60_000)}>`, "tag"],
    ["a link opened thousands of times without being closed", numbered((i) => `<a href=/c/${i}>x`, 120_000), "nesting"],
  ])("refuses %s", (_what, html, reason) => {
    expect(unreadableHtml(html)).toBe(reason);
    expect(loadHtml(html)).toBeNull();
  });

  it.each([
    ["400 levels", "<div>".repeat(400) + "x"],
    ["60,000 elements", "<i></i>".repeat(60_000)],
    ["a tag of 3,900 characters", `<a ${"x".repeat(3_900)}>`],
    ["a quoted value of 200,000 characters", `<img alt="Globex logo" src="data:image/png;base64,${"A".repeat(200_000)}">`],
    ["a drawing with a long path", `<svg><path d="${"M0 0L10 10 ".repeat(2_000)}"/></svg>`],
    ["an empty page", ""],
  ])("reads %s", (_what, html) => {
    expect(unreadableHtml(html)).toBeNull();
    expect(loadHtml(html)).not.toBeNull();
  });

  it("allows less nesting once a page has more tags than a full page of elements", () => {
    expect(depthAllowed(1)).toBe(HTML_LIMITS.depth);
    expect(depthAllowed(60_000)).toBe(400);
    expect(depthAllowed(120_000)).toBe(200);
    expect(depthAllowed(10_000_000)).toBe(100);
    // 390 levels and then 150,000 closing tags that close nothing: each one makes the parser walk all 390.
    const html = "<span>".repeat(390) + "</i>".repeat(150_000);
    expect(unreadableHtml(html)).toBe("nesting");
    // The same nesting with an ordinary number of tags is fine.
    expect(unreadableHtml("<span>".repeat(390) + "</i>".repeat(1_000))).toBeNull();
  });

  it("finds a crowded tag wherever the parser might read one: in a script, a style, a comment, a drawing", () => {
    const crowd = `<a ${attributes(SIZE - 400)}>`;
    for (const html of [
      `<script>${crowd}</script>`,
      `<svg><style>${crowd}`,
      `<select><style>${crowd}`,
      `<!--${crowd}-->`,
      `<!-->${crowd}<!-- -->`,
      `<script><!--<script></script> x<y="</script>${crowd}"`,
      `<svg><![CDATA[ > ]]>${crowd}`,
      `<![CDATA[ x>${crowd} ]]>`,
      `<title>${crowd}`,
    ]) {
      expect(unreadableHtml(html), html.slice(0, 40)).toBe("tag");
    }
  });

  it("does not take text for tags: a script that compares, a comment, an attribute with markup in it", () => {
    const script = `<script>for (var i=0;i<n;i++) { s += "<div>"; }${" x = 1;".repeat(2_000)}</script>`;
    const page = `<html><body>${script}<!-- ${"<div>".repeat(1_000)} --><p title="${"<div>".repeat(1_000)}">ok</p><textarea>${"<div>".repeat(1_000)}</textarea></body></html>`;
    const shape = scanHtml(page);
    expect(shape.reason).toBeNull();
    expect(shape.elements).toBe(5);
    expect(shape.depth).toBe(0);
  });
});

describe("the pass is linear", () => {
  // Each of these is 800 KB (what a play hands to the parser) of one thing repeated.
  it.each(
    ["<", "<a", "<a ", "</", "</a ", "<!--", "<!--x--!>", "<!-->", "<?", "<![CDATA[", "<script>", "<script><!--<script>", "<title>", "<style>", "<a b='", '<a b="', "<a b=", "<a/", "<svg><a/>", "<div>", "</div>", "<p>", "<i></i>", "a", " ", "'", '"', "=", ">", "<a href=x>y</a>"].map((u) => [u]),
  )("%j repeated", (unit) => {
    const html = fill(unit);
    expect(timed(() => scanHtml(html))).toBeLessThan(250);
    expect(timed(() => fitHtml(`${html}${html}`, SIZE))).toBeLessThan(250);
    expect(timed(() => unreadableXml(html))).toBeLessThan(250);
  });

  it("one tag name, one attribute name or one value of 800 KB", () => {
    for (const html of [`<${"a".repeat(SIZE)}`, `<a ${"x".repeat(SIZE)}`, `<a b="${"x".repeat(SIZE)}">`, `<a b=${"x".repeat(SIZE)}>`, `<a b='${'"'.repeat(SIZE)}`]) {
      expect(timed(() => scanHtml(html))).toBeLessThan(250);
    }
  });
});

describe("parsing through the guard", () => {
  it("gives exactly what the parser gives for a page it accepts", () => {
    const $ = loadHtml(ORDINARY);
    expect($).not.toBeNull();
    expect($!.html()).toBe(cheerio.load(ORDINARY).html());
    expect($!("main li").length).toBe(3);
    expect($!("title").first().text()).toBe("Customers | Acme");
  });

  // Each of these reads as shallow but is nested by the parser: the limits are enforced while parsing too.
  it.each([
    ["elements closed on themselves, which HTML does not allow for a div", fill("<div/>", 6_000)],
    ["list items and definitions in turn", fill("<li><dd>", 8_000)],
    ["option groups", fill("<optgroup>", 10_000)],
    ["ruby text", fill("<rt>", 4_000)],
    ["a closing tag the parser ignores", fill("<span><div></span></div>", 24_000)],
    ["cells outside a table", fill("<td><div></td>", 14_000)],
    ["elements after a drawing that was closed for the page", `<svg><foo></svg>${fill("<g/>", 4_000)}`],
  ])("stops at 400 levels however the page is written: %s", (_what, html) => {
    expect(loadHtml(html)).toBeNull();
  });

  it("is enforced by the parser itself where the first pass cannot see the nesting", () => {
    // Read as text, none of these nests at all: every element looks closed by the next. The parser nests each one in the last.
    for (const html of [fill("<li><dd>", 8_000), fill("<optgroup>", 10_000), fill("<rt>", 4_000), fill("<span><div></span></div>", 24_000)]) {
      expect(unreadableHtml(html), html.slice(0, 30)).toBeNull();
      expect(loadHtml(html), html.slice(0, 30)).toBeNull();
    }
  });

  // Few tags in the text, many elements in the tree: the parser copies open formatting elements into every block.
  it("stops at 60,000 elements the parser makes, not only those the page writes", () => {
    const html = numbered((i) => `<p><b id=${i % 300}>x`, 12_000);
    expect(scanHtml(html).elements).toBeLessThan(2_000);
    expect(loadHtml(html)).toBeNull();
  });

  // The verifier's pages, and the constructions above, at the size a play parses.
  it.each([
    ["nested <div>", fill("<div>")],
    ["nested <header>", `<main>${fill("<header>")}`],
    ["unclosed <b id=N>", numbered((i) => `<b id=${i}>x`)],
    ["unclosed <a href=N>", numbered((i) => `<a href=/c/${i}>x`)],
    ["nested <span>", fill("<span>")],
    ["<div/>", fill("<div/>")],
    ["<optgroup>", fill("<optgroup>")],
    ["<li><dd>", fill("<li><dd>")],
    ["<span><div></span></div>", fill("<span><div></span></div>")],
    ["<div><b id=N></div>", numbered((i) => `<div><b id=${i}></div>`)],
    ["<p><b id=N>", numbered((i) => `<p><b id=${i}>x`)],
    ["<a><div>", fill("<a><div>")],
    ["<b><p></b>", fill("<b><p></b>")],
    ["<table><td>", fill("<table><td>")],
    ["<template>", fill("<template>")],
    ["399 levels and stray closing tags", "<span>".repeat(399) + fill("</i>", SIZE - 3_000)],
    ["399 levels and </p>", "<b>".repeat(399) + fill("</p>", SIZE - 3_000)],
    ["399 levels and 44,000 elements", "<div>".repeat(399) + numbered((i) => `<i id=${i}>x</i>`, SIZE - 3_000)],
    ["60,000 siblings", "<i></i>".repeat(60_000)],
    ["one tag with 100,000 attributes", `<a ${attributes(SIZE)}>`],
    ["tags of 300 attributes each", fill(`<a ${attributes(1_100)}>x`)],
    ["200 tags of 1,000 attributes", fill(`<a ${attributes(3_900)}>x`)],
    ["an 800 KB attribute value", `<img src="${"A".repeat(SIZE)}">`],
    ["nothing but <", fill("<")],
    ["nothing but comments", fill("<!--x-->")],
    ["nothing but <script>", fill("<script>")],
  ])("answers within a second for 800 KB of %s", (_what, html) => {
    expect(timed(() => loadHtml(html, SIZE), 1_000)).toBeLessThan(1_000);
  });

  it("never throws, whatever it is given", () => {
    for (const junk of [undefined, null, 42, {}, []] as unknown[]) expect(() => loadHtml(junk as string)).not.toThrow();
    expect(loadHtml(undefined as unknown as string)!("body").length).toBe(1);
  });
});

describe("a page too long for the parser", () => {
  const story = `<main><h1>How Globex cut costs</h1><a class="card" href="/customers/globex" title="Globex">Globex</a></main>`;
  const big =
    `<html><head><style>${".x{color:red}".repeat(40_000)}</style><script>${"var a = 1;".repeat(40_000)}</script>` +
    `<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body><!--${"note ".repeat(20_000)}-->` +
    `<svg><path d="${"M0 0L10 10 ".repeat(20_000)}"/></svg><div style="${"color:red;".repeat(20_000)}"><img alt="Globex logo" class="logo" src="data:image/png;base64,${"A".repeat(100_000)}">${story}</div></body></html>`;

  it("is returned as it is when it fits", () => {
    expect(fitHtml(story, 1_000)).toBe(story);
    expect(fitHtml(big, big.length)).toBe(big);
  });

  it("first loses what nothing reads - code, styles, comments, long values nobody looks at - and keeps its content whole", () => {
    expect(big.length).toBeGreaterThan(1_400_000);
    const fitted = fitHtml(big, SIZE);
    expect(fitted.length).toBeLessThan(5_000);
    expect(fitted).toContain(story);
    expect(fitted).toContain('{"@type":"Organization","name":"Acme"}');
    expect(fitted).toContain('<img alt="Globex logo" class="logo" src="data:image/png;base64,AAAA');
    expect(fitted).toContain('<path d=""/>');
    expect(fitted).toContain('<div style="">');
    expect(fitted).not.toContain("var a = 1;");
    expect(fitted).not.toContain("color:red");
    expect(fitted).not.toContain("note ");
    // And the parser reads from it what it reads from the whole page.
    const $ = loadHtml(big, SIZE)!;
    expect($("h1").text()).toBe("How Globex cut costs");
    expect($("a.card").attr("href")).toBe("/customers/globex");
    expect($("img").attr("alt")).toBe("Globex logo");
    expect($("script[type='application/ld+json']").text()).toContain("Acme");
  });

  it("is cut at the limit when even that is not enough", () => {
    const text = `<p>${"word ".repeat(400_000)}</p>`;
    expect(fitHtml(text, SIZE)).toBe(text.slice(0, SIZE));
    expect(fitHtml(`${big}${text}`, SIZE).length).toBe(SIZE);
  });
});

describe("a feed", () => {
  const feed = `<?xml version="1.0"?><rss><channel><title>News</title>${"<item><title>Globex raises $5M</title><link>https://news.example/a</link><description><![CDATA[<a href='x'>Globex</a>]]></description></item>".repeat(100)}</channel></rss>`;
  it("is read when it is a feed and refused when it is nested or crowded beyond any feed", () => {
    expect(unreadableXml(feed)).toBeNull();
    expect(unreadableXml("<a>".repeat(401))).toBe("nesting");
    // In XML every element is a level: there are none that close by themselves.
    expect(unreadableXml("<p>".repeat(401))).toBe("nesting");
    expect(unreadableXml("<item/>".repeat(60_001))).toBe("elements");
    expect(unreadableXml(`<a ${attributes(60_000)}/>`)).toBe("tag");
  });
});

describe("an element's text, read only as far as it is wanted", () => {
  const $ = cheerio.load(`<ul><li id="a"><a>Senior Engineer</a> <span>Remote</span><small>new</small><div>Berlin</div><script>x()</script></li><li id="b">${"word ".repeat(500)}</li><li id="c">${"<i></i>".repeat(6_000)}Late</li></ul>`);
  it("gives the text, with the named children left out", () => {
    expect(shortText($("#a").get(0), 400)).toBe("Senior Engineer Remotenew" + "Berlin");
    expect(shortText($("#a").get(0), 400, { skipChildren: new Set(["span", "small", "div"]) })).toBe("Senior Engineer ");
    expect(shortText(undefined, 400)).toBe("");
  });
  it("gives up on text that is longer than asked for, or buried under thousands of elements", () => {
    expect(shortText($("#b").get(0), 400)).toBeNull();
    expect(shortText($("#b").get(0), 4_000)).toHaveLength(2_500);
    expect(shortText($("#c").get(0), 400, { maxNodes: 100_000 })).toBe("Late");
    // 6,000 empty elements have no children to look through, so they cost nothing; nested ones do.
    const deep = cheerio.load(`<div id="d">${"<i>".repeat(300)}x</div>`);
    expect(shortText(deep("#d").get(0), 400, { maxNodes: 100 })).toBeNull();
    expect(shortText(deep("#d").get(0), 400)).toBe("x");
  });
});
