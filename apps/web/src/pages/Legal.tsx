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

const LAST_UPDATED = "1 October 2026";
const CONTACT = "contact@mnbresearch.com";

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
          <><strong>Prospects</strong> - people and companies whose business contact details our customers find, store or email using Scout.</>,
          <><strong>Website visitors</strong> - people who visit a customer's website where that customer has installed the Scout visitor pixel, and visitors to our own site.</>,
        ]} />
      </Section>

      <Section n={2} title="Information about customers">
        <List items={[
          <><strong>Account data:</strong> name, email address, a hashed password (we never store it in plain text) or, if you sign in with Google, your Google account email and name; your workspace name, plan and role.</>,
          <><strong>Usage data:</strong> the searches, lists, ICPs, campaigns, credits used and settings you create, plus basic logs (time, IP address, user agent) needed to run, secure and debug the service.</>,
          <><strong>Sender and integration settings:</strong> email sender details and credentials you connect (for example an SMTP password or Resend API key), webhooks and API keys. Credentials are stored encrypted.</>,
          <><strong>Billing and upgrade requests:</strong> the contact details you give us when you request a plan or upgrade.</>,
        ]} />
        <p>We use this to provide and secure the service, to bill and support you, and to email you about your account (for example password resets, invites and service notices). We do not sell customer data.</p>
      </Section>

      <Section n={3} title="Prospect data: customers are in charge">
        <p>
          Customers use Scout to find, verify, enrich and contact business prospects. For that prospect data the <strong>customer is the controller</strong> (in DPDP Act terms, the Data Fiduciary): they decide whom to look up, what to keep and whom to contact. <strong>Scout processes it on the customer's behalf</strong> and only to provide the features the customer uses.
        </p>
        <p>Prospect data can include a person's name, job title, employer, business email address, phone number, LinkedIn or company URL and public company information, along with email verification results and campaign activity (sends, opens, clicks, replies, bounces and unsubscribes).</p>
        <p>
          It comes from public sources (company websites, search results, public profiles) and from the third-party data and verification providers listed in section 8. If you are a prospect and want to know why a customer contacted you, or want your data removed, contact that customer directly; you can also email us at <Mail /> and we will pass your request to the relevant customer and help them act on it.
        </p>
      </Section>

      <Section n={4} title="Email sending, tracking and unsubscribes">
        <p>
          Customers send campaign emails through Scout using their own sender accounts or our shared sending provider. To report results to the customer, emails may include an open-tracking pixel and tracked links, which record when a message is opened or a link is clicked.
        </p>
        <p>
          Every campaign email carries an unsubscribe link. When a recipient uses it, their address is added to that customer's do-not-contact list and any running sequence to them is stopped; Scout will not send them further emails from that customer. Replies and bounces are recorded so sequences stop automatically.
        </p>
      </Section>

      <Section n={5} title="The website visitor pixel">
        <p>
          A customer can install a small Scout script on their own website to learn which <strong>companies</strong> visit it. When a page loads, the script sends the page address and title, the referrer, a random session identifier (kept in the browser's session storage, not a cookie), time on page and the browser's user agent. The visitor's IP address is used at that moment to look up the organisation it belongs to.
        </p>
        <p>
          We do not store the raw IP address with the visit: it is stored only as a one-way hash, salted per pixel, so it cannot be read back or matched across different customers' sites. Identification is company-level - on its own the pixel does not identify individual people, and it sets no cookies. A customer can choose to call the script's "identify" function to attach details a visitor has given them (for example an email typed into their own form); in that case the customer is the one identifying the visitor. The customer installing the pixel is responsible for telling their visitors about it in their own privacy notice and for obtaining any consent their local law requires.
        </p>
      </Section>

      <Section n={6} title="Cookies and local storage">
        <p>
          The Scout app does not use advertising or third-party tracking cookies. When you sign in, your session token is kept in your browser's local storage so you stay signed in, and short-lived values (such as which page to return to after a session expires) are kept in session storage. Clearing your browser storage signs you out.
        </p>
      </Section>

      <Section n={7} title="AI features">
        <p>
          Some features send text to AI model providers: drafting and personalising emails, classifying replies, summarising research, and measuring how AI models describe a brand (the AI visibility feature). What is sent is limited to what the feature needs - for example a prospect's name, title and company for a personalised email, or a question about a brand for a visibility check. We use providers' API offerings, which under their terms do not use API inputs to train their models by default.
        </p>
      </Section>

      <Section n={8} title="Sub-processors">
        <p>We rely on these categories of providers to run Scout. Each receives only what it needs for its function:</p>
        <List items={[
          <><strong>Hosting and infrastructure:</strong> Render (application servers and database), Vercel (web app hosting), Cloudflare (network, DNS and security).</>,
          <><strong>Email delivery:</strong> Resend, or the SMTP provider a customer connects (for example Brevo, Gmail or Zoho).</>,
          <><strong>Data, enrichment and email verification:</strong> providers such as Apollo, Hunter, Reoon and MillionVerifier.</>,
          <><strong>Web search:</strong> providers such as Serper and Brave Search, used to find public company and contact information.</>,
          <><strong>AI models:</strong> Groq (Llama models), Google (Gemini) and Anthropic (Claude); a customer may also connect another OpenAI-compatible provider.</>,
          <><strong>Sign-in:</strong> Google, if you choose "Continue with Google".</>,
        ]} />
        <p>The exact set changes as we add or replace providers; email us for the current list.</p>
      </Section>

      <Section n={9} title="Where data is processed">
        <p>Our providers operate servers in several countries, including the United States, the European Union and India, so your data may be processed outside the country you are in. Where the law requires it, we rely on appropriate safeguards for those transfers.</p>
      </Section>

      <Section n={10} title="Retention">
        <List items={[
          <>Account and workspace data is kept while the account is active.</>,
          <>Prospect data, campaign history and visitor data are kept until the customer deletes them or closes their workspace.</>,
          <>Do-not-contact (unsubscribe) records are kept for as long as the customer's workspace exists, because deleting them would allow the person to be emailed again.</>,
          <>After an account is closed, we delete or anonymise its data within 90 days, except where we must keep records for legal, tax or security reasons, and except for copies in routine backups, which expire on their normal cycle.</>,
        ]} />
      </Section>

      <Section n={11} title="Your rights">
        <p>
          Depending on where you are, you have rights over your personal data. Under India's Digital Personal Data Protection Act, 2023 you can ask for a summary of the personal data we process about you, ask us to correct, complete, update or erase it, withdraw consent where processing relies on consent, nominate someone to exercise your rights, and raise a grievance with us. Where the EU or UK GDPR applies, you can also ask for access, portability, restriction of processing, and object to processing based on legitimate interests, and you may complain to your local data protection authority.
        </p>
        <p>
          To make a request - including a request to delete your account or your data - email <Mail /> from the address in question. We will respond within 30 days. If the data is prospect data held by one of our customers, we will forward the request to them and support them in answering it. Our grievance contact under the DPDP Act is the same address.
        </p>
      </Section>

      <Section n={12} title="Security">
        <p>We use encrypted connections (HTTPS), hashed passwords, encrypted storage of sender and integration credentials, and access controls within each workspace. No system is perfectly secure; if we learn of a breach affecting your data we will notify you and the relevant authorities as the law requires.</p>
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
          <strong>You are responsible for having a lawful basis to collect and contact each prospect</strong> (for example legitimate interest or consent, as your law requires), for including accurate sender identification and a working unsubscribe in your messages, and for honouring opt-outs. Scout adds an unsubscribe link and suppression list to help, but compliance is yours. If you install the visitor pixel, you must disclose it in your own website's privacy notice and obtain any consent your law requires.
        </p>
        <p>We may suspend sending, or the account, where we see signs of abuse such as high bounce or complaint rates, to protect recipients and the deliverability of other customers.</p>
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

      <Section n={12} title="Suspension and termination">
        <List items={[
          <>You may stop using Scout and ask us to close your account at any time by emailing <Mail />.</>,
          <>We may suspend or terminate an account that breaches these terms, puts recipients or other customers at risk, or fails to pay, with notice where reasonable.</>,
          <>After termination your access ends; you can ask for an export of your data within 30 days, after which we delete it as described in the Privacy Policy.</>,
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
