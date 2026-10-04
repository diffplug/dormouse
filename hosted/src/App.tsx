import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  approveEnrollment,
  confirmCheckout,
  createVoiceToken,
  getBilling,
  getAccounts,
  getComputers,
  getProviders,
  getSession,
  getVoiceTokens,
  NoPlanError,
  openPortal,
  post,
  providerNames,
  removeComputer,
  revokeVoiceToken,
  sendSurvey,
  setFounder,
  social,
  startCheckout,
  type Account,
  type BillingSummary,
  type Computer,
  type Plan,
  type Provider,
  type Session,
  type VoiceToken,
} from "./api";
import {
  BILLING_RETURN_PATH,
  LOGIN_FRESH_AGE_MS,
  RECENT_LOGIN_WINDOW,
} from "../server/policy-constants";
import {
  ADD_A_COMPUTER,
  approvedNotice,
  takeEnrollment,
  type Enrollment,
} from "./enrollment";
import { computerName } from "../../remote-lib-common/src/remote/enrolled-computers.ts";
import {
  CheckoutView,
  PLAN_NAMES,
  PLANS_PAGE,
  PlanSection,
  WelcomeView,
} from "./Billing";
import { forgetCheckout, type CheckoutRef } from "./checkout";

type Page = "enroll" | "checkout" | "welcome" | "account" | "login";
const PATHS: Record<Page, string> = {
  enroll: "/enroll",
  checkout: "/checkout",
  welcome: BILLING_RETURN_PATH,
  account: "/account",
  login: "/login",
};
const TITLES: Record<Page, string> = {
  enroll: "Approve a computer",
  checkout: "Subscribe to Dormouse Hosted",
  welcome: "Welcome to Dormouse Hosted",
  account: "Your account",
  login: "Sign in to Dormouse Hosted",
};
const INTROS: Record<"welcome" | "account" | "login", string> = {
  welcome: "Your subscription is active.",
  account: "Manage your plan and how you sign in.",
  login: "One account for Dormouse’s hosted services.",
};

export function App({
  enrollment,
  checkout,
  checkoutRef,
  returned,
}: {
  enrollment: Enrollment | null;
  /** A pending `/checkout` (null for a link naming no plan), undefined for none. */
  checkout: Plan | null | undefined;
  /** The allowlisted ref that checkout's link carried (docs/specs/hosted.md -> "Metrics"). */
  checkoutRef?: CheckoutRef;
  /** The checkout operation Stripe returned to `/billing` with. */
  returned: string | null;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [enabled, setEnabled] = useState<Provider[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Null hides the Voice tokens section.
  const [voiceTokens, setVoiceTokens] = useState<VoiceToken[] | null>(null);
  // Null hides the Computers section, as for voice tokens.
  const [computers, setComputers] = useState<Computer[] | null>(null);
  // The enrollment awaiting approval, in memory only: through sign-in and
  // back, never into storage (docs/specs/hosted.md -> "Burrow enrollment").
  const [enrolling, setEnrolling] = useState(enrollment);
  // Null while this deployment does not sell, or before sign-in.
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [buying, setBuying] = useState(checkout);
  // Set once Stripe's return is confirmed: the welcome page shows.
  const [welcome, setWelcome] = useState(false);
  const [minted, setMinted] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [enterCode, setEnterCode] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const actionPending = useRef(false);
  const refreshGeneration = useRef(0);
  const callbackError = useRef(
    new URLSearchParams(location.search).has("error"),
  );

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const [current, providers] = await Promise.all([
      getSession(),
      getProviders(),
    ]);
    // A failed list hides its section, never the account page.
    const [linked, tokens, enrolled, plan] = current
      ? await Promise.all([
          getAccounts(),
          getVoiceTokens().catch(() => null),
          getComputers().catch(() => null),
          getBilling().catch(() => null),
        ])
      : [[], null, null, null];
    if (generation !== refreshGeneration.current) return;
    setSession(current);
    setEnabled(providers);
    setAccounts(linked);
    setVoiceTokens(tokens);
    setComputers(enrolled);
    setBilling(plan);
  }, []);
  useEffect(() => {
    // An auth callback's query parameters (`?error=`) never stay in history.
    history.replaceState(null, "", location.pathname);
    void refresh()
      .then(async () => {
        // Stripe's return: confirm the checkout it names, then welcome.
        if (returned)
          await act("confirm", async () => {
            const summary = await confirmCheckout(returned);
            setBilling(summary);
            // An open, expired, or still-processing checkout bought nothing yet.
            if (summary.plan) setWelcome(true);
            else setNotice("That checkout is not complete. Nothing was charged.");
          });
      })
      .catch((error) => setError(error.message))
      .finally(() => {
        setLoading(false);
        if (callbackError.current)
          setError(
            "Sign-in or connection was not completed. Try again, or sign in with your existing method and connect the provider from your account.",
          );
      });
    const focus = () => {
      if (!actionPending.current)
        void refresh().catch((error) => setError(error.message));
    };
    window.addEventListener("focus", focus);
    return () => {
      ++refreshGeneration.current;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  useEffect(() => {
    if (enterCode) codeInput.current?.focus();
  }, [enterCode]);
  useEffect(() => {
    // A link opened in the tab already on `/enroll` changes only the fragment:
    // take its code as the first load did, without reloading. Elsewhere a
    // fragment means nothing.
    const takeLink = () => {
      const next = takeEnrollment();
      if (!next) return;
      setEnrolling(next);
      setError("");
      setNotice("");
    };
    window.addEventListener("hashchange", takeLink);
    return () => window.removeEventListener("hashchange", takeLink);
  }, []);

  async function act(label: string, action: () => Promise<void>) {
    if (actionPending.current) return;
    ++refreshGeneration.current;
    actionPending.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      actionPending.current = false;
      setBusy("");
    }
  }
  const sendCode = () =>
    act("email", async () => {
      await post("email-otp/send-verification-otp", {
        email: email.trim(),
        type: "sign-in",
      });
      setEnterCode(true);
      setCode("");
      setNotice("Code sent. Check your inbox. It expires in 10 minutes.");
    });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!enterCode) {
      void sendCode();
      return;
    }
    void act("verify", async () => {
      await post("sign-in/email-otp", { email: email.trim(), otp: code });
      setCode("");
      setEnterCode(false);
      await refresh();
    });
  }
  const signOut = () =>
    act("logout", async () => {
      await post("sign-out");
      setSession(null);
      setAccounts([]);
      setComputers(null);
      // The code stays on the page; a no-plan refusal was this account's.
      setEnrolling((shown) => shown && { code: shown.code });
      setMinted("");
      setEnterCode(false);
      setCode("");
      await refresh();
      setNotice(
        "Signed out of this browser. Your other devices stay signed in.",
      );
    });
  const mintToken = () =>
    act("mint", async () => {
      const { token, id, createdAt } = await createVoiceToken();
      setMinted(token);
      setVoiceTokens((tokens) => [
        { id, createdAt, lastUsedAt: null, revokedAt: null },
        ...(tokens ?? []),
      ]);
    });
  const revokeToken = (id: string) =>
    act(`revoke-${id}`, async () => {
      await revokeVoiceToken(id);
      const revokedAt = new Date().toISOString();
      setVoiceTokens(
        (tokens) =>
          tokens?.map((token) =>
            token.id === id ? { ...token, revokedAt } : token,
          ) ?? null,
      );
    });
  const approve = (code: string) =>
    act("approve", async () => {
      // The count before this approval: a full account keeps it until one is removed.
      const enrolled = computers?.length ?? null;
      try {
        await approveEnrollment(code);
      } catch (error) {
        if (!(error instanceof NoPlanError)) throw error;
        // Where the billing summary could not say so first.
        setEnrolling((shown) => shown && { ...shown, noPlan: true });
        return;
      }
      clearEnrollment();
      await refresh();
      setNotice(approvedNotice(code, enrolled));
    });
  const clearEnrollment = () => {
    setEnrolling(null);
    setError("");
  };
  const removeOne = (burrowId: string) =>
    act(`remove-${burrowId}`, async () => {
      await removeComputer(burrowId);
      setComputers(
        (enrolled) =>
          enrolled?.filter((computer) => computer.burrowId !== burrowId) ??
          null,
      );
    });
  const buy = async (plan: Plan) => {
    const url = await startCheckout(plan, checkoutRef);
    forgetCheckout();
    location.assign(url);
  };
  const portal = async () => location.assign(await openPortal());
  const founder = async (name: string | null) => {
    await setFounder(name);
    setBilling((summary) => summary && { ...summary, founder: name });
    setNotice(name === null ? "You are no longer shown in the founders row." : `Shown in the founders row as ${name}.`);
  };
  const declineCheckout = () => {
    forgetCheckout();
    setBuying(undefined);
    setError("");
  };
  const copyMinted = () =>
    act("copy", async () => {
      await navigator.clipboard.writeText(minted);
      setNotice("Token copied.");
    });
  // The one page this state shows, and the address it keeps.
  const page: Page = enrolling
    ? "enroll"
    : buying !== undefined
      ? "checkout"
      : !session
        ? "login"
        : welcome && billing
          ? "welcome"
          : "account";
  useEffect(() => {
    if (loading) return;
    const path =
      page === "checkout"
        ? `/checkout${buying ? `?plan=${buying}` : ""}`
        : PATHS[page];
    history.replaceState(null, "", path);
  }, [loading, page, buying]);
  const fresh =
    session &&
    Date.now() - Date.parse(session.session.createdAt) < LOGIN_FRESH_AGE_MS;
  const noPlan = enrolling?.noPlan || billing?.entitled === false;

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
        <h1>{TITLES[page]}</h1>
        <p className="intro">
          {page === "enroll"
            ? !enrolling!.code
              ? "This link cannot be approved."
              : session
                ? "Dormouse on your computer asked to join this account."
                : "Sign in to approve the computer that sent you here."
            : page === "checkout"
              ? session
                ? "Check the plan, then pay on Stripe."
                : `Sign in first, so your ${buying ? `${PLAN_NAMES[buying]} ` : ""}subscription belongs to your account.`
              : INTROS[page]}
        </p>
        {loading ? (
          <p role="status">Checking your account…</p>
        ) : (
          <>
            {error && (
              <div className="error" role="alert">
                <p>{error}</p>
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
              <p role="status" className="notice">
                {notice}
              </p>
            )}
            {enrolling && (session || !enrolling.code) ? (
              <section aria-label="Computer to approve" className="enroll">
                {enrolling.code ? (
                  <>
                    <p className="user-code">{enrolling.code}</p>
                    {noPlan ? (
                      <>
                        <p>
                          This account has no Hosted plan, so it cannot sign in
                          a computer.
                        </p>
                        <p className="help">
                          <a href={PLANS_PAGE}>Choose a plan</a>, then open the
                          link from Dormouse again to approve this code.
                        </p>
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => void signOut()}
                        >
                          {busy === "logout"
                            ? "Signing out…"
                            : "Use another account"}
                        </button>
                      </>
                    ) : (
                      <>
                        <p>
                          Approve only if Dormouse on your computer is showing
                          this code right now.
                        </p>
                        {fresh ? (
                          <button
                            className="primary"
                            disabled={!!busy}
                            onClick={() => void approve(enrolling.code!)}
                          >
                            {busy === "approve" ? "Approving…" : "Approve"}
                          </button>
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
            ) : page === "checkout" && session ? (
              <CheckoutView
                plan={buying ?? null}
                summary={billing}
                busy={busy}
                act={act}
                onBuy={buy}
                onPortal={portal}
                onDecline={declineCheckout}
              />
            ) : page === "welcome" ? (
              <WelcomeView
                summary={billing!}
                defaultName={session!.user.name}
                busy={busy}
                act={act}
                onFounder={founder}
                onSurvey={sendSurvey}
                onDone={() => {
                  setWelcome(false);
                  setNotice("");
                }}
              />
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
                {billing && (
                  <PlanSection
                    summary={billing}
                    defaultName={session.user.name}
                    busy={busy}
                    act={act}
                    onPortal={portal}
                    onFounder={founder}
                  />
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
                {voiceTokens && (
                  <section aria-labelledby="voice">
                    <h2 id="voice">Voice tokens</h2>
                    <p className="help">
                      Signing in from Dormouse gives that computer its own
                      token; removing the computer below revokes it.
                    </p>
                    {minted && (
                      <div className="notice minted">
                        <p>Copy this token now. You won’t see it again.</p>
                        <code>{minted}</code>
                        <button
                          className="copy"
                          disabled={!!busy}
                          onClick={() => void copyMinted()}
                        >
                          Copy token
                        </button>
                      </div>
                    )}
                    {voiceTokens.map((token) => (
                      <div className="method" key={token.id}>
                        <span>
                          Created{" "}
                          {new Date(token.createdAt).toLocaleDateString()}
                          <span className="detail">
                            {token.lastUsedAt
                              ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                              : "Never used"}
                          </span>
                        </span>
                        {token.revokedAt ? (
                          <span className="status">Revoked</span>
                        ) : (
                          <button
                            disabled={!!busy}
                            onClick={() => void revokeToken(token.id)}
                          >
                            {busy === `revoke-${token.id}`
                              ? "Revoking…"
                              : "Revoke"}
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      className="mint"
                      disabled={!!busy}
                      onClick={() => void mintToken()}
                    >
                      {busy === "mint" ? "Creating…" : "Create token"}
                    </button>
                  </section>
                )}
                {computers && (
                  <section aria-labelledby="computers">
                    <h2 id="computers">Computers</h2>
                    <p className="help">
                      Computers signed in to this account speak with managed
                      voice and reach your phones through the Hosted Relay.
                    </p>
                    {computers.length === 0 && (
                      <p className="help">No computers yet. {ADD_A_COMPUTER}</p>
                    )}
                    {computers.map((computer) => (
                      <div className="method" key={computer.burrowId}>
                        <span>
                          {computerName(computer.burrowId)}
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
                {!billing && !(voiceTokens && computers) && (
                  <p className="footnote">
                    {voiceTokens
                      ? "Remote control is"
                      : computers
                        ? "Hosted voice is"
                        : "Hosted voice and remote control are"}{" "}
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
                            setNotice("");
                            setError("");
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
                          void act(provider, () => social(provider, false))
                        }
                      >
                        {busy === provider
                          ? "Opening…"
                          : providerNames[provider]}
                      </button>
                    ))}
                  </section>
                )}
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
                {page === "login" && (
                  <p className="footnote">
                    Hosted voice and remote control are not available yet.
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
        <span>Optional services. Your terminal stays yours.</span>
      </footer>
    </div>
  );
}
