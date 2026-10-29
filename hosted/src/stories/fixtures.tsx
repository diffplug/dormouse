import { useRef, useState } from "react";
import { HostedPage, type HostedPageProps } from "../HostedPage";
import { HostedFrame } from "./HostedFrame";
import { settledFrame } from "./canvas";
import { providers, type Computer, type Passkey, type Session } from "../api";
import type { BillingSummary } from "../billing";
import { TERMS_VERSION } from "../../server/policy-constants";

export const SESSION: Session = {
  user: { id: "account-studio", name: "Alex", email: "alex@example.com" },
  session: { createdAt: "2026-10-21T12:00:00Z", expiresAt: "2026-10-22T12:00:00Z" },
};
export const COMPUTERS: Computer[] = [
  { burrowId: "studio01-workstation", label: "studio (Dormouse)", enrolledAt: "2026-10-20T12:00:00Z" },
  { burrowId: "laptop02-notebook", label: null, enrolledAt: "2026-10-21T12:00:00Z" },
];
export const PASSKEYS: Passkey[] = [
  { credentialId: "phone-one", label: "iPhone", createdAt: "2026-10-20T12:00:00Z", burrowId: COMPUTERS[0].burrowId },
  { credentialId: "phone-two", label: "", createdAt: "2026-10-21T12:00:00Z", burrowId: null },
  { credentialId: "tablet", label: "iPad", createdAt: "2026-10-22T12:00:00Z", burrowId: COMPUTERS[1].burrowId },
];
export const ENROLLMENT = { code: "7KQM-X4TD", purpose: "remote" as const };
export const ACCOUNT = { session: SESSION, computers: COMPUTERS, passkeys: PASSKEYS };
/** Billing open, no plan held, the first founding cohort on sale. */
export const NO_PLAN: BillingSummary = {
  plan: null, price: null, active: false, until: null, renews: false, entitled: false, suspended: false,
  founding: { cohort: 0, seatsLeft: 63 }, founder: { offered: false, name: null }, consent: null, withdrawal: null, withdrawn: null,
};
/** A founding plan bought today, renewing next year. */
export const FOUNDING: BillingSummary = {
  ...NO_PLAN, plan: "founding", price: 50, active: true, until: "2027-10-21T12:00:00Z", renews: true, entitled: true,
  founder: { offered: true, name: null },
  consent: { termsVersion: TERMS_VERSION, consentedAt: "2026-10-21T12:00:00Z" },
};
/** The founding plan, bought in the EEA or UK a week ago: withdrawable online. */
export const WITHDRAWABLE: BillingSummary = {
  ...FOUNDING,
  withdrawal: {
    subscription: "sub_1QxStudioFounding", startedAt: "2026-10-21T12:00:00Z", until: "2026-11-11T12:00:00Z",
    email: "alex@example.com",
  },
};
/** Withdrawn from that plan: the acknowledgement the billing page keeps. */
export const WITHDRAWN: BillingSummary = {
  ...NO_PLAN,
  withdrawn: {
    reference: "4f6c1d2e-8a3b-4c5d-9e0f-1a2b3c4d5e6f", subscription: "sub_1QxStudioFounding", plan: "founding",
    startedAt: "2026-10-21T12:00:00Z", submittedAt: "2026-10-28T09:30:00Z", acknowledged: true, settled: true,
  },
};
export type HostedStoryArgs = Partial<HostedPageProps> & { phone?: boolean; light?: boolean };
const idle = async () => {};
const nothing = () => {};

/** Only form editing is local. Fixtures do not emulate authentication, polling,
 * or account mutations; App's DOM tests exercise those production handlers. */
export function HostedStory({ phone, light, ...args }: HostedStoryArgs) {
  const [email, setEmail] = useState(args.email ?? "");
  const [code, setCode] = useState(args.code ?? "");
  const [enterCode, setEnterCode] = useState(args.enterCode ?? false);
  const turnOffDialog = useRef<HTMLDialogElement>(null);
  return <HostedFrame phone={phone} light={light}><HostedPage
    session={null} enabled={[...providers]} accounts={[]} hostedVoice={null}
    computers={null} passkeys={null} enrolling={null} noPlan={false} loading={false} busy=""
    error={null} notice={null} comingSoon={false} fresh={true}
    act={async (_label, action) => { await action(); }} refresh={idle} approve={idle}
    signOut={idle} clearEnrollment={nothing} turnOffVoice={idle}
    removeOne={idle} removeKey={idle} submit={(event) => event.preventDefault()}
    sendCode={idle} noteContinued={nothing} social={idle}
    {...args}
    email={email} code={code} enterCode={enterCode}
    setEmail={setEmail} setCode={setCode} setEnterCode={setEnterCode} turnOffDialog={turnOffDialog}
    changeEmail={() => { setEnterCode(false); setCode(""); }}
  /></HostedFrame>;
}

/** Each story file spreads this and adds its title and args. */
export const hostedMeta = {
  component: HostedStory,
  parameters: { layout: "fullscreen" },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => { await settledFrame(canvasElement); },
} as const;
