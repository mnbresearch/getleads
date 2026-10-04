import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";

/**
 * Privacy Policy and Terms of Service.
 *
 * Written to describe what the product actually does - which providers see which data,
 * what the visitor pixel stores, how unsubscribes work - rather than boilerplate. If a
 * provider or a data flow changes, this page has to change with it.
 */

const LAST_UPDATED = "4 October 2026";
const CONTACT = "contact@mnbresearch.com";

/**
 * How long things are kept, in days. A copy of RETENTION in apps/api/src/lib/privacyRetention.ts,
 * which is what the cleanup job actually enforces. apps/api/src/security.privacy.test.ts reads
 * this object and fails when the two differ - change them together.
 */
const RETENTION = {
  visitDays: 395,
  loginFailureDays: 30,
  loginSuccessDays: 90,
  expiredTokenDays: 30,
  closedInviteDays: 90,
  finishedJobDays: 7,
  failedJobDays: 30,
  eventDays: 90,
  auditLogDays: 730,
  closedUpgradeRequestDays: 730,
} as const;
/** Days between an owner asking for a workspace to be deleted and the deletion (DELETION_GRACE_MS in the API). */
const DELETION_GRACE_DAYS = 7;

function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} - Scout by MNB Research`;
    return () => { document.title = prev; };
  }, [title]);
  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-black/10 bg-surface/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" aria-label="Scout home"><Logo size={24} textClassName="text-base" /></Link>
          <nav className="flex gap-4 text-sm text-ink-400">
            <Link to="/privacy" className="hover:text-ink-50">Privacy</Link>
            <Link to="/terms" className="hover:text-ink-50">Terms</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-ink-400">Scout by MNB Research · Last updated {LAST_UPDATED}</p>
        <div className="legal mt-8 space-y-8 text-[15px] leading-relaxed text-ink-200">{children}</div>
      </main>
      <footer className="border-t border-black/10">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-ink-400 sm:px-6">
          <span>© 2026 MNB Research, Faridabad, Haryana, India</span>
          <span className="flex gap-4">
            <Link to="/privacy" className="hover:text-ink-50">Privacy</Link>
            <Link to="/terms" className="hover:text-ink-50">Terms</Link>
            <a href={`mailto:${CONTACT}`} className="hover:text-ink-50">{CONTACT}</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-ink-50">{n}. {title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((x, i) => <li key={i}>{x}</li>)}
    </ul>
  );
}

const Mail = () => <a className="text-brand-600 underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>;

export function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy">
      <p>
        This policy explains what information Scout collects, why, who it is shared with, and the choices you have. Scout
        (scout.mnbresearch.com) is operated by MNB Research, Faridabad, Haryana, India ("we", "us"). Questions or requests: <Mail />.
      </p>

      <Section n={1} title="Who this covers">
        <p>Three groups of people come into contact with Scout, and we treat their data differently:</p>
        <List items={[
          <><strong>Customers</strong> - people who create a Scout account or are invited to a team workspace.</>,
          <><strong>Prospects</strong> - people and companies whose business contact details our customers find, store or contact using Scout.</>,
          <><strong>Website visitors</strong> - people who visit a customer's website where that customer has installed the Scout visitor pixel, and visitors to our own site.</>,
        ]} />
      </Section>

      <Section n={2} title="Information about customers">
        <List items={[
          <><strong>Account data:</strong> name, email address, a hashed password (we never store it in plain text) or, if you sign in with Google, your Google account email and name; your workspace name, plan and role; and, if you turn on two-factor sign-in, an encrypted authenticator secret and hashed recovery codes.</>,
          <><strong>Usage data:</strong> the searches, lists, ICPs, campaigns, credits used and settings you create, plus security logs (time, IP address, and what was done) needed to run, secure and debug the service.</>,
          <><strong>Sender and integration settings:</strong> email sender details and the credentials you connect (for example an SMTP password, a Resend API key or a CRM token), webhooks and API keys. Sender and integration credentials are stored encrypted. API keys are stored only as a one-way hash, which is why a key cannot be shown again after it is created.</>,
          <><strong>Billing and upgrade requests:</strong> the contact details you give us when you request a plan or upgrade, and, for paid plans, the payment records held by our payment provider.</>,
        ]} />
        <p>We use this to provide and secure the service, to bill and support you, and to email you about your account (for example password resets, invites, security notices and service notices). We do not sell customer data.</p>
      </Section>

      <Section n={3} title="Prospect data: customers are in charge">
        <p>
          Customers use Scout to find, verify, enrich and contact business prospects. For that prospect data the <strong>customer is the controller</strong> (in DPDP Act terms, the Data Fiduciary): they decide whom to look up, what to keep and whom to contact. <strong>Scout processes it on the customer's behalf</strong> and only to provide the features the customer uses.
        </p>
        <p>Prospect data can include a person's name, job title, employer, business email address, phone number, LinkedIn or company URL and public company information, along with email verification results and campaign activity (sends, opens, clicks, replies, bounces and unsubscribes). Each record notes where it first came from (for example an import, a web search, or a named data provider).</p>
        <p>
          It comes from public sources (company websites, search results, public profiles), from files and CRMs a customer connects, and from the third-party data and verification providers listed in section 8. A customer that works for its own clients can share a read-only report link with a client; that report shows prospects' names, job titles, companies and pipeline stage, and never email addresses, phone numbers or profile links.
        </p>
        <p>
          <strong>If you are a prospect</strong> and want to know why a customer contacted you, or want your data removed, you can contact that customer directly, or email us at <Mail />. On your request we will find which customers' workspaces hold your email address, delete your records from all of them, and put your address on a platform-wide do-not-contact list. From then on no Scout customer can email you through Scout, and your address is not stored again when a customer later imports a list or runs a search that would bring it back. What remains is your address on do-not-contact lists (ours, and a customer's if you had unsubscribed from them), which is what keeps you from being contacted, and content-free records that a message was once sent (kept so sending limits and bounce protection cannot be reset by deleting records). Copies a customer already exported to their own CRM or files are outside Scout; we will tell the customer about your request.
        </p>
      </Section>

      <Section n={4} title="Email sending, tracking and unsubscribes">
        <p>
          Customers send campaign emails through Scout using their own sender accounts or our shared sending provider. To report results to the customer, emails may include an open-tracking pixel and tracked links, which record when a message is opened or a link is clicked. Scout does not store the IP address or device of the person who opened or clicked.
        </p>
        <p>
          Every campaign email, and every reply a customer sends from Scout, ends with an unsubscribe line and link, and carries the standard one-click unsubscribe header. Customers cannot turn this off. When a customer has entered a mailing address for their workspace, it is printed under the unsubscribe line.
        </p>
        <p>
          When a recipient unsubscribes (by the link, by replying "unsubscribe", or by marking a message as spam with a provider that reports it), their address is added to that customer's do-not-contact list and every running sequence to them is stopped. Scout will not send them further emails or WhatsApp messages from that customer, and will not create follow-up tasks (such as LinkedIn messages or calls) for them. Bounces are recorded the same way, and replies stop the sequence. Scout does not send to an address it knows to be invalid. Checking addresses before sending is a tool we give customers; whether an address was checked before a campaign is the customer's choice.
        </p>
      </Section>

      <Section n={5} title="The website visitor pixel">
        <p>
          A customer can install a small Scout script on their own website to learn which <strong>companies</strong> visit it. When a page loads, the script sends the page path (without its query string), the page title, the referring page's address (without its query string), a random session identifier (kept in the browser's session storage, not a cookie) and time on page; our server also receives the browser's user agent and the visitor's IP address with the request.
        </p>
        <p>
          The IP address is used once, to look up the organisation it belongs to. For that lookup it is sent over an encrypted connection to an IP-lookup provider (ipapi.is, or ipinfo.io when the first does not answer) and checked against public reverse DNS. While the lookup is waiting, the address is held encrypted in our processing queue; it is removed from the queue when the lookup finishes. With the visit we store the page path, the referrer, the session identifier, time on page, the user agent, the organisation name, country and city the lookup returned, and a keyed one-way hash of the IP address that is specific to that customer's pixel. The hash cannot be matched across different customers' sites, and cannot be turned back into an address without a secret key that is held only on our servers.
        </p>
        <p>
          <strong>Do-not-track signals are honoured.</strong> If the visitor's browser sends Global Privacy Control or Do Not Track, the script sends nothing, and our server discards any request that carries either signal without storing it or looking anything up.
        </p>
        <p>
          Identification is company-level - on its own the pixel does not identify individual people, and it sets no cookies. A customer can choose to call the script's "identify" function with details a visitor has given them (for example an email typed into their own form). In that case the email is used only to work out which company the visitor belongs to; it is not stored with the visit. Individual visit records are deleted after {RETENTION.visitDays} days. The customer installing the pixel is responsible for telling their visitors about it in their own privacy notice and for obtaining any consent their local law requires - session storage and this kind of measurement can require consent in the EU and UK even though no cookie is set.
        </p>
      </Section>

      <Section n={6} title="Cookies and local storage">
        <p>
          The Scout app does not use advertising or third-party tracking cookies. When you sign in, your session token is kept in your browser's storage so you stay signed in, and short-lived values (such as which page to return to after a session expires) are kept in session storage. Clearing your browser storage signs you out. Our pages load their fonts from our own site. The demo video on our home page is served by YouTube in its privacy-enhanced mode, and nothing is loaded from YouTube until you press play.
        </p>
      </Section>

      <Section n={7} title="AI features">
        <p>
          Some features send text to AI model providers: drafting and personalising emails, classifying replies and drafting answers to them, turning a search description into filters, scoring how well a lead fits an ideal customer profile, summarising company research, and measuring how AI models describe a brand (the AI visibility feature). What is sent is limited to what the feature needs - for example a prospect's name, job title, company, location and a short company description for a personalised email. Email addresses and phone numbers are not included unless the customer's own template puts them there. An inbound email is only passed to an AI model when its sender is already one of the workspace's leads; mail from anyone else is never sent to AI.
        </p>
        <p>
          Depending on the plan and on which provider is available at that moment, a request may be answered by Groq, Google (Gemini) or Anthropic (Claude). We use their API services, and their published terms decide what they may do with the text. Those terms are not all the same: some API tiers we use - in particular free tiers, such as Google's free Gemini tier - allow the provider to use submitted text to improve its services and to have it read by human reviewers.
        </p>
        <p>
          <strong>You can turn AI off.</strong> An owner or admin can switch off "AI assistance" for the whole workspace under Settings. From then on no lead, prospect or inbound-email content of that workspace is sent to any AI provider: emails are written from your own templates, replies are sorted by built-in rules, and searches use the keyword parser. The AI visibility feature keeps working, because it sends only the questions you wrote about your own brand.
        </p>
      </Section>

      <Section n={8} title="Sub-processors">
        <p>These are the providers Scout can send data to. Each receives only what it needs for its function, and several are used only when a customer turns the related feature on:</p>
        <List items={[
          <><strong>Hosting and infrastructure:</strong> Render (application servers), Neon (database), Vercel (web app hosting), Cloudflare (network in front of the application servers).</>,
          <><strong>Email delivery:</strong> Resend, or the SMTP provider a customer connects (for example Brevo, Gmail or Zoho).</>,
          <><strong>Messaging:</strong> Meta (WhatsApp Business), when a customer connects their WhatsApp account.</>,
          <><strong>Contact and company data:</strong> Apollo, Hunter and People Data Labs.</>,
          <><strong>Email verification:</strong> Hunter, Reoon, MillionVerifier and Abstract; and a direct check with the recipient's own mail server.</>,
          <><strong>Web search and public pages:</strong> Serper, SerpAPI, Brave Search, Google Programmable Search and Google News, the public results pages of DuckDuckGo and Bing, and the public websites and LinkedIn pages of the companies and people being looked up.</>,
          <><strong>IP lookup for the visitor pixel:</strong> ipapi.is and ipinfo.io.</>,
          <><strong>AI models:</strong> Groq (Llama models), Google (Gemini) and Anthropic (Claude). If we add another model provider it will be named here first.</>,
          <><strong>Customer-connected systems:</strong> the CRM, spreadsheet or webhook address a customer connects (HubSpot, Pipedrive, Zoho, Google Sheets, or their own endpoint) receives the leads and events that customer chooses to send it.</>,
          <><strong>Payments:</strong> Stripe, for paid plans.</>,
          <><strong>Sign-in:</strong> Google, if you choose "Continue with Google".</>,
        ]} />
        <p>We update this list when we add or replace a provider.</p>
      </Section>

      <Section n={9} title="Where data is processed">
        <p>Our providers operate servers in several countries, including the United States, the European Union and India, so your data may be processed outside the country you are in. Where the law requires it, we rely on appropriate safeguards for those transfers.</p>
      </Section>

      <Section n={10} title="Retention">
        <p>What a customer keeps deliberately has no time limit; everything else is removed automatically after a fixed time.</p>
        <List items={[
          <>Account and workspace data is kept while the workspace exists.</>,
          <>Leads, companies, lists, campaigns and messages are kept until the customer deletes them or the workspace is deleted. Deleting a lead also removes the content and the address from every message to and from that person, and the activity entries about them, within a day at the latest.</>,
          <>Do-not-contact (unsubscribe) records are kept for as long as the customer's workspace exists, because deleting them would allow the person to be emailed again. The platform-wide do-not-contact list is kept until the person asks us to remove them from it.</>,
          <>Individual website-visit records: {RETENTION.visitDays} days. The per-company summary built from them is kept until the workspace is deleted.</>,
          <>The activity feed (which webhooks are delivered from): {RETENTION.eventDays} days.</>,
          <>Sign-in attempts (email address and IP address): failed attempts up to {RETENTION.loginFailureDays} days, successful sign-ins {RETENTION.loginSuccessDays} days.</>,
          <>Password-reset, email-confirmation and sign-in tokens: {RETENTION.expiredTokenDays} days after they expire. Team invitations: {RETENTION.closedInviteDays} days after they are accepted, revoked or expire.</>,
          <>Background job records: {RETENTION.finishedJobDays} days once finished, {RETENTION.failedJobDays} days if they failed. A finished search keeps the list of leads it found until the workspace is deleted.</>,
          <>The security log (who did what, from which IP address): {RETENTION.auditLogDays} days.</>,
          <>Upgrade requests that have been closed: {RETENTION.closedUpgradeRequestDays} days.</>,
          <>When an owner deletes a workspace, everything in it is permanently deleted no sooner than {DELETION_GRACE_DAYS} days after the request (see section 12 of the Terms for exactly what happens). We keep one record that the deletion took place - the workspace name, internal identifiers, dates and counts of what was removed - in the security log for {RETENTION.auditLogDays} days.</>,
          <>Copies in our database provider's routine backups expire on their normal cycle. Payment records held by our payment provider are kept for as long as tax law requires.</>,
        ]} />
      </Section>

      <Section n={11} title="Your rights">
        <p>
          Depending on where you are, you have rights over your personal data. Under India's Digital Personal Data Protection Act, 2023 you can ask for a summary of the personal data we process about you, ask us to correct, complete, update or erase it, withdraw consent where processing relies on consent, nominate someone to exercise your rights, and raise a grievance with us. Where the EU or UK GDPR applies, you can also ask for access, portability, restriction of processing, and object to processing based on legitimate interests, and you may complain to your local data protection authority.
        </p>
        <p>
          Workspace owners can download everything in their workspace, and delete the workspace, themselves under Settings. For anything else - including a request as a prospect, described in section 3 - email <Mail /> from the address in question. We will respond within 30 days. Our grievance contact under the DPDP Act is the same address.
        </p>
      </Section>

      <Section n={12} title="Security">
        <p>We use encrypted connections (HTTPS), hashed passwords, optional two-factor sign-in, encrypted storage of sender and integration credentials, roles within each workspace, and a security log of sign-ins and sensitive actions. No system is perfectly secure; if we learn of a breach affecting your data we will notify you and the relevant authorities as the law requires.</p>
      </Section>

      <Section n={13} title="Children">
        <p>Scout is a business tool and is not meant for anyone under 18. We do not knowingly collect data about children.</p>
      </Section>

      <Section n={14} title="Changes">
        <p>We will update this page when our practices change and revise the date at the top. For significant changes we will also notify account owners by email.</p>
      </Section>

      <Section n={15} title="Contact">
        <p>MNB Research, Faridabad, Haryana, India · <Mail /></p>
      </Section>
    </LegalShell>
  );
}

export function TermsPage() {
  return (
    <LegalShell title="Terms of Service">
      <p>
        These terms govern your use of Scout (scout.mnbresearch.com), operated by MNB Research, Faridabad, Haryana, India ("we", "us"). By creating an account or using Scout you agree to them on behalf of yourself and the organisation you represent. If you do not agree, do not use Scout.
      </p>

      <Section n={1} title="The service">
        <p>Scout helps businesses find and verify B2B prospects, run outbound email sequences, identify companies visiting their website, and measure how AI models describe their brand. It is available through the web app, an API and agent integrations. We may change, add or remove features over time.</p>
      </Section>

      <Section n={2} title="Accounts">
        <List items={[
          <>You must be at least 18 and able to agree to these terms for your organisation.</>,
          <>Keep your password and API keys secure. You are responsible for activity under your account and your workspace, including by teammates you invite.</>,
          <>Give accurate account information and tell us at <Mail /> if you suspect unauthorised access.</>,
        ]} />
      </Section>

      <Section n={3} title="Acceptable use">
        <p>You must not use Scout to:</p>
        <List items={[
          <>send spam, or bulk unsolicited email that breaks the law where you or your recipients are, including the US CAN-SPAM Act, the EU/UK GDPR and ePrivacy rules, India's DPDP Act 2023 and IT Act, and similar laws;</>,
          <>hide your identity, use misleading subject lines or sender details, or ignore unsubscribe requests;</>,
          <>contact people for purposes unrelated to their professional role, or target consumers or minors;</>,
          <>harass anyone, or send unlawful, deceptive, defamatory or harmful content;</>,
          <>resell or bulk-redistribute data obtained through Scout as a standalone dataset;</>,
          <>scrape, overload, probe or bypass the limits and security of the service, or share accounts to evade plan limits.</>,
        ]} />
        <p>
          <strong>You are responsible for having a lawful basis to collect and contact each prospect</strong> (for example legitimate interest or consent, as your law requires), for including accurate sender identification and a working unsubscribe in your messages, and for honouring opt-outs. Scout adds an unsubscribe line and link to every email it sends for you (this cannot be turned off), prints your mailing address under it when you have entered one under Settings, and keeps your do-not-contact list - but compliance is yours. Where the law requires a postal address in commercial email, you must enter one. Scout does not check every address before it sends: it refuses addresses it knows to be invalid, and gives you verification tools to use before a campaign. If you install the visitor pixel, you must disclose it in your own website's privacy notice and obtain any consent your law requires.
        </p>
        <p>We may suspend sending, or the account, where we see signs of abuse such as high bounce or complaint rates, to protect recipients and the deliverability of other customers.</p>
        <p>We keep a platform-wide do-not-contact list of people who have asked us never to be contacted through Scout. Addresses on it cannot be stored in or contacted from any workspace, and when such a person asks us to erase their data we delete their records from every workspace, including yours.</p>
      </Section>

      <Section n={4} title="Your data">
        <p>
          You keep ownership of the data you bring to Scout and the prospect data you build in it. You give us permission to process it only to provide and improve the service, as described in our <Link className="text-brand-600 underline" to="/privacy">Privacy Policy</Link>. For prospect data you are the controller and we act as your processor.
        </p>
      </Section>

      <Section n={5} title="Plans, credits and payment">
        <List items={[
          <>Plans set limits such as leads, credits, campaigns, seats and features. The current limits are shown in the app and on our pricing page.</>,
          <>Credits are used up by actions such as premium lookups and verifications. Unused credits do not carry over unless the plan says otherwise, have no cash value and are not refundable.</>,
          <>Paid plans are billed in advance for each billing period. Fees are non-refundable except where the law requires otherwise or we agree in writing. Prices exclude applicable taxes.</>,
          <>We may change prices or plan limits with at least 30 days' notice; changes apply from your next billing period.</>,
        ]} />
      </Section>

      <Section n={6} title="Data accuracy">
        <p>
          Contact and company data comes from public sources and third-party providers and changes constantly. Email verification estimates deliverability; it cannot guarantee it. AI-generated text and AI visibility measurements are statistical estimates and can be wrong. <strong>We do not guarantee that any data, verification result, AI output or measurement is accurate, complete or current</strong>, and you should review content before sending it.
        </p>
      </Section>

      <Section n={7} title="Third-party services">
        <p>Scout relies on third-party providers (hosting, email delivery, data, search and AI models) and lets you connect your own. Their availability and terms are outside our control; we are not responsible for their failures, although we will work to limit the impact on you.</p>
      </Section>

      <Section n={8} title="Availability">
        <p>We aim to keep Scout available and reliable but provide it without a guaranteed uptime unless we agree otherwise in writing. We may carry out maintenance, and scheduled jobs such as sending and scans may be delayed.</p>
      </Section>

      <Section n={9} title="Disclaimer">
        <p>To the extent the law allows, Scout is provided "as is" and "as available", without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose and non-infringement.</p>
      </Section>

      <Section n={10} title="Limitation of liability">
        <p>
          To the extent the law allows: we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or goodwill; and our total liability for all claims relating to Scout in any 12-month period is limited to the fees you paid us for Scout in that period (or INR 5,000 if you paid nothing). Nothing in these terms limits liability that cannot be limited by law.
        </p>
      </Section>

      <Section n={11} title="Indemnity">
        <p>You will defend and compensate us for claims, fines and costs arising from your data, your messages, or your breach of these terms or of applicable law, including anti-spam and data protection law.</p>
      </Section>

      <Section n={12} title="Suspension, deletion and termination">
        <List items={[
          <>You may stop using Scout at any time. An owner can download everything in the workspace ("Export all data") and delete the workspace under Settings. Both ask for your password, or a two-factor code, again.</>,
          <>Deleting a workspace is scheduled, not immediate: it happens no sooner than {DELETION_GRACE_DAYS} days after the request, on the first daily run after that. Until then the workspace keeps working, except that its campaigns are paused and cannot be started; every owner is emailed when the request is made and again about two days before the deletion; any owner can cancel it; and the export stays available.</>,
          <>At that point (and only after the reminder has gone out) the workspace and everything in it is permanently deleted and cannot be restored: members and their sign-ins, leads, companies, lists, campaigns, messages, do-not-contact lists, website-visitor data, API keys, senders, integrations, webhooks, settings, the workspace's security log, its members' recorded sign-in attempts and its upgrade requests. If the workspace has a paid subscription we cancel it at the same time.</>,
          <>What we keep after a deletion: one record that it took place (the workspace name, internal identifiers, the dates, and counts of what was removed) for {RETENTION.auditLogDays} days; invoices and payment records held by our payment provider; and copies in routine database backups until they expire. Data you exported, or sent to your own CRM or webhooks, is yours and is not affected.</>,
          <>We may suspend or terminate an account that breaches these terms, puts recipients or other customers at risk, or fails to pay, with notice where reasonable. A suspended workspace cannot be signed in to; its data is not deleted on a timer. An owner can ask us at <Mail /> for an export or for the workspace to be deleted, and we will act on that request within 30 days.</>,
        ]} />
      </Section>

      <Section n={13} title="Changes to these terms">
        <p>We may update these terms. We will post the new version here with a new date, and notify account owners by email for material changes. Continuing to use Scout after a change takes effect means you accept it.</p>
      </Section>

      <Section n={14} title="Governing law">
        <p>These terms are governed by the laws of India. The courts at Faridabad, Haryana have exclusive jurisdiction over any dispute arising from them or from your use of Scout.</p>
      </Section>

      <Section n={15} title="Contact">
        <p>MNB Research, Faridabad, Haryana, India · <Mail /></p>
      </Section>
    </LegalShell>
  );
}
