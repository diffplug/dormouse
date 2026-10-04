import type { MetaArgs } from "react-router";
import HostedPolicyLayout, { type PolicySection } from "../components/HostedPolicyLayout";
import { LINK_CLASS } from "../components/docs-tokens";
import { siteMeta, sitePath } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Hosted terms of service — Dormouse",
    description: "Terms for Dormouse Hosted accounts and subscriptions, operated by DiffPlug LLC.",
  });
}

export const TERMS_SECTIONS: PolicySection[] = [
  { id: "service", title: "The service", body: <>
    <p>These terms govern Dormouse Hosted, operated by DiffPlug LLC: the account service at hosted.dormouse.sh and the paid subscription that adds managed voices and the managed Relay for Pocket. By creating or using a Hosted account, or buying a subscription, after these terms take effect, you agree to them. You must be legally able to enter this agreement. If you act for an organization, you must have authority to bind it.</p>
    <p>The <a className={LINK_CLASS} href={sitePath("/hosted")}>Hosted page</a> describes what a subscription includes and what it costs. An account alone is free and grants no paid features.</p>
    <p>The Dormouse software and self-hosted components remain subject to their own software licenses. These terms do not change those licenses or require a Hosted account to use local terminals, and nothing Dormouse ships free is moved behind a subscription.</p>
  </> },
  { id: "account", title: "Your account", body: <>
    <p>Use an email address or provider account you are authorized to use. Protect those accounts and your devices, and tell us if you believe someone is using your Hosted account without permission.</p>
    <p>You are responsible for activity you authorize through your account. Provider sign-in depends on the provider’s availability and policies. Keep access to at least one connected sign-in method: account merging, automatic recovery, and a sign-out-everywhere control are not available. Connecting a provider is an explicit account action; matching email addresses alone do not merge accounts.</p>
    <p>Our <a className={LINK_CLASS} href={sitePath("/privacy")}>privacy policy</a> explains how we handle account information.</p>
  </> },
  { id: "subscriptions", title: "Subscriptions and payment", body: <>
    <p>A subscription is billed monthly or yearly, at the price shown when you buy it, in US dollars. Stripe sells it to you as merchant of record through Stripe Managed Payments: Stripe takes the payment, adds or includes sales tax or VAT where it applies, and issues your receipts, and its terms govern the payment itself.</p>
    <p>Every plan renews automatically at the end of each period until you cancel. There is no free trial; the refund below takes its place.</p>
    <p>A subscription is personal. It covers the computers and phones you yourself use, with no per-device charge or activation count, and it may not be shared, resold, or transferred to someone else. For team or organization use, email <a className={LINK_CLASS} href="mailto:teams@dormouse.sh">teams@dormouse.sh</a>.</p>
    <p>If a renewal payment fails, the paid features stop until a payment succeeds. Dormouse keeps working in the meantime, with spoken alarms in your system voice.</p>
  </> },
  { id: "cancellation", title: "Cancellation and refunds", body: <>
    <p>You can cancel at any time from the billing portal in your account. Cancelling stops the next renewal; you keep the paid features until the end of the period you already paid for.</p>
    <p>Every plan has a 30-day refund: ask within 30 days of your first payment for a plan, or of a yearly renewal, and we will refund that payment in full. A refund ends the subscription and its paid features straight away, and a founding refund returns the seat to its cohort. Email <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a> to ask.</p>
    <p>This refund is in addition to any right to cancel or withdraw that the law where you live gives you.</p>
  </> },
  { id: "founding", title: "Founding prices", body: <>
    <p>A founding subscription is a yearly plan sold at a launch price, in cohorts of 100. When a cohort sells out the founding price rises, and founding closes when it reaches the list price.</p>
    <p>The price you paid is locked for as long as that subscription stays active. A later price change never affects it. If a founding renewal payment fails, you have 30 days to fix it and keep the locked price; after that, subscribing again is at the list price, as it is after you cancel and the paid period ends.</p>
    <p>A founding badge is cosmetic. It grants nothing beyond the plan itself.</p>
  </> },
  { id: "fair-use", title: "Fair use", body: <>
    <p>Managed voices have a daily limit per subscriber, sized for spoken alarms rather than general text-to-speech. Past it, Dormouse speaks in your system voice until the next day. The Relay likewise applies anti-abuse limits to the sessions and requests one account can make.</p>
    <p>Use managed voices only through Dormouse, for its alarms. Do not extract, resell, or redistribute the audio service or your credentials.</p>
  </> },
  { id: "acceptable-use", title: "Acceptable use", body: <>
    <p>Do not use the service unlawfully, impersonate others, access accounts without authorization, send unwanted messages, interfere with other users, or bypass authentication, rate limits, or other security controls. Do not use the service to distribute malware or attack third parties.</p>
    <p>Good-faith security reports are welcome through our <a className={LINK_CLASS} href={sitePath("/security")}>security reporting process</a>. Avoid accessing other people’s data or disrupting service while investigating an issue.</p>
  </> },
  { id: "availability", title: "Availability and account closure", body: <>
    <p>We may change features, interrupt operation for maintenance, or discontinue the service. We do not promise uninterrupted availability or a particular future feature. When managed voices are unavailable, Dormouse speaks in your system voice.</p>
    <p>If we shut Hosted down, we will tell subscribers in advance and stop renewals. The Relay is source-available and its <a className={LINK_CLASS} href={sitePath("/self-host")}>self-hosting guide</a> is published, so you can keep remote control running on your own Relay; spoken alarms fall back to your system voice, which needs nothing from us.</p>
    <p>We may restrict or suspend an account to address abuse, a security issue, a legal requirement, or a material violation of these terms. Where practical, we will explain the reason and provide a way to contact us; urgent protective action may come first.</p>
    <p>You may stop using the service at any time. Contact <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a> to request account closure or to ask us to review a restriction. Closing an account does not cancel a subscription by itself; cancel it first. Information is retained or deleted as described in the privacy policy and as required by law.</p>
  </> },
  { id: "responsibility", title: "Warranties and responsibility", body: <>
    <p>To the extent permitted by law, the service is provided “as is” and “as available,” without implied warranties of merchantability, fitness for a particular purpose, or non-infringement.</p>
    <p>To the extent permitted by law, DiffPlug LLC is not responsible for indirect or consequential losses arising from use of the service, and its total responsibility for any claim is limited to what you paid for Hosted in the twelve months before it. Nothing in these terms excludes responsibility or consumer rights that cannot lawfully be excluded. You remain responsible for keeping independent copies of information you need.</p>
  </> },
  { id: "changes", title: "Changes and contact", body: <>
    <p>We will identify the effective date of changes on this page and provide reasonable advance notice of material changes, except when an urgent security or legal need requires earlier action. If you do not agree to changed terms, you may cancel your subscription and request account closure.</p>
    <p>We may change the price of monthly and yearly plans. A change applies to an existing subscription only from its next renewal, after we tell you about it with enough time to cancel first, and it never applies to a founding price. The subscription sections apply from the day Hosted subscriptions go on sale.</p>
    <p>For questions about these terms, contact DiffPlug LLC at <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a>.</p>
  </> },
];

export default function Terms() {
  return <HostedPolicyLayout path="/terms" title="Dormouse Hosted terms of service" sections={TERMS_SECTIONS} />;
}
