import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  acceptTerms,
  approveEnrollment,
  getAccounts,
  getApprovalMismatched,
  getComputers,
  getHostedVoice,
  getPasskeys,
  getProviders,
  getSession,
  post,
  providerNames,
  removeComputer,
  removePasskey,
  social,
  turnOffHostedVoice,
  type Account,
  type Computer,
  type HostedVoice,
  type Passkey,
  type Provider,
  type Session,
} from "./api";
import {
  ENROLLMENT_POLL_INTERVAL_S,
  LOGIN_FRESH_AGE_MS,
  RECENT_LOGIN_WINDOW,
  TERMS_VERSION,
} from "../server/policy-constants";
import { ConfirmDigits } from "./ConfirmDigits";
import { takeEnrollment, type Enrollment } from "./enrollment";
import {
  afterRead,
  approvalShows,
  asRead,
  keepRead,
  pageError,
  pendingEnd,
  preLaunchNotice,
  reread,
  settle,
  type AccountState,
  type Lookup,
  type Notice,
  type PageError,
  type Pending,
} from "./settle";

// The terms version the sign-in notice showed when this tab continued past it,
// kept through a provider's redirect until the account's acceptance is
// recorded (docs/specs/hosted.md -> "Terms acceptance").
const CONTINUED_KEY = "dormouse.terms-continued";
function noteContinued() {
  try {
    sessionStorage.setItem(CONTINUED_KEY, TERMS_VERSION);
  } catch {
    // Storage blocked: the agreement stands, only its record is lost.
  }
}
/** Records a pending acceptance; a failure leaves it for the next refresh. */
async function recordContinued() {
  let version: string | null = null;
  try {
    version = sessionStorage.getItem(CONTINUED_KEY);
  } catch {
    return;
  }
  if (!version) return;
  await acceptTerms(version);
  sessionStorage.removeItem(CONTINUED_KEY);
}

// Pre-launch: a signed-out visitor is sent to the devlog's email signup
// instead of the sign-in form; `/login?signin` still opens it, as does a
// failed provider callback's `?error`, which only a sign-in started there
// reaches, so its message shows. Delete this, and its use below, at launch.
const SUBSCRIBE_URL = "https://nedshed.dev/subscribe";
const SUBSCRIBE_REDIRECT_MS = 4000;
const SIGN_IN_PARAMS = new URLSearchParams(location.search);
const SIGN_IN_OPEN = SIGN_IN_PARAMS.has("signin") || SIGN_IN_PARAMS.has("error");

// How long the page re-reads for a Pending before saying it has not shown;
// after that the focus refresh picks it up.
const PENDING_TIMEOUT_MS = 60_000;

export function App({ enrollment }: { enrollment: Enrollment | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [enabled, setEnabled] = useState<Provider[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Null hides the Natural Voice section.
  const [hostedVoice, setHostedVoice] = useState<HostedVoice | null>(null);
  const turnOffDialog = useRef<HTMLDialogElement>(null);
  // Null hides the Computers section.
  const [computers, setComputers] = useState<Computer[] | null>(null);
  // Null hides the Passkeys section.
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  // The enrollment awaiting approval, in memory only: through sign-in and
  // back, never into storage (docs/specs/hosted.md -> "Burrow enrollment").
  const [enrolling, setEnrollingState] = useState(enrollment);
  const enrollingRef = useRef(enrolling);
  const setEnrolling = (next: Enrollment | null) => {
    enrollingRef.current = next;
    setEnrollingState(next);
  };
  const [loading, setLoading] = useState(true);
  const [lookup, setLookup] = useState<Lookup>("pending");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<PageError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [enterCode, setEnterCode] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const actionPending = useRef(false);
  const refreshGeneration = useRef(0);
  // Bumped by every action and on unmount: stops re-reading for a Pending.
  const actionGeneration = useRef(0);
  // The Pending the page waits on, from its first re-read until a read ends
  // it or an action: each read asks whether its digits mismatched. Once its
  // late notice is up (`late`), a later read that ends it replaces that.
  const awaited = useRef<{ pending: Pending; late: boolean } | null>(null);
  const callbackError = useRef(
    new URLSearchParams(location.search).has("error"),
  );

  // Undefined when a newer refresh superseded this one.
  const refresh = useCallback(async (): Promise<AccountState | undefined> => {
    const generation = ++refreshGeneration.current;
    const failed = (error: unknown): never => {
      if (generation === refreshGeneration.current) setLookup("failed");
      throw error;
    };
    const [current, providers] = await asRead(
      Promise.all([getSession(), getProviders()]),
    ).catch(failed);
    // A failed list hides its section, never the account page.
    const watched = awaited.current?.pending.userCode;
    const [linked, voice, enrolled, registered, mismatched] = current
      ? await Promise.all([
          asRead(getAccounts()).catch(failed),
          getHostedVoice().catch(() => null),
          getComputers().catch(() => null),
          getPasskeys().catch(() => null),
          watched === undefined
            ? undefined
            : getApprovalMismatched(watched).catch(() => undefined),
        ])
      : [[], null, null, null, undefined];
    if (current) await recordContinued().catch(() => {});
    if (generation !== refreshGeneration.current) return;
    setError(afterRead);
    setLookup(current ? "signed-in" : "signed-out");
    setSession(current);
    setEnabled(providers);
    setAccounts(linked);
    setHostedVoice(voice);
    setComputers(enrolled);
    setPasskeys(registered);
    history.replaceState(
      null,
      "",
      enrollingRef.current ? "/enroll" : current ? "/account" : "/login",
    );
    const state: AccountState = { voice, computers: enrolled, mismatched };
    const late = awaited.current?.late && pendingEnd(awaited.current.pending, state);
    if (late) {
      awaited.current = null;
      setNotice(late);
    }
    return state;
  }, []);
  useEffect(() => {
    // An auth callback's query parameters (`?error=`) never stay in history.
    history.replaceState(null, "", location.pathname);
    void refresh()
      .catch((error) => setError(pageError(error)))
      .finally(() => {
        setLoading(false);
        if (callbackError.current)
          setError({
            message:
              "Sign-in or connection was not completed. Try again, or sign in with your existing method and connect the provider from your account.",
            read: false,
          });
      });
    const focus = () => {
      if (!actionPending.current)
        void refresh().catch((error) => setError(pageError(error)));
    };
    // Returning to the tab: mobile Safari fires no focus coming back from
    // another app.
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      ++refreshGeneration.current;
      ++actionGeneration.current;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (enterCode) codeInput.current?.focus();
  }, [enterCode]);
  // A failed lookup keeps its error and Retry on screen rather than sending
  // a member who is signed in away during an outage, even once that error is
  // cleared (a new enrollment link, Don't approve).
  const comingSoon = preLaunchNotice(lookup, SIGN_IN_OPEN);
  useEffect(() => {
    if (!comingSoon) return;
    const timer = setTimeout(
      () => location.assign(SUBSCRIBE_URL),
      SUBSCRIBE_REDIRECT_MS,
    );
    return () => clearTimeout(timer);
  }, [comingSoon]);
  useEffect(() => {
    // A link opened in the tab already on `/enroll` changes only the fragment:
    // take its code as the first load did, without reloading. Elsewhere a
    // fragment means nothing.
    const takeLink = () => {
      const next = takeEnrollment();
      if (!next) return;
      setEnrolling(next);
      setError(keepRead);
      setNotice(null);
    };
    window.addEventListener("hashchange", takeLink);
    return () => window.removeEventListener("hashchange", takeLink);
  }, []);

  async function act(label: string, action: () => Promise<unknown>) {
    if (actionPending.current) return;
    ++refreshGeneration.current;
    ++actionGeneration.current;
    awaited.current = null;
    actionPending.current = true;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setError(pageError(error));
    } finally {
      actionPending.current = false;
      setBusy("");
    }
  }
  /**
   * Runs a mutation of the account, then shows the account as the server now
   * has it. A Pending it returns is re-read in the background, at the
   * computer's poll pace, until the account shows it. A failed refetch never
   * reports the mutation, which succeeded, as failed.
   */
  const mutate = (label: string, action: () => Promise<Pending | void>) =>
    act(label, async () => {
      const pending = await action();
      const after = await reread(refresh, () =>
        setError({
          message:
            "Your change is saved, but this page could not reload to show it. Retry, or come back to this page later.",
          read: true,
        }),
      );
      if (pending) void follow(pending, after);
    });
  async function follow(pending: Pending, after: AccountState | undefined) {
    const ended = after && pendingEnd(pending, after);
    if (ended) return setNotice(ended);
    const generation = actionGeneration.current;
    awaited.current = { pending, late: false };
    setNotice({ text: pending.waiting });
    const outcome = await settle(refresh, (state) => pendingEnd(pending, state), {
      intervalMs: ENROLLMENT_POLL_INTERVAL_S * 1000,
      timeoutMs: PENDING_TIMEOUT_MS,
      cancelled: () => generation !== actionGeneration.current,
    });
    if (outcome === "cancelled") return;
    if (outcome === "timeout") {
      awaited.current = { pending, late: true };
      return setNotice({ text: pending.late });
    }
    awaited.current = null;
    setNotice(outcome.ended);
  }
  const sendCode = () =>
    act("email", async () => {
      await post("email-otp/send-verification-otp", {
        email: email.trim(),
        type: "sign-in",
      });
      setEnterCode(true);
      setCode("");
      setNotice({ text: "Code sent. Check your inbox. It expires in 10 minutes." });
    });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!enterCode) {
      void sendCode();
      return;
    }
    void mutate("verify", async () => {
      noteContinued();
      await post("sign-in/email-otp", { email: email.trim(), otp: code });
      setCode("");
      setEnterCode(false);
    });
  }
  const signOut = () =>
    mutate("logout", async () => {
      await post("sign-out");
      setSession(null);
      setAccounts([]);
      setHostedVoice(null);
      setComputers(null);
      setPasskeys(null);
      setEnterCode(false);
      setCode("");
      setNotice({
        text: "Signed out of this browser. Your other devices stay signed in.",
      });
    });
  const turnOffVoice = () =>
    mutate("voice-off", async () => {
      try {
        await turnOffHostedVoice();
      } finally {
        // Closed either way, so a failure's error shows on the page.
        turnOffDialog.current?.close();
      }
      setNotice({
        text: "Natural Voice is off. Your computers use the system voice.",
      });
    });
  const approve = (code: string, confirmDigits: string) =>
    mutate("approve", async () => {
      const voice = enrolling?.purpose === "voice";
      // The computer's next poll redeems the approval: until then neither
      // Natural Voice nor the computer shows on the account.
      const shows = approvalShows(voice ? "voice" : "remote", {
        voice: hostedVoice,
        computers,
      });
      await approveEnrollment(code, enrolling?.purpose, confirmDigits);
      clearEnrollment();
      const later =
        "Keep Dormouse open on your computer; this page updates when you come back to it.";
      if (!shows)
        return setNotice({
          text: `Approved ${code}. Dormouse on your computer finishes the requested setup in a few seconds.`,
        });
      const mismatch = `The digits you typed for ${code} were not the ones Dormouse showed on your computer, so nothing was approved. Start again from Dormouse on your computer.`;
      return voice
        ? {
            userCode: code,
            shows,
            waiting: `Approved ${code}. Waiting for Dormouse on your computer to turn on Natural Voice…`,
            done: "Natural Voice is on.",
            late: `Approved ${code}, but Dormouse on your computer has not turned on Natural Voice yet. ${later}`,
            mismatch,
          }
        : {
            userCode: code,
            shows,
            waiting: `Approved ${code}. Waiting for Dormouse on your computer to finish enrolling…`,
            done: "Your computer is enrolled.",
            late: `Approved ${code}, but Dormouse on your computer has not finished enrolling yet. ${later}`,
            mismatch,
          };
    });
  const clearEnrollment = () => {
    setEnrolling(null);
    setError(keepRead);
    history.replaceState(null, "", session ? "/account" : "/login");
  };
  const removeOne = (burrowId: string) =>
    mutate(`remove-${burrowId}`, () => removeComputer(burrowId));
  const removeKey = (credentialId: string) =>
    mutate(`passkey-${credentialId}`, () => removePasskey(credentialId));
  // A lapsed account still sees, and may turn off, a Natural Voice left on.
  const voiceShown = !!hostedVoice && (hostedVoice.entitled || hostedVoice.on);
  const fresh =
    session &&
    Date.now() - Date.parse(session.session.createdAt) < LOGIN_FRESH_AGE_MS;

  return (
    <div className="shell">
      <header>
        <a href="/" className="brand">
          Dormouse <span>Hosted</span>
        </a>
        <a href="https://dormouse.sh" rel="noreferrer">
          About Dormouse ↗
        </a>
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
                  <dd className="account-id">{session.user.id}</dd>
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
                      <span className="status">Available</span>
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
                          <span className="status">Connected</span>
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
                          Computer {computer.burrowId.slice(0, 8)}
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
                          onClick={() => {
                            setEnterCode(false);
                            setCode("");
                            setNotice(null);
                            setError(keepRead);
                          }}
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
                        onClick={() => {
                          if (
                            document
                              .querySelector<HTMLInputElement>("#email")
                              ?.reportValidity()
                          )
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
        <a href="https://dormouse.sh/security" rel="noreferrer">
          Dormouse security ↗
        </a>
        <a href="https://dormouse.sh/privacy/" rel="noreferrer">Privacy ↗</a>
        <a href="https://dormouse.sh/terms/" rel="noreferrer">Terms ↗</a>
        <span>Optional services. Your terminals run on your own computer.</span>
      </footer>
    </div>
  );
}
