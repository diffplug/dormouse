import { useEffect, useRef, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import { providerNames, type Account, type Computer, type HostedVoice, type Passkey, type Provider, type Session } from "./api";
import { RECENT_LOGIN_WINDOW, TERMS_VERSION } from "../server/policy-constants";
import { ConfirmDigits } from "./ConfirmDigits";
import { ThemeSelect } from "./ThemeSelect";
import type { Enrollment } from "./enrollment";
import type { Notice, PageError } from "./settle";

export const SUBSCRIBE_URL = "https://nedshed.dev/subscribe";

/** The pricing cards' check mark, beside a state that is already in words. */
function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3.25 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** App's existing values and callbacks; the controller owns their lifecycle. */
export interface HostedPageProps {
  session: Session | null;
  enabled: Provider[];
  accounts: Account[];
  hostedVoice: HostedVoice | null;
  turnOffDialog: RefObject<HTMLDialogElement | null>;
  computers: Computer[] | null;
  passkeys: Passkey[] | null;
  enrolling: Enrollment | null;
  loading: boolean;
  busy: string;
  error: PageError | null;
  notice: Notice | null;
  email: string;
  code: string;
  enterCode: boolean;
  comingSoon: boolean;
  fresh: boolean | null;
  act: (label: string, action: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<unknown>;
  approve: (code: string, confirmDigits: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearEnrollment: () => void;
  turnOffVoice: () => Promise<void>;
  removeOne: (burrowId: string) => Promise<void>;
  removeKey: (credentialId: string) => Promise<void>;
  submit: (event: FormEvent) => void;
  setEmail: Dispatch<SetStateAction<string>>;
  setCode: Dispatch<SetStateAction<string>>;
  setEnterCode: Dispatch<SetStateAction<boolean>>;
  sendCode: () => Promise<void>;
  noteContinued: () => void;
  social: (provider: Provider, linking: boolean) => Promise<void>;
  changeEmail: () => void;
}

export function HostedPage({
  session, enabled, accounts, hostedVoice, turnOffDialog, computers, passkeys,
  enrolling, loading, busy, error, notice, email, code, enterCode,
  comingSoon, fresh, act, refresh, approve, signOut, clearEnrollment, turnOffVoice,
  removeOne, removeKey, submit, setEmail, setCode, setEnterCode, changeEmail,
  sendCode, noteContinued, social,
}: HostedPageProps) {
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (enterCode) codeInput.current?.focus();
  }, [enterCode]);
  // A lapsed account still sees, and may turn off, a Natural Voice left on.
  const voiceShown = !!hostedVoice && (hostedVoice.entitled || hostedVoice.on);

  return (
    <div className="shell">
      <header>
        <div className="brand">
          <a href="https://dormouse.sh" rel="noreferrer">Dormouse</a>
          <a href="/">Hosted</a>
        </div>
        {/* The site header's own links (NAV_LINKS in website/src/lib/site-nav.ts). */}
        <nav aria-label="Dormouse site">
          <a href="https://dormouse.sh/playground" rel="noreferrer" className="narrow-hidden">Playground</a>
          <a href="https://dormouse.sh/#download" rel="noreferrer" className="wide-only">Download</a>
          <a href="https://dormouse.sh/docs" rel="noreferrer">Docs</a>
          <a href="https://github.com/diffplug/dormouse" rel="noreferrer">GitHub</a>
        </nav>
      </header>
      <main>
        <h1>
          {comingSoon
            ? "Coming soon"
            : enrolling
            ? enrolling.purpose === "voice"
              ? "Turn on Natural Voice"
              : "Enroll remote control"
            : session
              ? "Your account"
              : "Sign in to Dormouse Hosted"}
        </h1>
        <p className="intro">
          {comingSoon
            ? "Check out the devlog at nedshed.dev."
            : enrolling
            ? !enrolling.code
              ? "This link cannot be approved."
              : session
                ? enrolling.purpose === "voice"
                  ? "Dormouse asked to turn on Natural Voice with this account."
                  : "Dormouse asked to enroll remote control with this account."
                : "Sign in to approve the computer that sent you here."
            : session
              ? "Manage how you sign in."
              : "One account for Dormouse’s hosted services."}
        </p>
        {loading ? (
          <p role="status">Checking your account…</p>
        ) : comingSoon ? (
          <a className="primary button-link" href={SUBSCRIBE_URL}>
            Subscribe at nedshed.dev
          </a>
        ) : (
          <>
            {error && (
              <div className="error" role="alert">
                <p>{error.message}</p>
                <button
                  type="button"
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => void act("retry", refresh)}
                >
                  Retry connection
                </button>
              </div>
            )}
            {notice && (
              <p
                role={notice.error ? "alert" : "status"}
                className={notice.error ? "notice failed" : "notice"}
              >
                {notice.text}
              </p>
            )}
            {enrolling && (session || !enrolling.code) ? (
              <section aria-label="Computer to approve" className="enroll">
                {enrolling.code ? (
                  <>
                    {fresh ? (
                      <ConfirmDigits
                        busy={busy}
                        onApprove={(digits) => void approve(enrolling.code!, digits)}
                      />
                    ) : (
                      <>
                        <p className="help">
                          Approving a computer needs a login from the last{" "}
                          {RECENT_LOGIN_WINDOW}. Sign in again; this code stays
                          on this page.
                        </p>
                        <button
                          className="primary"
                          disabled={!!busy}
                          onClick={() => void signOut()}
                        >
                          {busy === "logout" ? "Signing out…" : "Sign in again"}
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <p className="help">
                    This link has no valid code. Start again from Dormouse on
                    your computer.
                  </p>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={!!busy}
                  onClick={clearEnrollment}
                >
                  {enrolling.code
                    ? "Don’t approve"
                    : session
                      ? "Go to your account"
                      : "Sign in"}
                </button>
              </section>
            ) : session ? (
              <>
                <dl className="identity">
                  <dt>Email</dt>
                  <dd>{session.user.email ?? "No email shared"}</dd>
                  <dt>Account ID</dt>
                  <dd><code className="token">{session.user.id}</code></dd>
                </dl>
                {!session.user.email && (
                  <p className="help">
                    Use a connected provider to sign in. This account has no
                    email recovery method.
                  </p>
                )}
                <section aria-labelledby="methods">
                  <h2 id="methods">Sign-in methods</h2>
                  <p className="help">
                    Connecting a provider lets you use it to sign in to this
                    account, even with a different email address.
                  </p>
                  {session.user.email && (
                    <div className="method">
                      <span>Email code</span>
                      <span className="status"><Check />Available</span>
                    </div>
                  )}
                  {enabled.map((provider) => {
                    const linked = accounts.some(
                      (account) => account.providerId === provider,
                    );
                    return (
                      <div className="method" key={provider}>
                        <span>{providerNames[provider]}</span>
                        {linked ? (
                          <span className="status"><Check />Connected</span>
                        ) : (
                          <button
                            disabled={!!busy || !fresh}
                            onClick={() =>
                              void act(provider, () => social(provider, true))
                            }
                          >
                            {busy === provider
                              ? "Connecting…"
                              : `Connect ${providerNames[provider]}`}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {!fresh &&
                    enabled.some(
                      (provider) =>
                        !accounts.some(
                          (account) => account.providerId === provider,
                        ),
                    ) && (
                      <p className="help">
                        To connect another provider, sign out and sign in again.
                        Connections require a login from the last{" "}
                        {RECENT_LOGIN_WINDOW}.
                      </p>
                    )}
                </section>
                {voiceShown && (
                  <section aria-labelledby="voice">
                    <h2 id="voice">Natural Voice</h2>
                    {hostedVoice.on ? (
                      <>
                        <p className="help">
                          {hostedVoice.entitled
                            ? "Alarms use Natural Voice on the computers where you turned it on."
                            : "Natural Voice is on for your computers, but your account has no Hosted plan, so alarms use the system voice."}{" "}
                          Natural Voice is in admin-only testing.
                        </p>
                        <button
                          disabled={!!busy}
                          onClick={() => turnOffDialog.current?.showModal()}
                        >
                          Turn off Natural Voice
                        </button>
                      </>
                    ) : (
                      <p className="help">
                        To turn on Natural Voice, open Dormouse on your computer
                        and go to Settings → Notifications. Natural Voice is in
                        admin-only testing.
                      </p>
                    )}
                    <dialog
                      ref={turnOffDialog}
                      aria-labelledby="voice-off-title"
                      onCancel={(event) => busy && event.preventDefault()}
                    >
                      <h2 id="voice-off-title">Turn off Natural Voice?</h2>
                      <p>
                        Every computer where you turned it on goes back to the
                        system voice. To use Natural Voice again, turn it on in
                        Dormouse on each computer.
                      </p>
                      <div className="dialog-actions">
                        <button
                          disabled={!!busy}
                          onClick={() => turnOffDialog.current?.close()}
                        >
                          Cancel
                        </button>
                        <button
                          className="confirm"
                          disabled={!!busy}
                          onClick={() => void turnOffVoice()}
                        >
                          {busy === "voice-off" ? "Turning off…" : "Turn off"}
                        </button>
                      </div>
                    </dialog>
                  </section>
                )}
                {computers && (
                  <section aria-labelledby="computers">
                    <h2 id="computers">Computers</h2>
                    <p className="help">
                      A phone reaches an enrolled computer through the Hosted Relay
                      once paired by two digits typed at that computer. Remote control
                      is in admin-only testing.
                    </p>
                    {computers.length === 0 && (
                      <p className="help">
                        No computers yet. Enroll one from Dormouse on that
                        computer.
                      </p>
                    )}
                    {computers.map((computer) => (
                      <div className="method" key={computer.burrowId}>
                        <span>
                          Computer
                          <span className="door">{computer.burrowId.slice(0, 8)}</span>
                          <span className="detail">
                            Enrolled{" "}
                            {new Date(computer.enrolledAt).toLocaleDateString()}
                          </span>
                        </span>
                        <button
                          disabled={!!busy}
                          onClick={() => void removeOne(computer.burrowId)}
                        >
                          {busy === `remove-${computer.burrowId}`
                            ? "Removing…"
                            : "Remove"}
                        </button>
                      </div>
                    ))}
                  </section>
                )}
                {passkeys && (
                  <section aria-labelledby="passkeys">
                    <h2 id="passkeys">Passkeys</h2>
                    <p className="help">
                      Each passkey signs a phone in to every computer above. A
                      computer&rsquo;s setup code adds one. Remove any you do not
                      recognize, and that phone can no longer sign in.
                    </p>
                    {passkeys.length === 0 && (
                      <p className="help">No passkeys yet.</p>
                    )}
                    {passkeys.map((passkey) => (
                      <div className="method" key={passkey.credentialId}>
                        <span>
                          {passkey.label || "Unnamed passkey"}
                          <span className="detail">
                            Added{" "}
                            {new Date(passkey.createdAt).toLocaleDateString()}
                            {passkey.burrowId
                              ? ` from Computer ${passkey.burrowId.slice(0, 8)}`
                              : ""}
                          </span>
                        </span>
                        <button
                          disabled={!!busy}
                          onClick={() => void removeKey(passkey.credentialId)}
                        >
                          {busy === `passkey-${passkey.credentialId}`
                            ? "Removing…"
                            : "Remove"}
                        </button>
                      </div>
                    ))}
                  </section>
                )}
                <section>
                  <h2>Signed in on this browser</h2>
                  <p className="help">
                    Signing in elsewhere keeps this browser signed in. This
                    login expires{" "}
                    {new Date(session.session.expiresAt).toLocaleString()}.
                  </p>
                  <button disabled={!!busy} onClick={() => void signOut()}>
                    {busy === "logout" ? "Signing out…" : "Sign out"}
                  </button>
                </section>
                {!(voiceShown && computers) && (
                  <p className="footnote">
                    {voiceShown
                      ? "Remote control is"
                      : computers
                        ? "Natural Voice is"
                        : "Natural Voice and remote control are"}{" "}
                    not available yet.
                  </p>
                )}
              </>
            ) : (
              <>
                <form onSubmit={submit}>
                  <label htmlFor="email">Email address</label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={email}
                    readOnly={enterCode}
                    disabled={!!busy}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                  {enterCode && (
                    <>
                      <label htmlFor="code">8-digit sign-in code</label>
                      <input
                        ref={codeInput}
                        id="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{8}"
                        minLength={8}
                        maxLength={8}
                        required
                        value={code}
                        disabled={!!busy}
                        onChange={(event) =>
                          setCode(event.target.value.replace(/\D/g, ""))
                        }
                      />
                    </>
                  )}
                  <button className="primary" disabled={!!busy} type="submit">
                    {busy === "email"
                      ? "Sending code…"
                      : busy === "verify"
                        ? "Signing in…"
                        : enterCode
                          ? "Sign in"
                          : "Email me a code"}
                  </button>
                  <div className="form-options">
                    {enterCode ? (
                      <>
                        <button
                          type="button"
                          className="text-button"
                          disabled={!!busy}
                          onClick={changeEmail}
                        >
                          Change email
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={!!busy}
                          onClick={() => void sendCode()}
                        >
                          Send a new code
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        disabled={!!busy}
                        onClick={(event) => {
                          const field = event.currentTarget.form?.elements.namedItem("email");
                          if ((field as HTMLInputElement | null)?.reportValidity())
                            setEnterCode(true);
                        }}
                      >
                        I already have a code
                      </button>
                    )}
                  </div>
                </form>
                {enabled.length > 0 && (
                  <section
                    aria-label="Other sign-in methods"
                    className="providers"
                  >
                    <p className="separator">Or continue with</p>
                    {enabled.map((provider) => (
                      <button
                        key={provider}
                        disabled={!!busy}
                        onClick={() =>
                          void act(provider, () => {
                            noteContinued();
                            return social(provider, false);
                          })
                        }
                      >
                        {busy === provider
                          ? "Opening…"
                          : providerNames[provider]}
                      </button>
                    ))}
                  </section>
                )}
                <p className="help">
                  By continuing, you agree to the{" "}
                  <a
                    href="https://dormouse.sh/terms/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Terms
                  </a>{" "}
                  (version {TERMS_VERSION}) and acknowledge the{" "}
                  <a
                    href="https://dormouse.sh/privacy/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Privacy policy
                  </a>
                  .
                </p>
                {enrolling && enabled.length > 0 ? (
                  <p className="help">
                    Signing in with a provider leaves this page. Afterwards,
                    open the link from Dormouse again.
                  </p>
                ) : (
                  <p className="help">
                    Already have an account? Use your existing sign-in method,
                    then connect other providers from your account.
                  </p>
                )}
                {!enrolling && (
                  <p className="footnote">
                    Natural Voice and remote control are not available yet.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </main>
      <footer>
        <span className="tagline">Optional services. Your terminals run on your own computer.</span>
        <a href="https://dormouse.sh/security" rel="noreferrer">Dormouse security</a>
        <a href="https://dormouse.sh/privacy/" rel="noreferrer">Privacy</a>
        <a href="https://dormouse.sh/terms/" rel="noreferrer">Terms</a>
        <ThemeSelect />
      </footer>
    </div>
  );
}
