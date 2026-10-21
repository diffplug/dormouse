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
  getApproval,
  getComputers,
  getHostedVoice,
  getPasskeys,
  getProviders,
  getSession,
  post,
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
  TERMS_VERSION,
} from "../server/policy-constants";
import { useDocsThemedBody } from "../../lib/src/site/docs-paint";
import { HostedPage, SUBSCRIBE_URL } from "./HostedPage";
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
const SUBSCRIBE_REDIRECT_MS = 4000;
const SIGN_IN_PARAMS = new URLSearchParams(location.search);
const SIGN_IN_OPEN = SIGN_IN_PARAMS.has("signin") || SIGN_IN_PARAMS.has("error");

// How long the page re-reads for a Pending before saying it has not shown;
// after that the focus refresh picks it up.
const PENDING_TIMEOUT_MS = 60_000;

export function App({ enrollment }: { enrollment: Enrollment | null }) {
  // The reader's picked theme, as on the docs pages this continues.
  useDocsThemedBody();
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
  const actionPending = useRef(false);
  const refreshGeneration = useRef(0);
  // Bumped by every action and on unmount: stops re-reading for a Pending.
  const actionGeneration = useRef(0);
  // The Pending the page waits on, from its first re-read until a read ends
  // it or an action: each read asks what a poll made of it. Once its
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
    const [linked, voice, enrolled, registered, approval] = current
      ? await Promise.all([
          asRead(getAccounts()).catch(failed),
          getHostedVoice().catch(() => null),
          getComputers().catch(() => null),
          getPasskeys().catch(() => null),
          watched === undefined
            ? undefined
            : getApproval(watched).catch(() => undefined),
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
    const state: AccountState = { voice, computers: enrolled, approval };
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
      // Natural Voice nor the computer shows on the account, nor the
      // approval's own read says so.
      const shows = approvalShows(voice ? "voice" : "remote", {
        voice: hostedVoice,
        computers,
      });
      await approveEnrollment(code, enrolling?.purpose, confirmDigits);
      clearEnrollment();
      const later =
        "Keep Dormouse open on your computer; this page updates when you come back to it.";
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
  const fresh =
    session &&
    Date.now() - Date.parse(session.session.createdAt) < LOGIN_FRESH_AGE_MS;

  const changeEmail = () => {
    setEnterCode(false);
    setCode("");
    setNotice(null);
    setError(keepRead);
  };

  return <HostedPage
    session={session} enabled={enabled} accounts={accounts} hostedVoice={hostedVoice}
    turnOffDialog={turnOffDialog} computers={computers} passkeys={passkeys}
    enrolling={enrolling} loading={loading} busy={busy} error={error} notice={notice}
    email={email} code={code} enterCode={enterCode}
    comingSoon={comingSoon} fresh={fresh} themeControl act={act} refresh={refresh} approve={approve}
    signOut={signOut} clearEnrollment={clearEnrollment} turnOffVoice={turnOffVoice}
    removeOne={removeOne} removeKey={removeKey} submit={submit} setEmail={setEmail}
    setCode={setCode} setEnterCode={setEnterCode} changeEmail={changeEmail}
    sendCode={sendCode} noteContinued={noteContinued} social={social}
  />;
}
