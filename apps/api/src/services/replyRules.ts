import { stripQuoted } from "@prospex/core";

/**
 * The rule-based reply classifier the API uses whenever no model reads a reply (no AI on the
 * server, AI switched off for the workspace, quota reached, the engine failing, or mail from
 * someone who is not a lead).
 *
 * The rules in core only knew a handful of phrases ("interested", "let's talk", "call"), so
 * "Sounds interesting, can we talk Thursday?" came out as "other" and the sequence treated a
 * meeting request like noise. These rules look for the shapes people actually write: asking
 * to meet, naming a day, sending a calendar link, pointing at a colleague, saying no.
 *
 * Order matters and runs from what must never be missed to what is merely likely:
 *   unsubscribe -> out of office -> bounce -> referral -> not interested -> interested
 *   (meetings first) -> question -> other.
 * "Not interested" is checked before "interested" because it contains the word. It covers the
 * negations people actually write - "no longer interested", "not really / not at all
 * interested", "we don't need a demo", "do not need", "no need", "not a fit", "not for us" -
 * each of which also contains a positive word ("interested", "demo") that would otherwise
 * read as a yes.
 *
 * The intents are the same enum the AI classifier returns, so nothing downstream changes:
 * interested | not_interested | out_of_office | unsubscribe | referral | question | bounce | other.
 */
export type RuleIntent = "interested" | "not_interested" | "out_of_office" | "unsubscribe" | "referral" | "question" | "bounce" | "other";

const UNSUBSCRIBE = /\bunsubscribe\b|\bremove me\b|\btake me off\b|\bstop (emailing|contacting|sending|messaging)\b|\bopt(-| )?out\b|\bdo not (contact|email|message|call)\b|\bdon'?t (contact|email|message|call) me\b|\bno more emails\b/;
const OUT_OF_OFFICE = /out of (the )?office|automatic reply|auto-?reply|autoreply|away from (the |my )?(office|desk|email)|\bon leave\b|on (annual |parental |maternity |paternity |sick )?leave|on vacation|on holiday|vacation (reply|responder)|limited access to (my )?email|i('m| am) (currently )?away (until|till|from)/;
const BOUNCE = /delivery status notification|undeliverable|mail delivery (failed|subsystem)|address not found|recipient address rejected|mailbox (unavailable|not found|full)|message (was )?not delivered/;
const REFERRAL = /\b(isn'?t|not) the right (person|contact)\b|\bwrong (person|contact)\b|\bbetter (person|contact)\b|\b(reach out to|get in touch with|talk to|speak (to|with)|contact|email) (my colleague|our|him|her|them)\b|\b(looping|loop|cc'?ing|copying) in\b|\bforward(ed|ing)? (this|your (note|email|message)) to\b|\b(he|she|they) (handles?|looks after|owns?|is responsible for) (this|that)\b|\bwho handles (this|that)\b/;
const NOT_INTERESTED = /\b(not|no longer|never) (really |at all |that |very |too |particularly |so |all that |even |remotely |currently )?(interested|keen)\b|\bnot interested\b|\buninterested\b|\bno interest\b|\b(don'?t|do not|doesn'?t|does not|won'?t|will not|wouldn'?t) (really |actually |currently )?(need|want|require)\b(?! to (miss|lose|wait|delay))|\bno (real )?need\b|\bnot (a )?(priority|interesting)\b|\bnot (for|right for) (us|me|our team)\b|\bno,? thanks?\b|\bno,? thank you\b|\bnot a (good )?fit\b|\bnot (the )?right (fit|time)\b|\bnot right now\b|\bnot at (this|the moment)\b|\bno need\b|\bwe('re| are) (all )?(set|good)\b|\balready (have|use|using|work with|working with)\b|\bpass on this\b|\bnot looking\b|\bno budget\b|\bplease don'?t follow up\b|\bnot for us\b|\bnot something we need\b/;
/** Asking to meet, or proposing when: the strongest positive signal. */
const MEETING = /\b(let'?s|can we|could we|shall we|happy to|glad to|keen to|open to|love to|like to|want to|free to) (talk|chat|connect|meet|speak|catch up|hop on|jump on|set up|schedule|find (a )?time|book)\b|\b(book|grab|find|set up|schedule) (a |some )?(time|call|meeting|slot|demo)\b|\bcalendly\.com\b|\bcal\.com\b|\bsend (me |over )?(an? |the )?(invite|calendar|meeting link|times)\b|\b(free|available|around|works for me) (on |at |this |next |tomorrow|monday|tuesday|wednesday|thursday|friday)|\b(call|ring|phone) me\b|\bgive me a (call|ring)\b|\bdemo\b|\b(monday|tuesday|wednesday|thursday|friday)\b.*\b(works?|good|free|available|\d{1,2}(:\d\d)?\s?(am|pm))\b|\b(talk|chat|meet|call|speak)\b[^.?!]{0,30}\b(monday|tuesday|wednesday|thursday|friday|tomorrow|next week|this week)\b/;
const INTERESTED = /\binterest(ed|ing)\b|\bsounds (good|great|interesting|promising)\b|\btell me more\b|\blove to (hear|learn|see|know)\b|\bkeen\b|\bcurious\b|\bworth (a|exploring)\b|\byes,? (please|let'?s|sure|definitely)\b|^\s*(yes|sure|absolutely|definitely)\b|\bsend (me |over )?(more )?(info|information|details|deck|pricing)\b/;
const QUESTION_WORDS = /\b(how|what|which|why|when|where|who|does|do you|is it|is there|can it|could you|pricing|price|cost|costs)\b/;

/** Classify the text the person wrote this time (quoted history is dropped first). */
export function classifyReplyByRules(text: string): { intent: RuleIntent; confidence: number } {
  const own = stripQuoted(String(text ?? ""));
  const t = own.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return { intent: "other", confidence: 0.3 };
  if (UNSUBSCRIBE.test(t)) return { intent: "unsubscribe", confidence: 0.95 };
  if (OUT_OF_OFFICE.test(t)) return { intent: "out_of_office", confidence: 0.9 };
  if (BOUNCE.test(t)) return { intent: "bounce", confidence: 0.8 };
  if (REFERRAL.test(t)) return { intent: "referral", confidence: 0.7 };
  if (NOT_INTERESTED.test(t)) return { intent: "not_interested", confidence: 0.75 };
  if (MEETING.test(t)) return { intent: "interested", confidence: 0.8 };
  if (INTERESTED.test(t)) return { intent: "interested", confidence: 0.65 };
  if (t.includes("?") && QUESTION_WORDS.test(t)) return { intent: "question", confidence: 0.6 };
  return { intent: "other", confidence: 0.4 };
}
