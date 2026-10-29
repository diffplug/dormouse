import { useEffect, useRef, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { DOOR_SHAPE_CLASS } from "dormouse-lib/components/design";
import {
  ACCENT_TEXT_CLASS,
  CARD_BASE_CLASS,
  CARD_CLASS,
  CODE_CLASS,
  DASHED_ROW_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
  PAGE_INTRO_CLASS,
  PAGE_TITLE_CLASS,
  PANEL_CLASS,
  SECTION_CLASS,
  STATUS_BAD_TEXT_CLASS,
  siteButton,
} from "dormouse-lib/site/docs-tokens";
import { providerNames, type Account, type Computer, type HostedVoice, type Passkey, type Provider, type Session } from "./api";
import { RECENT_LOGIN_WINDOW, TERMS_VERSION, type Plan } from "../server/policy-constants";
import {
  BUTTON_CLASS,
  HEADING_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  LABEL_TEXT_CLASS,
  PRIMARY_CLASS,
  TEXT_BUTTON_CLASS,
} from "./classes";
import { ConfirmDigits } from "./ConfirmDigits";
import { HostedShell } from "./HostedShell";
import { NoPlanOffer } from "./NoPlanOffer";
import { PLAN_NAMES } from "../../website/src/lib/hosted-pricing.ts";
import type { BillingSummary } from "../server/billing-summary";
import { Checkout } from "./Checkout";
import { CloseAccount } from "./Closure";
import { FoundersOptIn, PlanConfirmation, PlanSection } from "./Plan";
import { WithdrawalAcknowledgement, WithdrawalFunction } from "./Withdrawal";
import type { Enrollment } from "./enrollment";
import type { Notice, PageError } from "./settle";

export const SUBSCRIBE_URL = "https://nedshed.dev/subscribe";
const SELF_HOST_URL = "https://dormouse.sh/self-host/";

const ROW_CLASS = `flex min-h-14 items-center justify-between gap-4 py-1.5 ${DASHED_ROW_CLASS}`;
const DETAIL_CLASS = `block text-sm ${MUTED_TEXT_CLASS}`;
const FOOTNOTE_CLASS = `mt-10 text-sm ${MUTED_TEXT_CLASS}`;
const shortId = (burrowId: string) => burrowId.slice(0, 8);
/** The name a computer enrolled under, or its short id before it sent one. */
function computerName(burrowId: string, computers: Computer[] | null): string {
  return computers?.find((computer) => computer.burrowId === burrowId)?.label ?? `Computer ${shortId(burrowId)}`;
}
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

/** Which page of the account app, past enrollment, this is. */
export type View = "account" | "checkout" | "billing";

/** App's existing values and callbacks; the controller owns their lifecycle. */
export interface HostedPageProps {
  view?: View;
  /** The account's plan, `closed` until checkout opens, null when unread. */
  billing?: BillingSummary | "closed" | null;
  /** The plan a checkout link named. */
  checkoutPlan?: Plan | null;
  /** Back from Stripe with a checkout this page just confirmed. */
  confirmed?: boolean;
  purchase?: (plan: Plan, price: number) => void;
  manageBilling?: () => void;
  saveFounder?: (shown: boolean, name: string) => void;
  /** Leaves checkout or billing for the account page. */
  leaveBilling?: () => void;
  /** Withdraws from the contract a subscription names. */
  withdraw?: (subscription: string) => void;
  closeAccount?: () => Promise<void>;
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

const idle = () => {};

export function HostedPage({
  view = "account", billing = null, checkoutPlan = null, confirmed = false,
  purchase = idle, manageBilling = idle, saveFounder = idle, leaveBilling = idle, withdraw = idle,
  closeAccount = async () => {},
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
  const summary = billing !== null && billing !== "closed" ? billing : null;
  const founders = summary && (
    <FoundersOptIn billing={summary} defaultName={session?.user.name ?? ""} busy={busy} onSave={saveFounder} />
  );
  const backToAccount = (
    <button type="button" className={`mt-6 flex ${TEXT_BUTTON_CLASS}`} disabled={!!busy} onClick={leaveBilling}>
      Go to your account
    </button>
  );
  /** What checkout and billing say before they have a plan to show. */
  const billingUnread =
    billing === "closed" ? (
      <p className={HELP_CLASS}>Checkout is not open yet.</p>
    ) : (
      <>
        <p className={HELP_CLASS}>Billing could not load. Retry, or come back to this page later.</p>
        <button className={BUTTON_CLASS} disabled={!!busy} onClick={() => void act("retry", refresh)}>
          Retry
        </button>
      </>
    );

  return (
    <HostedShell themeControl={themeControl}>
        <h1 className={`mb-3 text-balance leading-tight ${PAGE_TITLE_CLASS}`}>
          {comingSoon
            ? "Coming soon"
            : enrolling
            ? enrolling.purpose === "voice"
              ? "Turn on Natural Voice"
              : "Enroll remote control"
            : view === "checkout"
              ? session
                ? "Subscribe to Dormouse Hosted"
                : "Sign in to subscribe"
            : view === "billing" && session
              ? confirmed && summary?.plan
                ? "You’re subscribed"
                : "Billing"
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
            : view === "checkout"
              ? session
                ? "Natural Voice and the Hosted Relay on every computer you sign in on."
                : "Sign in or create your account first. Your plan stays chosen."
            : view === "billing"
              ? session
                ? confirmed && summary?.plan
                  ? "Thank you. This page keeps the details of your plan; come back to it any time from your account."
                  : "Your Hosted plan."
                : "Sign in to see your plan."
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
                      <NoPlanOffer purpose={enrolling.purpose} checkoutOpen={!!summary} />
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
            ) : session && view === "checkout" ? (
              <section aria-label="Checkout">
                {!summary ? (
                  billingUnread
                ) : summary.plan ? (
                  <>
                    <p className={HELP_CLASS}>This account already has {PLAN_NAMES[summary.plan]}.</p>
                    <button className={BUTTON_CLASS} disabled={!!busy} onClick={manageBilling}>
                      {busy === "portal" ? "Opening…" : "Manage billing"}
                    </button>
                  </>
                ) : (
                  // A new founding step asks for agreement again, both boxes unticked.
                  <Checkout key={summary.founding?.cohort ?? "closed"} billing={summary} plan={checkoutPlan} busy={busy} onPurchase={purchase} />
                )}
                {backToAccount}
              </section>
            ) : session && view === "billing" ? (
              <section aria-label="Billing">
                {summary?.withdrawn && <WithdrawalAcknowledgement withdrawn={summary.withdrawn} />}
                {!summary ? (
                  billingUnread
                ) : summary.plan ? (
                  <>
                    <PlanConfirmation billing={{ ...summary, plan: summary.plan }} busy={busy} onManage={manageBilling} />
                    {summary.withdrawal && (
                      <WithdrawalFunction offer={summary.withdrawal} plan={summary.plan} busy={busy} onWithdraw={withdraw} />
                    )}
                  </>
                ) : (
                  <>
                    <p className={HELP_CLASS}>This account has no plan.</p>
                    <a className={BUTTON_CLASS} href="/checkout">Choose a plan</a>
                  </>
                )}
                {founders}
                {backToAccount}
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
                {summary && (
                  <section aria-labelledby="plan" className={SECTION_CLASS}>
                    <PlanSection billing={summary} busy={busy} onManage={manageBilling}>
                      {founders}
                    </PlanSection>
                  </section>
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
                        <span className="min-w-0 wrap-anywhere">
                          {computer.label ?? "Computer"}
                          <span className={DOOR_CLASS}>{shortId(computer.burrowId)}</span>
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
                              ? ` from ${computerName(passkey.burrowId, computers)}`
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
                <section aria-labelledby="close" className={SECTION_CLASS}>
                  <CloseAccount billing={billing} fresh={!!fresh} busy={busy} onClose={closeAccount} />
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
                {!enrolling && view !== "checkout" && (
                  <p className={FOOTNOTE_CLASS}>
                    Natural Voice and remote control are not available yet.
                  </p>
                )}
              </>
            )}
          </>
        )}
    </HostedShell>
  );
}
