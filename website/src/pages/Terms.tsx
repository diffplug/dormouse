import type { MetaArgs } from "react-router";
import HostedPolicyLayout, { type PolicySection } from "../components/HostedPolicyLayout";
import { LINK_CLASS } from "../components/docs-tokens";
import { siteMeta, sitePath } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Hosted terms of service — Dormouse",
    description: "Terms for using the Dormouse Hosted account service operated by DiffPlug LLC.",
  });
}

export const TERMS_SECTIONS: PolicySection[] = [
  { id: "service", title: "The service", body: <>
    <p>These terms govern the Dormouse Hosted account service operated by DiffPlug LLC at hosted.dormouse.sh. By creating or using a Hosted account after these terms take effect, you agree to them. You must be legally able to enter this agreement. If you act for an organization, you must have authority to bind it.</p>
    <p>The current service provides accounts and sign-in management. Managed remote control, hosted voice, subscriptions, pricing, and launch dates are not promised by creating an account. Any paid service will have its own offer and payment terms before you buy it.</p>
    <p>The Dormouse software and self-hosted components remain subject to their own software licenses. These terms do not change those licenses or require a Hosted account to use local terminals.</p>
  </> },
  { id: "account", title: "Your account", body: <>
    <p>Use an email address or provider account you are authorized to use. Protect those accounts and your devices, and tell us if you believe someone is using your Hosted account without permission.</p>
    <p>You are responsible for activity you authorize through your account. Provider sign-in depends on the provider’s availability and policies. Keep access to at least one connected sign-in method: account merging, automatic recovery, and a sign-out-everywhere control are not available. Connecting a provider is an explicit account action; matching email addresses alone do not merge accounts.</p>
    <p>Our <a className={LINK_CLASS} href={sitePath("/privacy")}>privacy policy</a> explains how we handle account information.</p>
  </> },
  { id: "acceptable-use", title: "Acceptable use", body: <>
    <p>Do not use the service unlawfully, impersonate others, access accounts without authorization, send unwanted messages, interfere with other users, or bypass authentication, rate limits, or other security controls. Do not use the service to distribute malware or attack third parties.</p>
    <p>Good-faith security reports are welcome through our <a className={LINK_CLASS} href={sitePath("/security")}>security reporting process</a>. Avoid accessing other people’s data or disrupting service while investigating an issue.</p>
  </> },
  { id: "availability", title: "Availability and account closure", body: <>
    <p>This is an early account service. We may change features, interrupt operation for maintenance, or discontinue it. We do not promise uninterrupted availability or a particular future feature.</p>
    <p>We may restrict or suspend an account to address abuse, a security issue, a legal requirement, or a material violation of these terms. Where practical, we will explain the reason and provide a way to contact us; urgent protective action may come first.</p>
    <p>You may stop using the service at any time. Contact <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a> to request account closure or to ask us to review a restriction. Information is retained or deleted as described in the privacy policy and as required by law.</p>
  </> },
  { id: "responsibility", title: "Warranties and responsibility", body: <>
    <p>To the extent permitted by law, the early account service is provided “as is” and “as available,” without implied warranties of merchantability, fitness for a particular purpose, or non-infringement.</p>
    <p>To the extent permitted by law, DiffPlug LLC is not responsible for indirect or consequential losses arising from use of the service. Nothing in these terms excludes responsibility or consumer rights that cannot lawfully be excluded. You remain responsible for keeping independent copies of information you need.</p>
  </> },
  { id: "changes", title: "Changes and contact", body: <>
    <p>We will identify the effective date of changes on this page and provide reasonable advance notice of material changes, except when an urgent security or legal need requires earlier action. If you do not agree to changed terms, you may stop using the service and request account closure.</p>
    <p>For questions about these terms, contact DiffPlug LLC at <a className={LINK_CLASS} href="mailto:support@diffplug.com">support@diffplug.com</a>.</p>
  </> },
];

export default function Terms() {
  return <HostedPolicyLayout path="/terms" title="Dormouse Hosted terms of service" sections={TERMS_SECTIONS} />;
}
