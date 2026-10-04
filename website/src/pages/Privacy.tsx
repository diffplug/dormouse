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
    <p>DiffPlug LLC operates Dormouse Hosted: the account service at hosted.dormouse.sh, the managed Relay and Pocket at relay.dormouse.sh, and managed voices at voice.dormouse.sh. This policy covers those services, the paid subscription that unlocks them, and related support. Contact us at <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a> about privacy or your account.</p>
    <p>Dormouse itself runs on your computer and sends no telemetry. The desktop app’s update check fetches a version file from dormouse.sh and carries nothing about you or your terminals; Settings → Network → Nothing turns it off. Creating an account does not upload your terminal contents, commands, files, or audio. The sections below say exactly what each Hosted feature sends when you choose to use it.</p>
    <p>This policy does not describe a Relay you operate yourself or third-party services you choose to open. Those services have their own operators and policies.</p>
  </> },
  { id: "information", title: "Account and sign-in", body: <>
    <p>When you use email sign-in, we process your email address, its verification status, sign-in requests, and one-time verification codes. We store a protected representation of each code to verify it.</p>
    <p>If you choose Google, GitHub, Microsoft, or Apple sign-in, we receive the provider’s account identifier and the identity information it supplies, which may include your name, email address, verification status, and profile-image URL. Apple may supply a private relay address. We use the provider identifier to recognize you even when your email changes. We do not request access to your mail, documents, repositories, or contacts.</p>
    <p>We keep account and connected-provider records, creation and update times, and browser login records. Login records can include your IP address and browser information. We also process cookies, temporary sign-in state, and abuse-prevention records. Our infrastructure providers process connection and operational information to deliver and secure the service.</p>
    <p>When you sign in a copy of Dormouse to your account, we store only a hash of the credential that copy keeps, never the credential itself, with when it was created, last used, and revoked.</p>
    <p>If you contact support, we receive your message and anything you choose to include. Please do not send passwords, API keys, or terminal contents that contain secrets.</p>
  </> },
  { id: "subscription", title: "Your subscription", body: <>
    <p>Stripe sells Hosted subscriptions as merchant of record, through Stripe Managed Payments. Checkout and the billing portal are pages Stripe hosts: Stripe collects your card or other payment details, billing address, and tax information, calculates and collects sales tax or VAT, and issues your receipts, under its own privacy policy. We never see or store your full card number.</p>
    <p>From Stripe we receive and keep what we need to run your subscription: the Stripe customer and subscription identifiers linked to your account, the email address used for billing, the plan and price you bought (which records your founding cohort, if any), its status, the end of the current billing period, whether it is set to cancel, and a record of each billing event Stripe sends us.</p>
    <p>If you buy a founding plan and tick the box to appear in the founders row, we show your account name and profile picture on the Hosted page. The box starts unticked, and you can untick it at any time. We serve those pictures from our own site, so a visitor’s browser never asks your sign-in provider for them. Everyone else counts only toward the total.</p>
    <p>After checkout we may ask four optional questions about price. Nothing is sent unless you answer, and we use the answers only to set future prices.</p>
  </> },
  { id: "voice", title: "Managed voices", body: <>
    <p>When managed voices are on, Dormouse sends voice.dormouse.sh exactly the short spoken label — the terminal’s name, after Dormouse strips punctuation and symbols, blanks anything that looks like a secret, and shortens it — and the id of the voice that should say it, along with your credential. Never terminal output, a notification body, or a session id. Dormouse tells you this before it sends the first request, and caches clips on your computer so a repeated label sends nothing.</p>
    <p>We forward the label and voice id to ElevenLabs, which turns them into speech. We do not log the label. We keep a count of your requests per day to apply the fair-use limit.</p>
    <p>ElevenLabs keeps the text of each request in its speech history. We use an ElevenLabs account dedicated to Dormouse voice, delete that history shortly after each request, and delete again every five minutes anything that pass missed. We cannot guarantee how soon ElevenLabs erases a request after we delete it.</p>
  </> },
  { id: "remote-control", title: "Remote control and Pocket", body: <>
    <p>The managed Relay connects Dormouse on your computers to Pocket on your phone. Terminal traffic and push notification contents are end-to-end encrypted between your devices, so the Relay carries them without being able to read them.</p>
    <p>We store the computers you enroll (an identifier, a hash of each one’s Relay credential, and when it enrolled), the passkeys you register for Pocket (each one’s public key and the label you gave it), hashes of Pocket sign-in sessions, and short-lived sign-in and pairing challenges. If you turn on push notifications, we store each phone’s push subscription: the address your phone’s browser vendor gave it, the keys that seal notifications to it, and when it subscribed.</p>
    <p>While it carries a connection, the Relay also sees connection metadata: IP addresses, which of your computers are online, which devices talk to which, and the timing and size of encrypted traffic. Once a session switches to a direct connection between your devices, the Relay sees only that the session exists. The <a className={LINK_CLASS} href={TRUST_MODEL_URL}>trust model</a> lists this in full.</p>
    <p>A one-time connection link needs no account. Its rendezvous forwards the encrypted handshake between your phone and computer without reading or storing it; our infrastructure provider still sees the connection’s IP addresses.</p>
  </> },
  { id: "use", title: "How we use it", body: <>
    <p>We use this information to create and recognize your account, verify sign-in, connect methods you explicitly select, send requested sign-in codes, check on each request that your subscription is active, deliver the features you pay for, apply fair-use limits, prevent abuse, troubleshoot failures, and answer support requests. We discard provider access, refresh, and identity tokens after identity verification rather than storing them in your account.</p>
    <p>We do not sell Hosted information, use it for targeted advertising, or use it to train general-purpose AI models. Signing in or subscribing does not subscribe you to a newsletter. The account site uses necessary authentication and security cookies and does not load marketing analytics.</p>
    <p>To see whether Hosted is working, we keep aggregate daily counts on our own servers — for example, checkouts per plan, sign-ins per method, and voice requests answered or over the limit — with no per-person analytics. A count row carries no account id, email address, IP address, browser information, or text. Links to the Hosted page from Dormouse or this site may carry a short label naming where you came from (such as the voice setting or the tutorial), which is counted, in the same aggregate way, if you check out. There are no analytics scripts or tracking cookies.</p>
  </> },
  { id: "providers", title: "Who processes the information", body: <>
    <p>Cloudflare runs the account, Relay, and voice services. Neon stores the database. Postmark delivers sign-in emails and processes their recipients, contents, and delivery records. GitHub stores encrypted database-backup artifacts. Stripe handles payments, tax, and receipts as merchant of record. ElevenLabs generates managed voices from the spoken labels described above. These providers process information needed to provide their services to us.</p>
    <p>Push notifications travel through the push service your phone’s browser uses — Apple, Google, Mozilla, or Microsoft — which sees that a sealed notification was sent, not what it says.</p>
    <p>A sign-in provider you choose learns that you are authenticating with Dormouse and handles that interaction under its own policy. Our email and support providers also process messages you send us. Authorized DiffPlug personnel may access information to operate the service or respond to your request.</p>
    <p>We may disclose information when legally required, to investigate abuse, or to protect people and the service. If a business transfer affects your information, we will notify you of material changes to how it is handled.</p>
  </> },
  { id: "retention", title: "Storage, retention, and security", body: <>
    <p>We operate from the United States and use providers that may process information in other countries. The production database is hosted in the United States.</p>
    <p>We retain account information while you maintain an account and as needed for support, security, and legal obligations. A sign-in code expires after ten minutes and a browser login expires after 24 hours; expiry does not mean every related database or delivery-log record is immediately erased. Expired Relay sessions and challenges are swept hourly. Removing a computer from your account deletes its Relay records and push subscriptions. Backup copies remain until their retention periods end.</p>
    <p>We keep subscription and billing-event records after a subscription ends, and after account deletion, for as long as accounting, tax, and dispute obligations require. Stripe keeps its own payment records under its policy.</p>
    <p>We protect information with encrypted connections, access controls, and encrypted backup artifacts. No service can guarantee absolute security. Our <a className={LINK_CLASS} href={sitePath("/security")}>security documentation</a> describes the current boundaries and limitations.</p>
  </> },
  { id: "choices", title: "Your choices and requests", body: <>
    <p>You choose which sign-in providers to use. Connecting another provider requires a recent login and an explicit action in your account. Logging out ends the current browser’s login; it does not log out your other devices. You can also remove Dormouse’s authorization in a provider’s settings, but that alone does not delete your Dormouse account.</p>
    <p>You can turn managed voices or push notifications off in Dormouse at any time, remove an enrolled computer from your account, leave the founders row, and cancel your subscription from the billing portal.</p>
    <p>Contact <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a> to request access, correction, export, or deletion of account information, or to raise a privacy concern. We may need to verify your identity before acting. We handle requests according to applicable law, including any rights to object, restrict processing, or complain to a data-protection authority. Account deletion is handled through support; there is no self-service deletion control yet.</p>
  </> },
  { id: "updates", title: "Changes to this policy", body: <>
    <p>We will update this page when our practices change and identify the effective date. We will provide notice before materially expanding how we use account information, and obtain consent when required. The subscription, voice, and remote-control sections apply from the day Hosted subscriptions go on sale.</p>
  </> },
];

export default function Privacy() {
  return <HostedPolicyLayout path="/privacy" title="Dormouse Hosted privacy policy" sections={PRIVACY_SECTIONS} />;
}
