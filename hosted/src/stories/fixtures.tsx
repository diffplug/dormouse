import { useContext, useEffect, useRef, useState } from "react";
import { HostedPage, type HostedPageProps } from "../HostedPage";
import { HostedDocument, HostedFrame } from "./HostedFrame";
import type { Computer, Passkey, Session } from "../api";

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
export const ENABLED = ["github", "google", "microsoft", "apple"] as const;
export type HostedStoryArgs = Partial<HostedPageProps> & { width?: number; dark?: boolean };
const idle = async () => {};
const nothing = () => {};

/** Only form editing is local. Fixtures do not emulate authentication, polling,
 * or account mutations; App's DOM tests exercise those production handlers. */
function PageFixture(args: HostedStoryArgs) {
  const document = useContext(HostedDocument)!;
  const [email, setEmail] = useState(args.email ?? "");
  const [code, setCode] = useState(args.code ?? "");
  const [enterCode, setEnterCode] = useState(args.enterCode ?? false);
  const [notice, setNotice] = useState(args.notice ?? null);
  const [error, setError] = useState(args.error ?? null);
  const codeInput = useRef<HTMLInputElement>(null);
  const turnOffDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (enterCode) codeInput.current?.focus(); }, [enterCode]);
  return <HostedPage
    session={null} enabled={[...ENABLED]} accounts={[]} hostedVoice={null}
    computers={null} passkeys={null} enrolling={null} loading={false} busy=""
    comingSoon={false} fresh={true}
    act={async (_label, action) => { await action(); }} refresh={idle} approve={idle}
    signOut={idle} clearEnrollment={nothing} turnOffVoice={idle}
    removeOne={idle} removeKey={idle} submit={(event) => event.preventDefault()}
    sendCode={idle} noteContinued={nothing} social={idle}
    alreadyHaveCode={() => {
      if (document.querySelector<HTMLInputElement>("#email")?.reportValidity()) setEnterCode(true);
    }}
    {...args}
    email={email} code={code} enterCode={enterCode} notice={notice} error={error}
    setEmail={setEmail} setCode={setCode} setEnterCode={setEnterCode}
    setNotice={setNotice} setError={setError} codeInput={codeInput} turnOffDialog={turnOffDialog}
  />;
}
export function HostedStory(args: HostedStoryArgs) {
  return <HostedFrame width={args.width} dark={args.dark}><PageFixture {...args} /></HostedFrame>;
}

export const frameParameters = {
  layout: "fullscreen",
  docs: { story: { inline: false, height: "1000px" } },
} as const;
