import type { MetaArgs } from "react-router";
import HostedPolicyLayout, { type PolicySection } from "../components/HostedPolicyLayout";
import { LINK_CLASS } from "../components/docs-tokens";
import { siteMeta, sitePath } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Hosted privacy policy — Dormouse",
    description: "How Dormouse Hosted handles account, sign-in, and support information.",
  });
}

export const PRIVACY_SECTIONS: PolicySection[] = [
  { id: "scope", title: "Who we are and what this covers", body: <>
    <p>DiffPlug LLC operates Dormouse Hosted at hosted.dormouse.sh. This policy covers its account service and related support. Contact us at <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a> about privacy or your account.</p>
    <p>The current service lets you create an account and manage sign-in methods. Creating an account does not upload your terminal contents, commands, files, or audio. Managed remote control and hosted voice are not available yet; we will explain their data handling before offering them.</p>
    <p>This policy does not describe a Relay you operate yourself or third-party services you choose to open. Those services have their own operators and policies.</p>
  </> },
  { id: "information", title: "Information we handle", body: <>
    <p>When you use email sign-in, we process your email address, its verification status, sign-in requests, and one-time verification codes. We store a protected representation of each code to verify it.</p>
    <p>If you choose Google, GitHub, Microsoft, or Apple sign-in, we receive the provider’s account identifier and the identity information it supplies, which may include your name, email address, verification status, and profile-image URL. Apple may supply a private relay address. We use the provider identifier to recognize you even when your email changes. We do not request access to your mail, documents, repositories, or contacts.</p>
    <p>We keep account and connected-provider records, creation and update times, and browser login records. Login records can include your IP address and browser information. We also process cookies, temporary sign-in state, and abuse-prevention records. Our infrastructure providers process connection and operational information to deliver and secure the service.</p>
    <p>If you contact support, we receive your message and anything you choose to include. Please do not send passwords, API keys, or terminal contents that contain secrets.</p>
  </> },
  { id: "use", title: "How we use it", body: <>
    <p>We use this information to create and recognize your account, verify sign-in, connect methods you explicitly select, send requested sign-in codes, prevent abuse, troubleshoot failures, and answer support requests. We discard provider access, refresh, and identity tokens after identity verification rather than storing them in your account.</p>
    <p>We do not sell Hosted account information, use it for targeted advertising, or use it to train general-purpose AI models. Signing in does not subscribe you to a newsletter. The account site uses necessary authentication and security cookies and does not load marketing analytics.</p>
    <p>We measure use of the service only as aggregate daily counts: sign-ins by method, checkouts and subscriptions by plan, spoken alarms and push notifications sent, and which Dormouse link a visit to the Hosted page came from, which those links name in their address. No count records an account, email address, IP address, or browser information, so there are no per-person analytics, and we keep the daily counts indefinitely.</p>
  </> },
  { id: "providers", title: "Who processes the information", body: <>
    <p>Cloudflare runs the account website and API. Neon stores the account database. Postmark delivers sign-in emails and processes their recipients, contents, and delivery records. GitHub stores encrypted database-backup artifacts. These providers process information needed to provide their services to us.</p>
    <p>A sign-in provider you choose learns that you are authenticating with Dormouse and handles that interaction under its own policy. Our email and support providers also process messages you send us. Authorized DiffPlug personnel may access information to operate the service or respond to your request.</p>
    <p>We may disclose information when legally required, to investigate abuse, or to protect people and the service. If a business transfer affects your information, we will notify you of material changes to how it is handled.</p>
  </> },
  { id: "retention", title: "Storage, retention, and security", body: <>
    <p>We operate from the United States and use providers that may process information in other countries. The production account database is hosted in the United States.</p>
    <p>We retain account information while you maintain an account and as needed for support, security, and legal obligations. A sign-in code expires after ten minutes and a browser login expires after 24 hours; expiry does not mean every related database or delivery-log record is immediately erased. Backup copies remain until their retention periods end.</p>
    <p>We protect information with encrypted connections, access controls, and encrypted backup artifacts. No service can guarantee absolute security. Our <a className={LINK_CLASS} href={sitePath("/security")}>security documentation</a> describes the current boundaries and limitations.</p>
  </> },
  { id: "choices", title: "Your choices and requests", body: <>
    <p>You choose which sign-in providers to use. Connecting another provider requires a recent login and an explicit action in your account. Logging out ends the current browser’s login; it does not log out your other devices. You can also remove Dormouse’s authorization in a provider’s settings, but that alone does not delete your Dormouse account.</p>
    <p>Contact <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a> to request access, correction, export, or deletion of account information, or to raise a privacy concern. We may need to verify your identity before acting. We handle requests according to applicable law, including any rights to object, restrict processing, or complain to a data-protection authority. Account deletion is handled through support; there is no self-service deletion control yet.</p>
  </> },
  { id: "updates", title: "Changes to this policy", body: <>
    <p>We will update this page when our practices change and identify the effective date. We will provide notice before materially expanding how we use account information, and obtain consent when required.</p>
  </> },
];

export default function Privacy() {
  return <HostedPolicyLayout path="/privacy" title="Dormouse Hosted privacy policy" sections={PRIVACY_SECTIONS} />;
}
