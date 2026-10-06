/**
 * The one way fetched HTML reaches the parser.
 *
 * A page somebody else wrote can be built to keep an HTML parser busy for minutes: forty
 * thousand elements nested inside each other (33 s for 320 KB of nested <div>), unclosed
 * formatting elements (7 s for 95 KB of <b id=N>), or one tag with tens of thousands of
 * attributes (4 s for 40,000). The parser runs on the event loop, so one such page stalls
 * every other request the process is serving. Three things stop that:
 *
 *  1. `unreadableHtml` - one linear pass over the text before any parser sees it. It refuses
 *     a page whose tags nest deeper than 400, that has more than 60,000 elements, or that
 *     has a tag too long or too crowded with attributes for the parser to read quickly.
 *  2. `loadHtml` - parses with the first two limits enforced by the parser itself (the
 *     exact depth of its stack of open elements, the exact number of elements it makes), so
 *     a page the parser nests differently from how it reads is stopped after a bounded
 *     amount of work. A refused page is "unreadable": the caller gets null, never an
 *     exception.
 *  3. `fitHtml` - the most that is handed to the parser is the caller's limit, and a longer
 *     page first loses what nothing reads (code, styles, comments, drawings) before its end.
 *
 * `unreadableXml` is the first check for a feed, and `shortText` reads an element's text
 * without reading everything under it - for the crawlers that ask many elements for theirs.
 */
import * as cheerio from "cheerio";
// The tree builder cheerio itself parses with (its own dependency); wrapped below to count as the parser works.
import { adapter as treeAdapter } from "parse5-htmlparser2-tree-adapter";

export const HTML_LIMITS = {
  /** Elements nested inside each other. Real pages stay under 100. */
  depth: 400,
  /** Elements on one page. */
  elements: 60_000,
  /** Characters in one tag, not counting quoted attribute values (an inline image or drawing is one long quoted value). */
  tagChars: 4_000,
} as const;

/** Why a page is refused: nested too deeply, too many elements, or a tag the parser cannot read quickly. */
export type UnreadableHtml = "nesting" | "elements" | "tag";

export interface HtmlShape {
  reason: UnreadableHtml | null;
  /** Deepest nesting seen (up to the point of refusal). */
  depth: number;
  elements: number;
  /** The longest tag, quoted attribute values aside. */
  tagChars: number;
  /** Everything that reads as a tag, opening or closing, wherever it stands. */
  tags: number;
}

/**
 * What reading every tag's attributes costs the parser, summed over the page: it checks
 * each attribute against the ones before it, so a tag with n attributes costs about n * n.
 * 30 million is about a tenth of a second; a real page stays far below one million, and
 * the heaviest seen reached 3 million.
 */
const MAX_ATTRIBUTE_COST = 30_000_000;

/**
 * For most tags it reads, the parser walks up its stack of open elements. So the nesting a
 * page may have shrinks once it has more tags than a full page of elements: 400 levels up
 * to 60,000 tags, 200 at 120,000, never fewer than 100.
 */
const MAX_TAG_LEVELS = HTML_LIMITS.depth * HTML_LIMITS.elements;
export const depthAllowed = (tags: number): number => Math.max(100, Math.min(HTML_LIMITS.depth, Math.floor(MAX_TAG_LEVELS / Math.max(1, tags))));

const VOID = new Set("area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr".split(" "));
/** Closed by the next of their kind or by their parent: they do not pile up, so they are not counted as a level. */
const IMPLIED_END = new Set("p li dt dd option optgroup tr td th thead tbody tfoot colgroup caption rb rp rt rtc html head body".split(" "));
/** A new one closes the one still open. Each time that happens the parser has repair work to do, so it may happen only so often. */
const CLOSES_ITSELF = new Set("a button nobr select".split(" "));
const MAX_REPAIRS = 5_000;
/** Their content is text, whatever it looks like, up to their own closing tag. */
const RAW_TEXT = new Map<string, RegExp>("style textarea title xmp iframe noembed noframes noscript".split(" ").map((n) => [n, new RegExp(`</${n}(?=[\\s/>])`, "gi")]));
const DATA_SCRIPT = /type\s{0,5}=\s{0,5}["']?application\/ld\+json/i;
const SCRIPT_MARK = /<!--|-->|<\/?script(?=[\s\/>])/gi;

/**
 * Where a script's content ends: at its closing tag, except that inside an HTML comment a
 * second `<script>` hides the next `</script>` - the rule browsers follow, kept here so
 * this pass and the parser agree on where markup starts again.
 */
function scriptEnd(html: string, from: number): number {
  let state = 0; // 0 plain, 1 inside "<!--", 2 inside "<!--" and a second "<script"
  SCRIPT_MARK.lastIndex = from;
  for (let m = SCRIPT_MARK.exec(html); m; m = SCRIPT_MARK.exec(html)) {
    const mark = m[0].toLowerCase();
    if (mark === "<!--") {
      if (state === 0) state = 1;
      // Its dashes can be the start of the "-->" that ends it ("<!-->").
      SCRIPT_MARK.lastIndex = m.index + 2;
    } else if (mark === "-->") state = 0;
    else if (mark === "<script") {
      if (state === 1) state = 2;
    } else if (state === 2) state = 1;
    else return m.index;
  }
  return html.length;
}

/** An attribute value longer than this is looked at when a page has to be made smaller (see `fitHtml`). */
const LONG_VALUE = 200;
/** Attributes whose whole value is read by something, however long. */
const READ_WHOLE = new Set(["class", "id", "role", "alt", "title", "aria-label", "href", "content", "name", "property", "type", "rel", "datetime"]);
/** Attributes of which only the start is read (an image's address: where it points and what kind of file it is). */
const READ_START = new Set(["src", "data-src", "data-lazy-src", "srcset"]);

const isSpace = (c: number): boolean => c === 32 || c === 10 || c === 9 || c === 13 || c === 12;
const isAlpha = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);

interface Tag {
  /** Index just past the closing ">" (or the end of the text). */
  end: number;
  nameStart: number;
  nameEnd: number;
  attributes: number;
  /** Characters inside quoted attribute values. */
  quoted: number;
  selfClosing: boolean;
}

/**
 * Where the next quote of a kind is. Tags are also read inside other tags and inside
 * scripts, so the same stretch of text can be asked about many times; the positions are
 * listed once and looked up, never searched for again.
 */
class Quotes {
  private double: number[] | null = null;
  private single: number[] | null = null;
  constructor(private readonly html: string) {}
  private list(ch: string): number[] {
    const out: number[] = [];
    for (let i = this.html.indexOf(ch); i >= 0; i = this.html.indexOf(ch, i + 1)) out.push(i);
    return out;
  }
  /** Index of the first quote `code` (34 or 39) at or after `from`, or -1. */
  next(code: number, from: number): number {
    const at = code === 34 ? (this.double ??= this.list('"')) : (this.single ??= this.list("'"));
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < at.length ? at[lo] : -1;
  }
}

/**
 * Reads one tag exactly as the HTML tokenizer does, starting at its "<": where it ends
 * (quotes after "=" hide a ">", quotes anywhere else do not) and how many attributes it has.
 */
function readTag(html: string, lt: number, closing: boolean, quotes: Quotes, longValue?: (nameStart: number, nameEnd: number, valueStart: number, valueEnd: number) => void): Tag {
  const n = html.length;
  let i = lt + (closing ? 2 : 1);
  const nameStart = i;
  for (; i < n; i++) {
    const c = html.charCodeAt(i);
    if (isSpace(c) || c === 47 || c === 62) break;
  }
  const nameEnd = i;
  let attributes = 0;
  let quoted = 0;
  let selfClosing = false;
  for (;;) {
    // Before an attribute name: spaces and stray slashes are skipped; a slash right before ">" closes the tag on itself.
    let slash = false;
    let c = 0;
    for (; i < n; i++) {
      c = html.charCodeAt(i);
      if (c === 47) slash = true;
      else if (isSpace(c)) slash = false;
      else break;
    }
    if (i >= n) break;
    if (c === 62) {
      selfClosing = slash;
      i++;
      break;
    }
    // An attribute name: its first character whatever it is, then up to a space, "/", ">" or "=".
    attributes++;
    const attributeStart = i;
    for (i++; i < n; i++) {
      c = html.charCodeAt(i);
      if (isSpace(c) || c === 47 || c === 62 || c === 61) break;
    }
    const attributeEnd = i;
    while (i < n && isSpace(html.charCodeAt(i))) i++;
    if (i >= n || html.charCodeAt(i) !== 61) continue;
    // A value.
    for (i++; i < n && isSpace(html.charCodeAt(i)); i++);
    if (i >= n) break;
    c = html.charCodeAt(i);
    if (c === 34 || c === 39) {
      const close = quotes.next(c, i + 1);
      if (close < 0) {
        quoted += n - i;
        i = n;
        break;
      }
      quoted += close - i + 1;
      if (longValue && close - i > LONG_VALUE) longValue(attributeStart, attributeEnd, i + 1, close);
      i = close + 1;
    } else if (c !== 62) {
      for (; i < n; i++) {
        c = html.charCodeAt(i);
        if (isSpace(c) || c === 62) break;
      }
    }
  }
  return { end: i, nameStart, nameEnd, attributes, quoted, selfClosing };
}

/**
 * The next place a marker stands at or after a position. Asked for at positions that only
 * move forward, and remembered, so a page of unclosed comments is not searched to its end
 * once per comment.
 */
function finder(html: string, marker: string): (from: number) => number {
  let asked = -1;
  let found = -1;
  return (from) => {
    if (asked >= 0 && from >= asked && (found < 0 || from <= found)) return found;
    asked = from;
    found = html.indexOf(marker, from);
    return found;
  };
}

/**
 * The shape of a page, measured in one pass over its text, and whether it is refused.
 *
 * Every "<" that could open a tag is read as one - also inside scripts, comments and
 * attribute values, where the parser may or may not agree that it is text - so no tag the
 * parser will read escapes the attribute check. Nesting and the element count follow the
 * page as a browser would read it; `loadHtml` enforces those two exactly while parsing.
 */
export function scanHtml(html: string, limits: { depth: number; elements: number; tagChars: number } = HTML_LIMITS): HtmlShape {
  return scan(html, limits);
}

/**
 * `scanHtml`, optionally noting in `unread` the stretches of the text no reader of the page
 * looks at (comments, styles, scripts that are not data), or reading the text as XML:
 * every tag that is not closed on itself opens a level, and only its own closing tag ends it.
 */
function scan(html: string, limits: { depth: number; elements: number; tagChars: number }, unread?: [number, number][], xml = false): HtmlShape {
  const shape: HtmlShape = { reason: null, depth: 0, elements: 0, tagChars: 0, tags: 0 };
  if (typeof html !== "string" || !html) return shape;
  const n = html.length;
  const refuse = (reason: UnreadableHtml): HtmlShape => {
    shape.reason = reason;
    return shape;
  };
  /** Open elements, innermost last. */
  const open: string[] = [];
  const openCount = new Map<string, number>();
  const push = (name: string): void => {
    open.push(name);
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
    if (open.length > shape.depth) shape.depth = open.length;
  };
  const closeThrough = (name: string): void => {
    if (!openCount.get(name)) return;
    for (;;) {
      const top = open.pop();
      if (top === undefined) return;
      openCount.set(top, (openCount.get(top) ?? 1) - 1);
      if (top === name) return;
    }
  };
  const inForeign = (): boolean => (openCount.get("svg") ?? 0) + (openCount.get("math") ?? 0) > 0;

  const quotes = new Quotes(html);
  const nextGt = finder(html, ">");
  const nextCommentEnd = finder(html, "-->");
  const nextCommentBang = finder(html, "--!>");
  const nextCdataEnd = finder(html, "]]>");
  /** Where a comment that starts at `lt` ("<!--") ends. */
  const commentEnd = (lt: number): number => {
    const p = lt + 4;
    if (html.charCodeAt(p) === 62) return p + 1;
    if (html.startsWith("->", p)) return p + 2;
    const a = nextCommentEnd(p);
    const b = nextCommentBang(p);
    if (a < 0 && b < 0) return n;
    return b < 0 || (a >= 0 && a <= b) ? a + 3 : b + 4;
  };
  /** Markup resumes here: a "<" before it is inside a comment or an element whose content is text. */
  let resume = 0;
  /** A long attribute value nothing reads (a drawing's path, an inline style, an image written into the page): noted as unread, whole or past its start. */
  const longValue = (nameStart: number, nameEnd: number, valueStart: number, valueEnd: number): void => {
    const name = html.slice(nameStart, Math.min(nameEnd, nameStart + 40)).toLowerCase();
    if (READ_WHOLE.has(name)) return;
    const keep = READ_START.has(name) ? 400 : 0;
    if (valueEnd - valueStart > keep) unread?.push([valueStart + keep, valueEnd]);
  };
  let attributeCost = 0;
  let repairs = 0;
  /** Characters looked at while reading tags. Text that may or may not be markup is read more than once, so this is capped to keep the pass linear. */
  let work = 0;
  const maxWork = 4 * n + 200_000;

  for (let lt = html.indexOf("<"); lt >= 0; ) {
    const c1 = html.charCodeAt(lt + 1);
    const closing = c1 === 47;
    const opensTag = closing ? isAlpha(html.charCodeAt(lt + 2)) : isAlpha(c1);
    const inside = lt < resume;
    let next = lt + 1;
    if (opensTag) {
      const tag = readTag(html, lt, closing, quotes, unread && lt >= resume ? longValue : undefined);
      const chars = tag.end - lt - tag.quoted;
      work += chars;
      attributeCost += tag.attributes * tag.attributes;
      shape.tags++;
      if (attributeCost > MAX_ATTRIBUTE_COST || work > maxWork) return refuse("tag");
      if (!inside) {
        // A tag of the page: nothing inside it is another tag, so reading goes on after it.
        next = resume = tag.end;
        if (chars > shape.tagChars) shape.tagChars = chars;
        if (chars > limits.tagChars) return refuse("tag");
        const name = tag.nameEnd - tag.nameStart <= 40 ? html.slice(tag.nameStart, tag.nameEnd).toLowerCase() : "?";
        if (xml) {
          if (closing) {
            if (open[open.length - 1] === name) closeThrough(name);
          } else {
            if (++shape.elements > limits.elements) return refuse("elements");
            if (!tag.selfClosing) {
              push(name);
              if (open.length > limits.depth) return refuse("nesting");
            }
          }
        } else if (closing) closeThrough(name);
        else {
          if (++shape.elements > limits.elements) return refuse("elements");
          const raw = RAW_TEXT.get(name);
          if (name === "script") {
            resume = scriptEnd(html, tag.end);
            // Data a page carries for its readers (JSON-LD and the like) is kept; code is not read by anything.
            if (unread && !(tag.end - lt <= 400 && DATA_SCRIPT.test(html.slice(lt, tag.end)))) unread.push([tag.end, resume]);
          } else if (raw) {
            raw.lastIndex = tag.end;
            const m = raw.exec(html);
            resume = m ? m.index : n;
            if (unread && name === "style") unread.push([tag.end, resume]);
          } else if (!VOID.has(name) && !IMPLIED_END.has(name) && !(tag.selfClosing && inForeign())) {
            if (CLOSES_ITSELF.has(name) && openCount.get(name)) {
              if (++repairs > MAX_REPAIRS) return refuse("nesting");
              closeThrough(name);
            }
            push(name);
            if (open.length > limits.depth) return refuse("nesting");
          }
        }
      }
    } else if (!inside) {
      if (html.startsWith("<!--", lt)) {
        resume = commentEnd(lt);
        if (unread) unread.push([lt, resume]);
      } else if (html.startsWith("<![CDATA[", lt)) {
        // Text up to "]]>" inside a drawing, a comment up to ">" elsewhere: markup resumes after whichever comes last.
        const gt = nextGt(lt + 2);
        const end = nextCdataEnd(lt + 9);
        resume = gt < 0 || end < 0 ? n : Math.max(gt + 1, end + 3);
      } else if (c1 === 33 || c1 === 63 || (closing && html.charCodeAt(lt + 2) !== 62)) {
        // A doctype, a processing instruction or a malformed closing tag: skipped up to its ">".
        const gt = nextGt(lt + 2);
        resume = gt < 0 ? n : gt + 1;
      }
    }
    lt = html.indexOf("<", next);
  }
  return shape.depth > depthAllowed(shape.tags) ? refuse("nesting") : shape;
}

/** Why this page must not be handed to a parser, or null when it may be. One linear pass. */
export function unreadableHtml(html: string): UnreadableHtml | null {
  return scanHtml(html).reason;
}

/** The same check for a feed or another XML document about to be parsed. */
export function unreadableXml(xml: string): UnreadableHtml | null {
  return scan(xml, HTML_LIMITS, undefined, true).reason;
}

/** At most this much of a page is handed to the parser unless the caller says otherwise. */
export const MAX_HTML_CHARS = 1_500_000;

/**
 * A page made to fit in `maxChars` characters. One that already fits is returned as it
 * is. A longer one first loses what no reader of a page looks at - the code inside its
 * scripts, its styles, its comments, and long attribute values such as a drawing's path or
 * an inline style (structured data such as JSON-LD stays, and so does every attribute a
 * reader uses) - and only then, if it is still too long, its end. Large pages are mostly
 * scripts, styles and drawings, so this keeps their content whole where simply cutting
 * at the limit would lose its second half.
 */
export function fitHtml(html: string, maxChars: number): string {
  if (typeof html !== "string") return "";
  if (html.length <= maxChars) return html;
  const unread: [number, number][] = [];
  scan(html, { depth: Infinity, elements: Infinity, tagChars: Infinity }, unread);
  const kept: string[] = [];
  let from = 0;
  let size = 0;
  for (const [start, end] of unread) {
    if (start < from || end <= start) continue;
    kept.push(html.slice(from, start));
    size += start - from;
    from = end;
    if (size >= maxChars) break;
  }
  if (size < maxChars) kept.push(html.slice(from, from + (maxChars - size)));
  return kept.join("").slice(0, maxChars);
}

class Unreadable extends Error {
  constructor(readonly reason: UnreadableHtml) {
    super(`unreadable page: ${reason}`);
  }
}

/** The parser's own tree builder, counting as it goes and stopping the parse at the limits. */
function limitedAdapter(maxDepth: number): typeof treeAdapter {
  let depth = 0;
  let elements = 0;
  return {
    ...treeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      // html, head and body are made for every page, written or not: three more than the page's own.
      if (++elements > HTML_LIMITS.elements + 3) throw new Unreadable("elements");
      return treeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    // The stack of open elements: html and body are on it too, hence the two extra levels.
    onItemPush() {
      if (++depth > maxDepth + 2) throw new Unreadable("nesting");
    },
    onItemPop() {
      depth--;
    },
  };
}

/**
 * Parse a fetched page, or return null when it is unreadable (see the limits above). At
 * most `maxChars` characters are handed to the parser (see `fitHtml`). Never throws.
 */
export function loadHtml(html: string, maxChars = MAX_HTML_CHARS): cheerio.CheerioAPI | null {
  const text = fitHtml(html, maxChars);
  const shape = scanHtml(text);
  if (shape.reason) return null;
  try {
    return cheerio.load(text, { treeAdapter: limitedAdapter(depthAllowed(shape.tags)) });
  } catch {
    return null;
  }
}

interface TextNode {
  type?: string;
  name?: string;
  data?: string;
  children?: TextNode[];
}

/**
 * The text of an element, read one child at a time and given up on as soon as it is
 * clearly longer than the caller has any use for. Asking a few thousand elements of a
 * page for their text then costs what is read, not the size of everything under each of
 * them (which, for elements nested inside each other, is the page again for every one).
 *
 * Returns null when the text has more than `maxChars` characters that are not whitespace,
 * or when `maxNodes` elements were looked through without reaching its end. `skipChildren`
 * names child elements (direct children only) whose text is left out. Code and styles are
 * never text.
 */
export function shortText(el: unknown, maxChars: number, opts: { skipChildren?: Set<string>; maxNodes?: number } = {}): string | null {
  const root = el as TextNode | null | undefined;
  if (!root) return "";
  const out: string[] = [];
  let solid = 0;
  let nodes = 0;
  const maxNodes = opts.maxNodes ?? 5_000;
  const first = opts.skipChildren ? (root.children ?? []).filter((c) => !(c.type === "tag" && opts.skipChildren!.has(c.name ?? ""))) : (root.children ?? []);
  const lists: TextNode[][] = [first];
  const at: number[] = [0];
  while (lists.length) {
    const top = lists.length - 1;
    if (at[top] >= lists[top].length) {
      lists.pop();
      at.pop();
      continue;
    }
    const n = lists[top][at[top]++];
    if (n.type === "text") {
      const d = n.data ?? "";
      out.push(d);
      for (let i = 0; i < d.length; i++) if (!isSpace(d.charCodeAt(i)) && ++solid > maxChars) return null;
    } else if (n.children?.length && n.type !== "comment" && n.type !== "script" && n.type !== "style") {
      if (++nodes > maxNodes) return null;
      lists.push(n.children);
      at.push(0);
    }
  }
  return out.join("");
}
