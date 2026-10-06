# Plays

Find the people who need you this week - with the proof.

## What a play is

A play is a saved recipe. It looks at one specific source of buying intent, finds the people
or companies showing that intent right now, and puts them in a review queue. Every entry in
the queue (a candidate) carries:

- **Relevant because** - one plain sentence saying why this person or company is worth
  contacting now.
- **The evidence** - the page that proves the sentence, with the line it was taken from.

A person on your team approves or skips each candidate. Only an approved candidate becomes a
lead. From there it can go into a campaign, where the reason is available to the opening
line. Afterwards every play is judged by what actually happened: how many people it found,
how many you approved, how many you contacted, how many replied and how many replied
positively. That tells you which source of intent produces conversations, so you can put your
effort there.

The loop, in order:

1. **Plan** - give Scout your website. It reads it and suggests plays that suit your product.
2. **Create** - save the plays you want.
3. **Run** - run a play now, or let it run on a schedule.
4. **Review** - read each reason and its evidence, then approve or skip.
5. **Results** - see which play leads to replies.

## How the reason is written

The reason is built by fixed rules from facts found in the evidence. It is a template filled
with what the page says, not a sentence a model wrote freely.

- No evidence, no candidate. If Scout cannot point at a page (or at your own data) that
  supports the sentence, the candidate is not created.
- An AI model may help pull a fact out of a page - for example a customer's name from a case
  study, or whether a post is a question or a complaint. It never writes the reason and never
  supplies a link. A quote is only kept when it appears word for word in the page.
- When a fact was extracted with AI, the candidate's confidence is capped at 0.7, so you can
  see that it deserves a second look.
- A run that could not look anywhere says so. Its status is "blocked" and its note explains
  why. That is shown as a failed run, never as "nobody found".

## The seven types of play

Candidates come in three kinds. A **person** can become a lead. A **company** means the play
found the company but nobody there yet - press "Find people" to look for the job titles you
want. A **public conversation** is a post or thread with no contact details - approving it
creates a task to go and answer it, never a lead.

### 1. Customers of a competitor

- **What it needs:** one to ten competitors (a name, and the website if you know it), and the
  job titles you sell to.
- **Where the people come from:** the competitor's own public website - its customer pages,
  case studies, success stories and logo walls. Scout reads at most 12 pages per competitor,
  one request per page. It finds the companies named there, then looks for people with your
  target titles at those companies.
- **Example reason:** Named as a customer of Acme in their case study "How Globex cut
  onboarding time".
- **Evidence:** the case study or customers page, with the line that names the company.

### 2. Companies hiring for a role

- **What it needs:** one to ten job titles to watch for (for example "Sales Development
  Representative"). Optional: keywords, locations, or a list of specific companies to check.
- **Where the people come from:** open job postings on public job boards and company careers
  pages. The posting tells you the company has the problem you solve; Scout then looks for
  your target titles at that company.
- **Example reason:** Hiring a Sales Development Representative - open posting on Greenhouse.
- **Evidence:** the posting itself, with its title. Scout never states a posting date it does
  not have.

### 3. Recently funded companies

- **What it needs:** nothing is required. Optional: keywords, industries, locations, how far
  back to look (1 to 60 days, 14 by default), a minimum amount and a country.
- **Where the people come from:** public news about funding rounds. The same round reported
  by several outlets becomes one candidate. Scout then looks for your target titles at the
  company.
- **Example reason:** Raised $12M Series A, reported by TechCrunch on 2 Oct 2026.
- **Evidence:** the news article, with its headline. The amount and the round are only
  mentioned when the article states them.

### 4. People asking in public

- **What it needs:** at least one of: competitor names, problems you solve, or your product
  category. You can choose the places to look: LinkedIn posts, Reddit, Hacker News, X and
  forums.
- **Where the people come from:** public posts and threads that show up in web search, where
  someone asks for a tool like yours or complains about a competitor. Vendor blog posts,
  comparison lists, job adverts and the competitor's own pages are left out.
- **Example reasons:** Asked on LinkedIn for an alternative to Acme. / Reddit thread asking
  which tool to use for onboarding.
- **Evidence:** the post, with the line that shows the ask or the complaint.
- **Good to know:** the author of a public LinkedIn post becomes a person candidate.
  Everything else is a public conversation: there is nobody to email, so approving it gives
  you a task to answer it yourself.

### 5. Visitors to your website

- **What it needs:** the Scout tracking snippet installed on your website. Until it is, this
  type is shown as unavailable with the reason. Optional: the lowest intent score to include
  (30 by default) and how far back to look (1 to 90 days, 14 by default).
- **Where the people come from:** companies identified visiting your own site, ranked by the
  pages they looked at. Scout then looks for your target titles at the company.
- **Example reason:** Visited your pricing page 3 times in the last 7 days.
- **Evidence:** your own website visitor data. There is no public link for this one.

### 6. Contacts who changed jobs

- **What it needs:** leads already in your workspace, and a plan that includes job-change
  checks. When your plan cannot check anyone, this type is shown as unavailable with the
  reason. Optional: how far back to look (1 to 90 days, 30 by default).
- **Where the people come from:** your own contacts whose current role no longer matches what
  you have on file.
- **Example reasons:** Moved from Globex to Initech - confirmed by company domain. / Still at
  Globex, now "VP Sales" (was "Head of Sales").
- **Evidence:** the job change check. There is no public link for this one. When the check is
  not certain - a rename or an acquisition can look like a move - the sentence says so.
- **Good to know:** the candidate is the lead you already have. Approving it tags the lead,
  keeps the reason and creates a task, "Reach out about the move". It does not add the person
  to a campaign, because the address on file is probably the old one.

### 7. An uploaded list of people who engaged

- **What it needs:** a list you already have - people who reacted to, commented on or
  reposted a post, followed you, signed up or attended an event. Paste LinkedIn profile links
  or upload a CSV, say what the people did, and add the link and title of the post if there is
  one. Each row needs a LinkedIn profile link, or an email, or a name with a company.
- **Where the people come from:** you. Scout does not collect this list from anyone's
  account. If you give only the link to a public LinkedIn post, Scout reads what the public
  page shows without signing in, and tells you plainly when the page was not publicly
  readable.
- **Example reasons:** Commented on the post "Why onboarding takes too long". / Reacted to a
  post by Jane Doe.
- **Evidence:** the post link you supplied.
- **Good to know:** this type is never "run". It is fed by uploads. Rows that cannot be used
  are listed back to you with the reason.
- **One upload, one source:** send the list as rows or as a CSV, not both - or send neither
  and only the post link, and Scout reads the public post itself. An upload uses no search unit.

## The review rule

Nothing a play finds becomes a lead until a person approves it.

- **Approve a person:** a lead is created (or, if you already had them, the existing lead is
  updated). The lead keeps the reason and the evidence link, is tagged with the play, and is
  added to the play's list if it has one.
- **Approve a company:** the company is saved. No lead is created. Use "Find people" to look
  for people there.
- **Approve a public conversation:** a task is created, "Answer this conversation", with the
  reason and the link. No lead is created.
- **Skip:** the candidate is marked skipped, with your reason if you give one. Nothing else
  happens.

Approving never sends anything. If the play has a campaign, you can choose, at the moment you
approve, to also add the approved people to it. People with a usable email address are added
straight away. For the others Scout looks for the address first and adds them when it is
found; a person whose address cannot be found is not added. Adding someone to a campaign does
not start the campaign: sending only ever happens from a campaign you have started.

A decision on a candidate that somebody else already decided changes nothing and is reported
back as not applied. Nothing is shown as approved unless it really was: the answer lists the
ids whose decision went through (`applied`) and, separately, the ones that did not.

**Auto-approve** is a switch on each play and is off by default. When you turn it on, the
people a run finds become leads without anyone reviewing them (you can set a minimum score).
Use it only for a play whose results you already trust.

**Using the reason in outreach.** An approved lead's reason is available in campaign steps as
`{{relevant_because}}`. With AI personalisation on, the opening line may refer to it in one
natural sentence; it may not claim more than the reason says and may not add a link. Before a
reason is stored for use in an email it is reduced to one line with links, email addresses and
handles removed.

## How results are measured

The Results view shows one row per play for the period you choose (7 to 365 days, 90 by
default):

| Column | What it counts |
|---|---|
| Found | Candidates the play created in the period |
| Approved | Candidates you approved |
| Contacted | Approved people who were sent at least one message |
| Replied | Contacted people who replied |
| Positive | Replies classified as interested, or as a referral to the right person |
| Reply rate | Replied divided by contacted |
| Positive rate | Positive divided by contacted |

**"Not enough sends yet."** A rate from a handful of sends is noise: two replies out of five
looks like 40% and means almost nothing. Until at least 20 people from a play have been
contacted, Scout marks its rates as not enough sends yet. The numbers are still shown, but the
play is not ranked. When nobody has been contacted there is no rate at all, rather than a 0%.

**Best play right now** is chosen only among plays with enough sends, using a cautious
estimate of the positive rate that does not reward a lucky small sample. When no play has
enough sends yet, no best play is named and a note says more sends are needed.

Replies are counted when they reach Scout. If your replies are not being forwarded into Scout,
every play will show zero replies, and the Results view says so instead of presenting that as
a result.

## Limits and metering

Plays use the allowances your plan already has. There is no separate charge for plays.

| Action | What it uses |
|---|---|
| Running a play (by hand or on a schedule) | One search unit per run |
| Planning plays from your website | One search unit |
| "Find people" on a company candidate | One search unit |
| Approving a person who is new to your workspace | One lead unit |
| Approving a person who is already a lead | Nothing |
| Approving a company or a public conversation, or skipping | Nothing |
| A step where an AI model actually ran | One AI message per model call |

- AI messages are counted only when a model really ran. With AI assistance switched off for
  your workspace, plays work from their built-in rules and no AI message is used.
- When your search units for the month are used up, a run is refused with a clear message. A
  scheduled run is skipped, and the play's last result says why.
- A play's last result is one of: done, failed, blocked (it could not look anywhere - not the
  same as finding nobody) or skipped (a scheduled run that did not happen).
- When your lead units run out in the middle of a batch of approvals, Scout stops there. The
  candidates it did not reach stay in the queue, and you are told how many were approved and
  why it stopped. It never stops silently part way.

Other limits:

- Up to 200 plays per workspace.
- A play can run on a schedule, from every 6 hours to every 30 days, or only when you press
  Run. A play that is still running is not started a second time: the play shows as running,
  and a second Run is refused and names the run that is going.
- A run has four minutes. When a play looks for people at the companies it finds, part of that
  time is kept for the people; if it runs out, the companies not reached stay in the queue as
  companies and the run's note says how many.
- A play's type cannot be changed once it exists. Changing its settings replaces them whole;
  clearing its ICP, list, campaign or client detaches it.
- Up to 5,000 candidates waiting for review per play. A run that reaches the limit stops
  adding and says so.
- When a play has target job titles, a run looks for people at up to 15 of the companies it
  finds. The other companies stay in the queue as company candidates, where "Find people"
  (up to 5 people at a time) does the same on request.
- Up to 200 decisions in one go.
- Up to 2,000 rows, or 2 MB, per upload.
- The same person or company is only added to a play once, however many runs find it.

## Privacy

Candidates are personal data, and Scout treats them the way it treats leads.

- **Retention.** Candidates you have not decided on, and candidates you skipped, are deleted
  after 180 days. An approved candidate is kept for as long as its lead exists. Run history
  older than 180 days is deleted.
- **Do not contact.** An address on the platform-wide do-not-contact list is never stored as
  a candidate. An address on your workspace's own do-not-contact list is not added either.
- **Erasure.** When a person is erased - you delete the lead, or a data-subject request is
  carried out - their candidates are erased with them. A data-subject lookup counts a person's
  candidates too: someone who is only waiting in a review queue is reported as held.
- **Export and deletion.** Plays, their runs and their candidates are included in the
  workspace export, and are deleted when the workspace is deleted.
- **Public pages only, read politely.** One request per page, short timeouts, and a limit on
  pages per site. When a site refuses - a sign-in wall, a block page - Scout reports that in
  the run's note and stops. It does not retry around the refusal.
- **Text from the web is treated as data.** It is shortened, cleaned of control characters and
  shown as plain text, and links are opened as ordinary external links.

## What Scout does not do

- It never logs in to anyone's LinkedIn or X account - not yours, and not an account of ours.
- It runs no account automation: no automatic connection requests, messages, profile visits,
  likes or follows from anyone's account.
- It buys no lists. People come from public pages, public search results, your own website
  visitors, your own contacts and the lists you upload.
- It does not rotate network addresses or try to get around a site's bot checks or sign-in
  walls.
- LinkedIn steps in a campaign remain tasks for a person. Scout creates the task and a person
  does it by hand.

## For developers

Everything above is available through the API (full reference at `/docs` on your Scout API
address), the TypeScript SDK and the MCP server for AI assistants. Read-only API keys can read
plays, candidates and results, and cannot change anything.

| What | API | SDK (`gl.plays`) | MCP tool |
|---|---|---|---|
| Types of play | `GET /v1/plays/types` | `types()` | `list_play_types` |
| Suggest plays from a website | `POST /v1/plays/plan` | `plan(website)` | `plan_plays` |
| List plays | `GET /v1/plays` | `list()` | `list_plays` |
| Create a play | `POST /v1/plays` | `create(input)` | `create_play` |
| One play with its last runs | `GET /v1/plays/{id}` | `get(id)` | `list_plays` with `playId` |
| Change a play | `PATCH /v1/plays/{id}` | `update(id, patch)` | `update_play` |
| Delete a play | `DELETE /v1/plays/{id}` | `delete(id)` | - |
| Run now | `POST /v1/plays/{id}/run` | `run(id)` | `run_play` |
| Run history | `GET /v1/plays/{id}/runs` | `runs(id)` | `list_plays` with `playId` |
| Review queue | `GET /v1/plays/candidates` | `candidates(query)` | `review_queue` |
| Approve or skip | `POST /v1/plays/candidates/decide` | `decide(decisions, { enroll })` | `decide_candidates` |
| Find people at a company | `POST /v1/plays/candidates/{id}/find-people` | `findPeople(candidateId, opts)` | `find_people_for_candidate` |
| Upload a list | `POST /v1/plays/{id}/upload` | `upload(id, input)` | `upload_engagers` |
| Results | `GET /v1/plays/performance` | `performance(days)` | `play_results` |

```ts
import { Prospex } from "@prospex/sdk";   // built from this repository: packages/sdk
const gl = new Prospex({ apiKey: "px_live_...", baseUrl: "https://<your Scout API address>" });

const plan = await gl.plays.plan("yourcompany.com");            // suggestions; nothing is saved
const { play } = await gl.plays.create({
  name: "Customers of Acme",
  type: "competitor_customers",
  config: { competitors: [{ name: "Acme", domain: "acme.com" }] },
  targetTitles: ["Head of Sales"],
});
await gl.plays.run(play.id);                                     // one search unit; fills the review queue

const { candidates } = await gl.plays.candidates({ status: "pending", playId: play.id });
for (const c of candidates) console.log(c.relevantBecause, c.evidenceUrl);

// After a person has looked at them:
const result = await gl.plays.decide([{ id: candidates[0].id, decision: "approve" }]);
// result.applied, result.leadsCreated, result.notApplied, result.stopped - nothing has been sent

const { plays, best } = await gl.plays.performance(90);          // sufficient: false means not enough sends yet
```

**With an AI assistant (MCP).** The plays tools are written so that an assistant follows the
same loop and keeps you in it: `plan_plays`, then `create_play`, then `run_play`, then
`review_queue` - which it is told to go through with you, showing each reason and its
evidence - then `decide_candidates` with your choices, and `play_results`. Approving through
an assistant creates leads and sends nothing. `decide_candidates` is marked as an action to
confirm with you first, because with `enroll: true` it adds people to a campaign. An assistant
cannot delete a play.
