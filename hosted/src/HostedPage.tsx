import { useEffect, useRef, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { DOOR_SHAPE_CLASS } from "dormouse-lib/components/design";
import DocsThemeControl from "dormouse-lib/site/DocsThemeControl";
import SiteHeader, { type SiteNavLink } from "dormouse-lib/site/SiteHeader";
import { DOCS_HEADER_STYLE } from "dormouse-lib/site/docs-paint";
import {
  ACCENT_TEXT_CLASS,
  CARD_BASE_CLASS,
  CARD_CLASS,
  CODE_CLASS,
  DASHED_ROW_CLASS,
  LINK_CLASS,
  MUTED_ACCENT_LINK_CLASS,
  MUTED_TEXT_CLASS,
  PAGE_INTRO_CLASS,
  PAGE_TITLE_CLASS,
  PANEL_CLASS,
  SECTION_CLASS,
  STATUS_BAD_TEXT_CLASS,
  siteButton,
} from "dormouse-lib/site/docs-tokens";
import { providerNames, type Account, type Computer, type HostedVoice, type Passkey, type Provider, type Session } from "./api";
import { RECENT_LOGIN_WINDOW, TERMS_VERSION } from "../server/policy-constants";
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS, LABEL_TEXT_CLASS, PRIMARY_CLASS } from "./classes";
import { ConfirmDigits } from "./ConfirmDigits";
import { NoPlanOffer } from "./NoPlanOffer";
import type { Enrollment } from "./enrollment";
import type { Notice, PageError } from "./settle";

export const SUBSCRIBE_URL = "https://nedshed.dev/subscribe";
const SELF_HOST_URL = "https://dormouse.sh/self-host/";

/** The site header's own links (`NAV_LINKS` in website/src/lib/site-nav.ts),
 * absolute because this is another origin. Playground also gives way on a
 * phone, making room for the "Hosted" beside the wordmark. */
const SITE_LINKS: readonly SiteNavLink[] = [
  { href: "https://dormouse.sh/playground/", label: "Playground", hideOnMobile: true },
  { href: "https://dormouse.sh/#download", label: "Download", hideOnMobile: true },
  { href: "https://dormouse.sh/docs", label: "Docs" },
  { href: "https://github.com/diffplug/dormouse", label: "GitHub", external: true },
];

const FOOTER_LINKS = [
  ["https://dormouse.sh/security/", "Dormouse security"],
  ["https://dormouse.sh/privacy/", "Privacy"],
  ["https://dormouse.sh/terms/", "Terms"],
] as const;

const BUTTON_CLASS = siteButton({ tone: "neutral", size: "fit" });
const TEXT_BUTTON_CLASS = `inline-flex min-h-11 items-center disabled:opacity-50 ${LINK_CLASS}`;
const HEADING_CLASS = "mb-2 font-display text-xl";
const ROW_CLASS = `flex min-h-14 items-center justify-between gap-4 py-1.5 ${DASHED_ROW_CLASS}`;
const DETAIL_CLASS = `block text-sm ${MUTED_TEXT_CLASS}`;
const FOOTNOTE_CLASS = `mt-10 text-sm ${MUTED_TEXT_CLASS}`;
/** A computer's id in the shape the app draws a minimized Pane: a door. */
const DOOR_CLASS = `${DOOR_SHAPE_CLASS} ml-1.5 inline-flex items-center justify-center border-b border-[var(--color-text)]/30 bg-[var(--color-text)]/[0.12] px-2.5`;

/** The free alternative to a plan, for remote control only: Natural Voice has
 * no self-hosted equivalent. */
function SelfHostLine() {
  return (
    <>
      Rather run your own Relay for free? See{" "}
      <a className={LINK_CLASS} href={SELF_HOST_URL} target="_blank" rel="noopener">
        how to self-host
      </a>
      .
    </>
  );
}

/** A state already in words, ticked as the plan cards tick theirs. */
function Ticked({ children }: { children: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${MUTED_TEXT_CLASS}`}>
      <CheckIcon size={16} weight="bold" className={ACCENT_TEXT_CLASS} aria-hidden="true" />
      {children}
    </span>
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
  /** This account has no plan, so it cannot approve a computer. */
  noPlan: boolean;
  loading: boolean;
  busy: string;
  error: PageError | null;
  notice: Notice | null;
  email: string;
  code: string;
  enterCode: boolean;
  comingSoon: boolean;
  fresh: boolean | null;
  /** The docs pages' theme control. Off in story frames, whose theme the
   * control (which paints the top-level document) cannot reach. */
  themeControl?: boolean;
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
  enrolling, noPlan, loading, busy, error, notice, email, code, enterCode,
  comingSoon, fresh, themeControl = false, act, refresh, approve, signOut, clearEnrollment, turnOffVoice,
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
    <div className="flex min-h-svh flex-col pt-16 md:pt-20" data-hosted-shell>
      <SiteHeader
        links={SITE_LINKS}
        brandHref="https://dormouse.sh"
        title="Hosted"
        style={DOCS_HEADER_STYLE}
      />
      <main className="mx-auto w-full max-w-[33rem] flex-1 px-6 pt-12 pb-16">
        <h1 className={`mb-3 text-balance leading-tight ${PAGE_TITLE_CLASS}`}>
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
        <p className={`mb-10 ${PAGE_INTRO_CLASS}`}>
          {comingSoon
            ? "Check out the devlog at nedshed.dev."
            : enrolling
            ? !enrolling.code
              ? "This link cannot be approved."
              : session
                ? noPlan
                  ? enrolling.purpose === "voice"
                    ? "Dormouse asked to turn on Natural Voice, but this account has no Hosted plan yet."
                    : <>Dormouse asked to enroll remote control, but this account has no Hosted plan yet. <SelfHostLine /></>
                  : enrolling.purpose === "voice"
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
          <a className={PRIMARY_CLASS} href={SUBSCRIBE_URL}>
            Subscribe at nedshed.dev
          </a>
        ) : (
          <>
            {error && (
              <div className={`mb-6 [overflow-wrap:anywhere] ${STATUS_BAD_TEXT_CLASS}`} role="alert">
                <p>{error.message}</p>
                <button
                  type="button"
                  className={TEXT_BUTTON_CLASS}
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
                className={notice.error
                  ? `${CARD_BASE_CLASS} mb-2 border-[var(--docs-status-bad)]/50 ${STATUS_BAD_TEXT_CLASS}`
                  : `${CARD_CLASS} mb-2`}
              >
                {notice.text}
              </p>
            )}
            {enrolling && (session || !enrolling.code) ? (
              <section aria-label="Computer to approve">
                {enrolling.code ? (
                  noPlan ? (
                    <>
                      <NoPlanOffer purpose={enrolling.purpose} />
                      {enrolling.purpose !== "voice" && (
                        <p className={`mt-6 ${MUTED_TEXT_CLASS}`}>
                          <SelfHostLine />
                        </p>
                      )}
                      <p className={`mt-8 mb-2 ${MUTED_TEXT_CLASS}`}>
                        Subscribed with another account? Sign in with it; this
                        code stays on this page.
                      </p>
                      <div>
                        <button
                          className={BUTTON_CLASS}
                          disabled={!!busy}
                          onClick={() => void signOut()}
                        >
                          {busy === "logout" ? "Signing out…" : "Use another account"}
                        </button>
                      </div>
                    </>
                  ) : !fresh ? (
                    <>
                      <p className={HELP_CLASS}>
                        Approving a computer needs a login from the last{" "}
                        {RECENT_LOGIN_WINDOW}. Sign in again; this code stays
                        on this page.
                      </p>
                      <button
                        className={PRIMARY_CLASS}
                        disabled={!!busy}
                        onClick={() => void signOut()}
                      >
                        {busy === "logout" ? "Signing out…" : "Sign in again"}
                      </button>
                    </>
                  ) : (
                    <ConfirmDigits
                      busy={busy}
                      onApprove={(digits) => void approve(enrolling.code!, digits)}
                    />
                  )
                ) : (
                  <p className={HELP_CLASS}>
                    This link has no valid code. Start again from Dormouse on
                    your computer.
                  </p>
                )}
                <button
                  type="button"
                  className={`mt-2 flex ${TEXT_BUTTON_CLASS}`}
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
                <dl>
                  <dt className={LABEL_TEXT_CLASS}>Email</dt>
                  <dd className="[overflow-wrap:anywhere]">{session.user.email ?? "No email shared"}</dd>
                  <dt className={`mt-4 ${LABEL_TEXT_CLASS}`}>Account ID</dt>
                  <dd className="[overflow-wrap:anywhere]"><code className={CODE_CLASS}>{session.user.id}</code></dd>
                </dl>
                {!session.user.email && (
                  <p className={`mt-4 ${HELP_CLASS}`}>
                    Use a connected provider to sign in. This account has no
                    email recovery method.
                  </p>
                )}
                <section aria-labelledby="methods" className={SECTION_CLASS}>
                  <h2 id="methods" className={HEADING_CLASS}>Sign-in methods</h2>
                  <p className={HELP_CLASS}>
                    Connecting a provider lets you use it to sign in to this
                    account, even with a different email address.
                  </p>
                  {session.user.email && (
                    <div className={ROW_CLASS}>
                      <span>Email code</span>
                      <Ticked>Available</Ticked>
                    </div>
                  )}
                  {enabled.map((provider) => {
                    const linked = accounts.some(
                      (account) => account.providerId === provider,
                    );
                    return (
                      <div className={ROW_CLASS} key={provider}>
                        <span>{providerNames[provider]}</span>
                        {linked ? (
                          <Ticked>Connected</Ticked>
                        ) : (
                          <button
                            className={BUTTON_CLASS}
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
                      <p className={`mt-4 ${HELP_CLASS}`}>
                        To connect another provider, sign out and sign in again.
                        Connections require a login from the last{" "}
                        {RECENT_LOGIN_WINDOW}.
                      </p>
                    )}
                </section>
                {voiceShown && (
                  <section aria-labelledby="voice" className={SECTION_CLASS}>
                    <h2 id="voice" className={HEADING_CLASS}>Natural Voice</h2>
                    {hostedVoice.on ? (
                      <>
                        <p className={HELP_CLASS}>
                          {hostedVoice.entitled
                            ? "Alarms use Natural Voice on the computers where you turned it on."
                            : "Natural Voice is on for your computers, but your account has no Hosted plan, so alarms use the system voice."}{" "}
                          Natural Voice is in admin-only testing.
                        </p>
                        <button
                          className={BUTTON_CLASS}
                          disabled={!!busy}
                          onClick={() => turnOffDialog.current?.showModal()}
                        >
                          Turn off Natural Voice
                        </button>
                      </>
                    ) : (
                      <p className={HELP_CLASS}>
                        To turn on Natural Voice, open Dormouse on your computer
                        and go to Settings → Notifications. Natural Voice is in
                        admin-only testing.
                      </p>
                    )}
                    <dialog
                      ref={turnOffDialog}
                      aria-labelledby="voice-off-title"
                      className="m-auto w-[calc(100%-2rem)] max-w-lg bg-transparent p-0 backdrop:bg-black/70"
                      onCancel={(event) => busy && event.preventDefault()}
                    >
                      <div className={PANEL_CLASS}>
                        <h2 id="voice-off-title" className="mb-2 font-display text-2xl">Turn off Natural Voice?</h2>
                        <p className={MUTED_TEXT_CLASS}>
                          Every computer where you turned it on goes back to the
                          system voice. To use Natural Voice again, turn it on in
                          Dormouse on each computer.
                        </p>
                        <div className="mt-6 flex justify-end gap-2">
                          <button
                            className={BUTTON_CLASS}
                            disabled={!!busy}
                            onClick={() => turnOffDialog.current?.close()}
                          >
                            Cancel
                          </button>
                          <button
                            className={siteButton({ size: "fit" })}
                            disabled={!!busy}
                            onClick={() => void turnOffVoice()}
                          >
                            {busy === "voice-off" ? "Turning off…" : "Turn off"}
                          </button>
                        </div>
                      </div>
                    </dialog>
                  </section>
                )}
                {computers && (
                  <section aria-labelledby="computers" className={SECTION_CLASS}>
                    <h2 id="computers" className={HEADING_CLASS}>Computers</h2>
                    <p className={HELP_CLASS}>
                      A phone reaches an enrolled computer through the Hosted Relay
                      once paired by two digits typed at that computer. Remote control
                      is in admin-only testing.
                    </p>
                    {computers.length === 0 && (
                      <p className={HELP_CLASS}>
                        No computers yet. To enroll one, open Dormouse on that
                        computer and go to Settings → Network → Phones →
                        Hosted Relay → Enroll remote control.
                      </p>
                    )}
                    {computers.map((computer) => (
                      <div className={ROW_CLASS} key={computer.burrowId}>
                        <span>
                          Computer
                          <span className={DOOR_CLASS}>{computer.burrowId.slice(0, 8)}</span>
                          <span className={DETAIL_CLASS}>
                            Enrolled{" "}
                            {new Date(computer.enrolledAt).toLocaleDateString()}
                          </span>
                        </span>
                        <button
                          className={BUTTON_CLASS}
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
                  <section aria-labelledby="passkeys" className={SECTION_CLASS}>
                    <h2 id="passkeys" className={HEADING_CLASS}>Passkeys</h2>
                    <p className={HELP_CLASS}>
                      Each passkey signs a phone in to every computer above. A
                      computer&rsquo;s setup code adds one. Remove any you do not
                      recognize, and that phone can no longer sign in.
                    </p>
                    {passkeys.length === 0 && (
                      <p className={HELP_CLASS}>No passkeys yet.</p>
                    )}
                    {passkeys.map((passkey) => (
                      <div className={ROW_CLASS} key={passkey.credentialId}>
                        <span>
                          {passkey.label || "Unnamed passkey"}
                          <span className={DETAIL_CLASS}>
                            Added{" "}
                            {new Date(passkey.createdAt).toLocaleDateString()}
                            {passkey.burrowId
                              ? ` from Computer ${passkey.burrowId.slice(0, 8)}`
                              : ""}
                          </span>
                        </span>
                        <button
                          className={BUTTON_CLASS}
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
                <section className={SECTION_CLASS}>
                  <h2 className={HEADING_CLASS}>Signed in on this browser</h2>
                  <p className={HELP_CLASS}>
                    Signing in elsewhere keeps this browser signed in. This
                    login expires{" "}
                    {new Date(session.session.expiresAt).toLocaleString()}.
                  </p>
                  <button className={BUTTON_CLASS} disabled={!!busy} onClick={() => void signOut()}>
                    {busy === "logout" ? "Signing out…" : "Sign out"}
                  </button>
                </section>
                {!(voiceShown && computers) && (
                  <p className={FOOTNOTE_CLASS}>
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
                  <label htmlFor="email" className={LABEL_CLASS}>Email address</label>
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
                    className={INPUT_CLASS}
                  />
                  {enterCode && (
                    <>
                      <label htmlFor="code" className={LABEL_CLASS}>8-digit sign-in code</label>
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
                        className={INPUT_CLASS}
                      />
                    </>
                  )}
                  <button className={PRIMARY_CLASS} disabled={!!busy} type="submit">
                    {busy === "email"
                      ? "Sending code…"
                      : busy === "verify"
                        ? "Signing in…"
                        : enterCode
                          ? "Sign in"
                          : "Email me a code"}
                  </button>
                  <div className="mt-1 flex justify-between gap-4">
                    {enterCode ? (
                      <>
                        <button
                          type="button"
                          className={TEXT_BUTTON_CLASS}
                          disabled={!!busy}
                          onClick={changeEmail}
                        >
                          Change email
                        </button>
                        <button
                          type="button"
                          className={TEXT_BUTTON_CLASS}
                          disabled={!!busy}
                          onClick={() => void sendCode()}
                        >
                          Send a new code
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={TEXT_BUTTON_CLASS}
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
                    className="mt-8 mb-6 grid grid-cols-2 gap-2"
                  >
                    <p className={`col-span-full mb-1 text-sm ${MUTED_TEXT_CLASS}`}>Or continue with</p>
                    {enabled.map((provider) => (
                      <button
                        key={provider}
                        className={BUTTON_CLASS}
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
                <p className={HELP_CLASS}>
                  By continuing, you agree to the{" "}
                  <a
                    href="https://dormouse.sh/terms/"
                    target="_blank"
                    rel="noreferrer"
                    className={LINK_CLASS}
                  >
                    Terms
                  </a>{" "}
                  (version {TERMS_VERSION}) and acknowledge the{" "}
                  <a
                    href="https://dormouse.sh/privacy/"
                    target="_blank"
                    rel="noreferrer"
                    className={LINK_CLASS}
                  >
                    Privacy policy
                  </a>
                  .
                </p>
                {enrolling && enabled.length > 0 ? (
                  <p className={HELP_CLASS}>
                    Signing in with a provider leaves this page. Afterwards,
                    open the link from Dormouse again.
                  </p>
                ) : (
                  <p className={HELP_CLASS}>
                    Already have an account? Use your existing sign-in method,
                    then connect other providers from your account.
                  </p>
                )}
                {!enrolling && (
                  <p className={FOOTNOTE_CLASS}>
                    Natural Voice and remote control are not available yet.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </main>
      <footer className={`flex flex-wrap items-center gap-x-7 border-t border-[var(--color-text)]/15 px-4 pt-4 pb-6 text-sm md:px-8 ${MUTED_TEXT_CLASS}`}>
        <span className="mr-auto py-2">Optional services. Your terminals run on your own computer.</span>
        {FOOTER_LINKS.map(([href, label]) => (
          <a key={href} href={href} rel="noreferrer" className={`inline-flex min-h-11 items-center ${MUTED_ACCENT_LINK_CLASS}`}>{label}</a>
        ))}
        {themeControl ? (
          <div className="lg:hidden">
            <DocsThemeControl variant="inline" offerStore={false} />
          </div>
        ) : null}
      </footer>
      {themeControl ? <DocsThemeControl offerStore={false} /> : null}
    </div>
  );
}
