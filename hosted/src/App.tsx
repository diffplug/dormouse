import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  getAccounts,
  getProviders,
  getSession,
  post,
  providerNames,
  social,
  type Account,
  type Provider,
  type Session,
} from "./api";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [enabled, setEnabled] = useState<Provider[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
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
    const linked = current ? await getAccounts() : [];
    if (generation !== refreshGeneration.current) return;
    setSession(current);
    setEnabled(providers);
    setAccounts(linked);
    history.replaceState(null, "", current ? "/account" : "/login");
  }, []);
  useEffect(() => {
    history.replaceState(null, "", location.pathname);
    void refresh()
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
      setEnterCode(false);
      setCode("");
      await refresh();
      setNotice(
        "Signed out of this browser. Your other devices stay signed in.",
      );
    });
  const fresh =
    session && Date.now() - Date.parse(session.session.createdAt) < 600_000;

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
        <h1>{session ? "Your account" : "Sign in to Dormouse Hosted"}</h1>
        <p className="intro">
          {session
            ? "Manage how you sign in."
            : "One account for Dormouse’s hosted services."}
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
            {session ? (
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
                        Connections require a login from the last 10 minutes.
                      </p>
                    )}
                </section>
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
                <p className="footnote">
                  Hosted voice and remote control are not available yet.
                </p>
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
                <p className="help">
                  Already have an account? Use your existing sign-in method,
                  then connect other providers from your account.
                </p>
                <p className="footnote">
                  Hosted voice and remote control are not available yet.
                </p>
              </>
            )}
          </>
        )}
      </main>
      <footer>
        <a href="https://dormouse.sh/docs/security" rel="noreferrer">
          Dormouse security ↗
        </a>
        <span>Optional services. Your terminal stays yours.</span>
      </footer>
    </div>
  );
}
