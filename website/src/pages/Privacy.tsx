import type { MetaArgs } from "react-router";
import HostedPolicyLayout, { type PolicySection } from "../components/HostedPolicyLayout";
import { LINK_CLASS } from "../components/docs-tokens";
import { siteMeta, sitePath } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Hosted privacy policy — Dormouse",
    description: "How Dormouse Hosted handles account, subscription, voice, remote-control, and support information.",
  });
}

const TRUST_MODEL_URL = "https://github.com/diffplug/dormouse/blob/main/docs/specs/remote-security-model.md#residual-metadata";

export const PRIVACY_SECTIONS: PolicySection[] = [
  { id: "scope", title: "Who we are and what this covers", body: <>
    <p>DiffPlug LLC operates Dormouse Hosted and is the controller of the personal information described here: the account service at hosted.dormouse.sh, the managed Relay and Pocket at relay.dormouse.sh, and managed voices at voice.dormouse.sh. This policy covers those services, the paid subscription that unlocks them, and related support. Contact us at <a className={LINK_CLASS} href="mailto:support@dormouse.sh">support@dormouse.sh</a> about privacy or your account.</p>
    <p>Our business address is DiffPlug LLC, 447 Sutter St Ste 405, San Francisco, CA 94108, United States.</p>
    <p>Dormouse itself runs on your computer and sends no usage telemetry. An update check fetches a version file from dormouse.sh without sending terminal contents or a Hosted account identifier. Automatic update checks run only if enabled. "Check now" makes a request when you click it. Creating an account does not upload your terminal contents, commands, files, or audio.</p>
    <p>This website, dormouse.sh, is served by Cloudflare, which processes visitors’ IP addresses and request information to deliver it. Fonts are served from dormouse.sh.</p>
    <p>This policy does not describe a Relay you operate yourself or third-party services you choose to open. Those services have their own operators and policies.</p>
    <p>Hosted is not directed to children under 13, and we do not knowingly collect their personal information. If you believe a child under 13 has given us personal information, contact us and we will delete it.</p>
  </> },
  { id: "information", title: "Account and sign-in", body: <>
    <p>When you use email sign-in, we process your email address, its verification status, sign-in requests, and one-time verification codes. We store a protected representation of each code to verify it.</p>
    <p>If you choose Google, GitHub, Microsoft, or Apple sign-in, we receive the provider’s account identifier and the identity information it supplies, which may include your name, email address, verification status, and profile-image URL. Apple may supply a private relay address. We use the provider identifier to recognize you even when your email changes. We do not request access to your mail, documents, repositories, or contacts.</p>
    <p>We keep account and connected-provider records, creation and update times, browser login records, and which version of the terms you agreed to and when. Login records can include your IP address and browser information. We also process cookies, temporary sign-in state, and abuse-prevention records.</p>
    <p>When you sign in a copy of Dormouse to your account, we store only a hash of the credential that copy keeps, never the credential itself, with when it was created, last used, and revoked.</p>
    <p>If you contact support, we receive your message and anything you choose to include. Please do not send passwords, API keys, or terminal contents that contain secrets.</p>
  </> },
  { id: "subscription", title: "Your subscription", body: <>
    <p>You buy Hosted subscriptions from DiffPlug LLC. We use Stripe Billing, Stripe-hosted Checkout, and Stripe’s customer portal to process payments and manage subscriptions. Stripe collects payment details, billing addresses, and applicable tax information. It processes information on our behalf and for its own purposes, such as fraud prevention and legal compliance, as described in <a className={LINK_CLASS} href="https://stripe.com/privacy">Stripe’s privacy policy</a>. Dormouse does not receive or store your full card number.</p>
    <p>We receive subscription and billing information from Stripe: customer and subscription identifiers linked to your account, the billing email, the plan and price (including a founding cohort, if any), status, billing-period dates, cancellation status, and billing-event records. Stripe’s dashboard and billing records may also make your billing address, tax information, invoices, and limited payment-method details, such as card brand and last four digits, available to us for support, accounting, refunds, and disputes.</p>
    <p>If you buy a founding plan and tick the box to appear in the founders row, we show your account name and profile picture on the Hosted page. The box starts unticked, and you can untick it at any time. We serve those pictures from our own site, so a visitor’s browser never asks your sign-in provider for them. Everyone else counts only toward the total.</p>
    <p>After checkout we may ask four optional questions about price. Nothing is sent unless you answer, and we use the answers only to set future prices.</p>
  </> },
  { id: "voice", title: "Managed voices", body: <>
    <p>When managed voices are on, Dormouse sends voice.dormouse.sh a shortened version of the terminal’s displayed label, the selected voice identifier, and your authentication credential. The label can include a program-supplied terminal title, a command label, or a directory name. We remove punctuation and some patterns that resemble secrets, but this filtering cannot reliably remove all confidential information. Avoid sensitive labels when using managed voices.</p>
    <p>The voice request does not upload the terminal’s screen or output stream, a notification body, or a session identifier. Dormouse explains the label disclosure before the first managed-voice request. Cached clips play locally; generating a clip that is not in the cache makes a new request.</p>
    <p>We forward the label and voice id to ElevenLabs, which turns them into speech. We do not log the label. We keep a count of your requests per day to apply the fair-use limit.</p>
    <p>ElevenLabs keeps generated text and audio in its speech history. We use a dedicated service account within our ElevenLabs workspace and automatically delete its history, normally within minutes. This is not zero-retention processing: deletion requests can fail, and deleting visible history does not necessarily erase debugging or moderation records. ElevenLabs documents that deleted data can remain in backups for up to 30 days. See its <a className={LINK_CLASS} href="https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode">retention documentation</a>. We cannot guarantee when every provider copy is erased.</p>
    <p>We have turned off model-training data use in the ElevenLabs workspace that contains Dormouse’s service account. This is separate from history deletion. ElevenLabs’ <a className={LINK_CLASS} href="https://elevenlabs.io/terms-of-use">terms</a> state that the opt-out takes effect after they process it and does not undo earlier uses of data or materials resulting from those uses. The opt-out does not eliminate the retention described above.</p>
  </> },
  { id: "remote-control", title: "Remote control and Pocket", body: <>
    <p>The managed Relay connects Dormouse on your computers to Pocket on your phone. Terminal traffic and push notification contents are end-to-end encrypted between your devices, so the Relay carries them without being able to read them.</p>
    <p>We store the computers you enroll (an identifier, a hash of each one’s Relay credential, and when it enrolled), the passkeys you register for Pocket (each one’s public key and the label you gave it), hashes of Pocket sign-in sessions, and short-lived sign-in and pairing challenges. If you turn on push notifications, we store each phone’s push subscription: the address your phone’s browser vendor gave it, the keys that seal notifications to it, and when it subscribed.</p>
    <p>While it carries a connection, the Relay also sees connection metadata: IP addresses, which of your computers are online, which devices talk to which, and the timing and size of encrypted traffic. Once a session switches to a direct connection between your devices, the Relay sees only that the session exists. The <a className={LINK_CLASS} href={TRUST_MODEL_URL}>trust model</a> lists this in full.</p>
    <p>A one-time connection link needs no account. Its rendezvous forwards the encrypted handshake between your phone and computer without reading or storing it.</p>
  </> },
  { id: "use", title: "How we use it", body: <>
    <p>We use this information to create and recognize your account, verify sign-in, connect methods you explicitly select, send requested sign-in codes, check on each request that your subscription is active, deliver the features you pay for, apply fair-use limits, prevent abuse, troubleshoot failures, and answer support requests. We discard provider access, refresh, and identity tokens after identity verification rather than storing them in your account.</p>
    <p>Every request to Hosted carries your IP address and connection information, which we and our infrastructure providers use to deliver the request, secure the service, and limit request rates. Rate-limit records we store hold a keyed hash of the address, not the address itself, and are kept only briefly.</p>
    <p>DiffPlug does not sell Hosted information, use it for targeted advertising, or use it to train AI models. The managed-voice section describes ElevenLabs’ separate processing. Signing in or subscribing does not subscribe you to a newsletter. The account site uses necessary authentication and security cookies and does not load marketing analytics.</p>
    <p>To see whether Hosted is working, we may keep aggregate daily counts on our own servers — for example, checkouts per plan, sign-ins per method, and voice requests answered or over the limit — with no per-person analytics. A count row carries no account id, email address, IP address, browser information, or text. Links to the Hosted page from Dormouse or this site may carry a short label naming where you came from (such as the voice setting or the tutorial), which may be counted, in the same aggregate way, if you check out. There are no analytics scripts or tracking cookies. Because we do not track you across sites or sell your information, browser Do Not Track and Global Privacy Control signals have nothing further to turn off, and we do not change our practices in response to them.</p>
  </> },
  { id: "legal-bases", title: "Our legal bases", body: <>
    <p>Where the EU or UK GDPR applies, our legal basis depends on the purpose:</p>
    <ul className="list-disc space-y-2 pl-6">
      <li>Account creation, authentication, subscription administration, requested voice and remote-control features, and account support: performing our contract with you, or taking steps you request before entering it.</li>
      <li>Preventing abuse, protecting accounts and infrastructure, investigating failures, and handling disputes: our legitimate interests in operating a secure and reliable service and protecting legal rights, balanced against your rights and interests.</li>
      <li>Accounting, required tax records, and legally required disclosures: compliance with applicable legal obligations. Where an obligation arises only under non-EU or non-UK law, we assess an applicable basis, such as legitimate interests, rather than treating that foreign law alone as an EU or UK legal obligation.</li>
      <li>Displaying your name and picture in the founders row: your consent. You can withdraw it in your account at any time; withdrawal does not affect processing that was lawful before you withdrew.</li>
      <li>Optional price research: our legitimate interest in understanding demand and setting prices. Participation is voluntary and does not affect your subscription.</li>
    </ul>
    <p>We need account and billing information to provide the corresponding services; without it we cannot create the account or fulfill the purchase. Public founder attribution and survey answers are optional.</p>
  </> },
  { id: "providers", title: "Who processes the information", body: <>
    <p>Cloudflare runs the account, Relay, and voice services. Neon stores the database. Postmark delivers sign-in emails and processes their recipients, contents, and delivery records. GitHub stores encrypted database-backup artifacts. Stripe processes payments and manages billing. ElevenLabs generates managed voices from spoken labels. These providers process information needed to provide their services; Stripe’s and ElevenLabs’ additional processing is described above.</p>
    <p>Push notifications travel through the push service your phone’s browser uses — Apple, Google, Mozilla, or Microsoft — which sees that a sealed notification was sent, not what it says.</p>
    <p>A sign-in provider you choose learns that you are authenticating with Dormouse and handles that interaction under its own policy. Our email and support providers also process messages you send us. Authorized DiffPlug personnel may access information to operate the service or respond to your request.</p>
    <p>We may disclose information when legally required, to investigate abuse, or to protect people and the service. If a business transfer affects your information, we will notify you of material changes to how it is handled.</p>
  </> },
  { id: "retention", title: "Storage, retention, and security", body: <>
    <p>We operate from the United States and use providers that may process information in other countries. The production database is hosted in the United States.</p>
    <p>We retain account information while you maintain an account. Account-linked daily voice counters currently remain until account deletion. Sign-in codes, browser logins, Relay sessions, and pairing challenges are short-lived; expiry does not mean every related database or delivery-log record is immediately erased. Removing a computer from your account deletes its Relay records and push subscriptions. Our encrypted deployment-backup artifacts in GitHub are configured to expire after 30 days; providers’ own backups follow their retention arrangements.</p>
    <p>Support and security records are retained for the time needed to resolve the request or incident and any related dispute, or to meet a legal preservation obligation. We assess the record’s purpose, whether the issue remains open, and applicable legal deadlines. Deleting an account does not immediately remove copies in backups or records we must keep for these purposes.</p>
    <p>We keep subscription and billing-event records after a subscription ends, and after account deletion, for as long as accounting, tax, and dispute obligations require. Stripe keeps its own payment records under its policy.</p>
    <p>We protect information with encrypted connections, access controls, and encrypted backup artifacts. No service can guarantee absolute security. Our <a className={LINK_CLASS} href={sitePath("/security")}>security documentation</a> describes the current boundaries and limitations.</p>
  </> },
  { id: "choices", title: "Your choices and requests", body: <>
    <p>You choose which sign-in providers to use. Connecting another provider requires a recent login and an explicit action in your account. Logging out ends the current browser’s login; it does not log out your other devices. You can also remove Dormouse’s authorization in a provider’s settings, but that alone does not delete your Dormouse account.</p>
    <p>You can turn managed voices or push notifications off in Dormouse at any time, remove an enrolled computer from your account, leave the founders row, and cancel your subscription from the billing portal.</p>
    <p>Contact <a className={LINK_CLASS} href="mailto:support@dormouse.sh">support@dormouse.sh</a> to request access, correction, export, or deletion of account information, or to raise a privacy concern. We may need to verify your identity before acting. We handle requests according to applicable law, including any rights to object, restrict processing, or complain to a data-protection authority. Account deletion is handled through support; there is no self-service deletion control yet.</p>
    <p>If the EU or UK GDPR applies, you may request access, correction, erasure, restriction, or portability where the relevant conditions apply, and object to processing based on legitimate interests because of your particular situation. You may withdraw consent without affecting prior lawful processing. We respond without undue delay, normally within one month; if the law permits more time for a complex request, we will explain the extension within that month. You may complain to your local data-protection authority in the EEA or the <a className={LINK_CLASS} href="https://ico.org.uk/make-a-complaint/">UK Information Commissioner</a>, without first contacting us.</p>
  </> },
  { id: "updates", title: "Changes to this policy", body: <>
    <p>We will update this page when our practices change and identify the effective date. We will provide notice before materially expanding how we use account information, and obtain consent when required.</p>
  </> },
];

export default function Privacy() {
  return <HostedPolicyLayout path="/privacy" title="Dormouse Hosted privacy policy" applicability="This notice applies from publication. Descriptions of optional or paid features apply only when those features are available and you use them. Material changes to processing remain subject to the notice and consent provisions below." sections={PRIVACY_SECTIONS} />;
}
