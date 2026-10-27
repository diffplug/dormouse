import { useRef, useState } from "react";
import { HostedPage, type HostedPageProps } from "../HostedPage";
import { HostedFrame } from "./HostedFrame";
import { settledFrame } from "./canvas";
import { providers, type Computer, type Passkey, type Session } from "../api";

export const SESSION: Session = {
  user: { id: "account-studio", name: "Alex", email: "alex@example.com" },
  session: { createdAt: "2026-10-21T12:00:00Z", expiresAt: "2026-10-22T12:00:00Z" },
};
export const COMPUTERS: Computer[] = [
  { burrowId: "studio01-workstation", enrolledAt: "2026-10-20T12:00:00Z" },
  { burrowId: "laptop02-notebook", enrolledAt: "2026-10-21T12:00:00Z" },
];
export const PASSKEYS: Passkey[] = [
  { credentialId: "phone-one", label: "iPhone", createdAt: "2026-10-20T12:00:00Z", burrowId: COMPUTERS[0].burrowId },
  { credentialId: "phone-two", label: "", createdAt: "2026-10-21T12:00:00Z", burrowId: null },
];
export const ENROLLMENT = { code: "7KQM-X4TD", purpose: "remote" as const };
export const ACCOUNT = { session: SESSION, computers: COMPUTERS, passkeys: PASSKEYS };
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
