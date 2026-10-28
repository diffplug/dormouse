// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://hosted.example.test/login?signin"}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as api from "./api";
import type { Enrollment } from "./enrollment";
import type { BillingSummary, CheckoutIntent } from "./billing";
import { ENROLLMENT_POLL_INTERVAL_S, PRICE_CHANGED, TERMS_VERSION } from "../server/policy-constants";
import { NOT_ENTITLED_ERROR } from "../../remote-lib-common/src/remote/wire.ts";

vi.mock("./api", async (original) => ({
  ...await original<typeof import("./api")>(),
  getSession: vi.fn(), getProviders: vi.fn(), getAccounts: vi.fn(),
  getHostedVoice: vi.fn(), getComputers: vi.fn(), getPasskeys: vi.fn(),
  getApproval: vi.fn(), approveEnrollment: vi.fn(), acceptTerms: vi.fn(),
  post: vi.fn(), turnOffHostedVoice: vi.fn(),
  getBilling: vi.fn(), startCheckout: vi.fn(), confirmCheckout: vi.fn(),
  openPortal: vi.fn(), setFounder: vi.fn(),
}));

const NOW = Date.UTC(2026, 9, 21, 12);
const ENROLLMENT: Enrollment = { code: "7KQM-X4TD", purpose: "remote" };
const login = (age = 0): api.Session => ({
  user: { id: "account-one", email: "member@example.com", name: "Member" },
  session: {
    createdAt: new Date(NOW - age).toISOString(),
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
  },
});
let root: Root;
let container: HTMLDivElement;

// jsdom has no modal dialog methods; Vitest isolates this file's prototype.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  history.replaceState(null, "", "/login?signin");
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(api.getSession).mockResolvedValue(null);
  vi.mocked(api.getProviders).mockResolvedValue(["github"]);
  vi.mocked(api.getAccounts).mockResolvedValue([]);
  vi.mocked(api.getHostedVoice).mockResolvedValue({ entitled: true, on: false });
  vi.mocked(api.getComputers).mockResolvedValue([]);
  vi.mocked(api.getPasskeys).mockResolvedValue([]);
  vi.mocked(api.getApproval).mockResolvedValue({ mismatched: false, redeemed: false });
  vi.mocked(api.acceptTerms).mockResolvedValue(true);
  vi.mocked(api.post).mockResolvedValue({});
  vi.mocked(api.getBilling).mockResolvedValue("closed");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function mount(enrollment: Enrollment | null, start: { checkout?: CheckoutIntent; confirming?: string } = {}) {
  await act(async () => root.render(<App enrollment={enrollment} {...start} />));
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
  expect(found, `button: ${text}`).toBeDefined();
  return found!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function input(id: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`#${id}`)!;
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector("form")!.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  ));
}
async function signIn() {
  await input("email", "member@example.com");
  await submit();
  expect(api.post).toHaveBeenCalledWith("email-otp/send-verification-otp", {
    email: "member@example.com", type: "sign-in",
  });
  expect(document.activeElement).toBe(container.querySelector("#code"));
  await input("code", "12345678");
  vi.mocked(api.getSession).mockResolvedValue(login());
  await submit();
  expect(api.post).toHaveBeenCalledWith("sign-in/email-otp", {
    email: "member@example.com", otp: "12345678",
  });
  expect(api.acceptTerms).toHaveBeenCalledWith(TERMS_VERSION);
}
async function tick(id: string) {
  await act(async () => container.querySelector<HTMLInputElement>(`#${id}`)!.click());
}
async function approve() {
  await input("confirm-digits", "47");
  await submit();
}

it("email sign-in retains the enrollment and submits its code and purpose", async () => {
  await mount(ENROLLMENT);
  await signIn();
  expect(location.pathname).toBe("/enroll");
  expect(container.querySelector("h1")?.textContent).toBe("Enroll remote control");
  await approve();
  expect(api.approveEnrollment).toHaveBeenCalledWith("7KQM-X4TD", "remote", "47");
  expect(sessionStorage.length).toBe(0);
});

it.each(["remote", "voice"] as const)("stale-login reauthentication retains the %s purpose", async (purpose) => {
  vi.mocked(api.getSession).mockResolvedValue(login(11 * 60_000));
  await mount({ ...ENROLLMENT, purpose });
  expect(container.querySelector("#confirm-digits")).toBeNull();
  vi.mocked(api.getSession).mockResolvedValue(null);
  await click("Sign in again");
  expect(api.post).toHaveBeenCalledWith("sign-out");
  expect(location.pathname).toBe("/enroll");
  await signIn();
  expect(container.querySelector("h1")?.textContent).toBe(
    purpose === "voice" ? "Turn on Natural Voice" : "Enroll remote control",
  );
  await approve();
  expect(api.approveEnrollment).toHaveBeenCalledWith("7KQM-X4TD", purpose, "47");
});

it.each(["remote", "voice"] as const)("%s approval returns to the account and waits for desktop completion", async (purpose) => {
  vi.mocked(api.getSession).mockResolvedValue(login());
  await mount({ ...ENROLLMENT, purpose });
  await approve();
  expect(location.pathname).toBe("/account");
  expect(container.querySelector("h1")?.textContent).toBe("Your account");
  expect(container.querySelector("[role=status]")?.textContent).toContain("Waiting for Dormouse");
  if (purpose === "voice") {
    vi.mocked(api.getHostedVoice).mockResolvedValue({ entitled: true, on: true });
  } else {
    vi.mocked(api.getComputers).mockResolvedValue([{ burrowId: "new-computer", label: null, enrolledAt: new Date(NOW).toISOString() }]);
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(ENROLLMENT_POLL_INTERVAL_S * 1000); });
  expect(container.querySelector("[role=status]")?.textContent).toBe(
    purpose === "voice" ? "Natural Voice is on." : "Your computer is enrolled.",
  );
  expect(api.getApproval).toHaveBeenCalledWith("7KQM-X4TD");
});

it("lists each computer by the name it enrolled under, else its short id, and each passkey's computer the same way", async () => {
  vi.mocked(api.getSession).mockResolvedValue(login());
  const enrolledAt = new Date(NOW).toISOString();
  vi.mocked(api.getComputers).mockResolvedValue([
    { burrowId: "named-computer-id", label: "studio (Dormouse)", enrolledAt },
    { burrowId: "older-computer-id", label: null, enrolledAt },
  ]);
  vi.mocked(api.getPasskeys).mockResolvedValue([
    { credentialId: "one", label: "iPhone", createdAt: enrolledAt, burrowId: "named-computer-id" },
    { credentialId: "two", label: "iPad", createdAt: enrolledAt, burrowId: "older-computer-id" },
  ]);
  await mount(null);
  const rows = (section: string) =>
    [...container.querySelectorAll(`section[aria-labelledby=${section}] > div`)].map((row) => row.querySelector("span")?.textContent);
  expect(rows("computers")).toEqual([
    expect.stringMatching(/^studio \(Dormouse\)named-co/),
    expect.stringMatching(/^Computerolder-co/),
  ]);
  expect(rows("passkeys")).toEqual([
    expect.stringMatching(/from studio \(Dormouse\)$/),
    expect.stringMatching(/from Computer older-co$/),
  ]);
});

it("an approval that completes after a newer link opened keeps the newer code", async () => {
  vi.mocked(api.getSession).mockResolvedValue(login());
  let resolve!: () => void;
  vi.mocked(api.approveEnrollment).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
  await mount(ENROLLMENT);
  await approve();
  await act(async () => {
    history.replaceState(null, "", "/enroll#9PRW-H3NC");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await act(async () => resolve());
  expect(location.pathname).toBe("/enroll");
  expect(container.querySelector("h1")?.textContent).toBe("Enroll remote control");
  expect(container.querySelector("[role=status]")?.textContent).toContain("Approved 7KQM-X4TD");
  vi.mocked(api.approveEnrollment).mockResolvedValue();
  await approve();
  expect(api.approveEnrollment).toHaveBeenLastCalledWith("9PRW-H3NC", undefined, "47");
});

describe("Natural Voice confirmation", () => {
  beforeEach(() => {
    vi.mocked(api.getSession).mockResolvedValue(login());
    vi.mocked(api.getHostedVoice).mockResolvedValue({ entitled: true, on: true });
  });
  it("cancels without changing the account", async () => {
    await mount(null);
    await click("Turn off Natural Voice");
    expect(container.querySelector("dialog")!.open).toBe(true);
    await click("Cancel");
    expect(container.querySelector("dialog")!.open).toBe(false);
    expect(api.turnOffHostedVoice).not.toHaveBeenCalled();
  });
  it("closes after completion and displays the refreshed state", async () => {
    await mount(null);
    await click("Turn off Natural Voice");
    vi.mocked(api.getHostedVoice).mockResolvedValue({ entitled: true, on: false });
    await click("Turn off");
    expect(api.turnOffHostedVoice).toHaveBeenCalledOnce();
    expect(container.querySelector("dialog")!.open).toBe(false);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Natural Voice is off. Your computers use the system voice.");
    expect(container.textContent).toContain("To turn on Natural Voice");
  });
  it("closes after failure and leaves the error and retry on the account", async () => {
    vi.mocked(api.turnOffHostedVoice).mockRejectedValue(new Error("Voice service unavailable."));
    await mount(null);
    await click("Turn off Natural Voice");
    await click("Turn off");
    expect(container.querySelector("dialog")!.open).toBe(false);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Voice service unavailable.");
    expect(button("Turn off Natural Voice").disabled).toBe(false);
    expect(button("Retry connection").disabled).toBe(false);
  });
});

describe("an account with no plan", () => {
  const noPlanShown = () => container.textContent!.includes("has no Hosted plan yet");
  beforeEach(() => {
    vi.mocked(api.getSession).mockResolvedValue(login());
  });

  it.each(["remote", "voice"] as const)("is told before typing digits for %s", async (purpose) => {
    vi.mocked(api.getHostedVoice).mockResolvedValue({ entitled: false, on: false });
    await mount({ ...ENROLLMENT, purpose });
    expect(container.querySelector("#confirm-digits")).toBeNull();
    expect(noPlanShown()).toBe(true);
    expect(button("Don’t approve").disabled).toBe(false);
    const plans = container.querySelector<HTMLAnchorElement>('a[href="https://dormouse.sh/hosted/?ref=hosted-no-plan#pricing"]')!;
    // In another tab, so this one keeps the code that lives only in memory.
    expect(plans.target).toBe("_blank");
    // Natural Voice has no self-hosted equivalent; a Relay does.
    expect(container.querySelectorAll('a[href="https://dormouse.sh/self-host/"]').length).toBe(purpose === "remote" ? 2 : 0);
  });

  it("is told when the approval is refused for want of a plan", async () => {
    vi.mocked(api.approveEnrollment).mockRejectedValue(new api.NoPlanError(NOT_ENTITLED_ERROR));
    await mount(ENROLLMENT);
    await approve();
    expect(container.querySelector("#confirm-digits")).toBeNull();
    expect(noPlanShown()).toBe(true);
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(location.pathname).toBe("/enroll");
  });

  it("offers the digits again once a plan is bought in another tab", async () => {
    vi.mocked(api.approveEnrollment).mockRejectedValueOnce(new api.NoPlanError(NOT_ENTITLED_ERROR));
    await mount(ENROLLMENT);
    await approve();
    expect(noPlanShown()).toBe(true);
    vi.mocked(api.getHostedVoice).mockResolvedValue({ entitled: true, on: false });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(noPlanShown()).toBe(false);
    await approve();
    expect(api.approveEnrollment).toHaveBeenLastCalledWith("7KQM-X4TD", "remote", "47");
  });

  it("is never assumed from a failed read or a failed approval", async () => {
    vi.mocked(api.getHostedVoice).mockRejectedValue(new Error("Could not connect."));
    vi.mocked(api.getComputers).mockRejectedValue(new Error("Could not connect."));
    vi.mocked(api.approveEnrollment).mockRejectedValue(new Error("Could not connect."));
    await mount(ENROLLMENT);
    expect(noPlanShown()).toBe(false);
    await approve();
    expect(noPlanShown()).toBe(false);
    expect(container.querySelector("#confirm-digits")).not.toBeNull();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not connect.");
  });

  it("keeps the code through Use another account", async () => {
    vi.mocked(api.approveEnrollment).mockRejectedValueOnce(new api.NoPlanError(NOT_ENTITLED_ERROR));
    await mount(ENROLLMENT);
    await approve();
    vi.mocked(api.getSession).mockResolvedValue(null);
    await click("Use another account");
    expect(api.post).toHaveBeenCalledWith("sign-out");
    expect(location.pathname).toBe("/enroll");
    await signIn();
    await approve();
    expect(api.approveEnrollment).toHaveBeenLastCalledWith("7KQM-X4TD", "remote", "47");
    expect(location.pathname).toBe("/account");
  });
});

describe("approveEnrollment", () => {
  const actual = () => vi.importActual<typeof import("./api")>("./api");
  const answer = (status: number, message: string) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message }, { status }));
  afterEach(() => vi.restoreAllMocks());

  it("reads a 403 NOT_ENTITLED_ERROR as no plan", async () => {
    const { approveEnrollment, NoPlanError } = await actual();
    answer(403, NOT_ENTITLED_ERROR);
    await expect(approveEnrollment("7KQM-X4TD", "remote", "47")).rejects.toBeInstanceOf(NoPlanError);
  });
  it("reads any other refusal as its message", async () => {
    const { approveEnrollment, NoPlanError } = await actual();
    answer(403, "Sign in again to approve.");
    const refusal = approveEnrollment("7KQM-X4TD", "remote", "47");
    await expect(refusal).rejects.toThrow("Sign in again to approve.");
    await expect(refusal).rejects.not.toBeInstanceOf(NoPlanError);
  });
});

const NO_PLAN: BillingSummary = {
  plan: null, price: null, active: false, until: null, renews: false, entitled: false, suspended: false,
  founding: { cohort: 0, seatsLeft: 42 }, founder: { offered: false, name: null }, consent: null,
};
const FOUNDING: BillingSummary = {
  ...NO_PLAN, plan: "founding", price: 50, active: true, until: "2027-10-21T12:00:00Z", renews: true, entitled: true,
  founder: { offered: true, name: null },
  consent: { termsVersion: TERMS_VERSION, consentedAt: "2026-10-21T12:00:00Z" },
};
const text = () => container.textContent!;

describe("checkout", () => {
  const heading = () => container.querySelector("h1")?.textContent;

  it("asks a signed-out buyer to sign in, without the not-yet footnote, and keeps the plan", async () => {
    history.replaceState(null, "", "/checkout");
    vi.mocked(api.getBilling).mockResolvedValue(NO_PLAN);
    await mount(null, { checkout: { plan: "yearly", ref: "settings-voice" } });
    expect(heading()).toBe("Sign in to subscribe");
    // A reload signed out still lands on checkout.
    expect(location.pathname).toBe("/checkout");
    expect(text()).not.toContain("not available yet");
    expect(container.querySelector("#email")).not.toBeNull();
    await signIn();
    expect(location.pathname).toBe("/checkout");
    expect(heading()).toBe("Subscribe to Dormouse Hosted");
    expect(container.querySelector<HTMLInputElement>('input[value="yearly"]')!.checked).toBe(true);
  });

  it("starts only once both agreements are ticked, with the plan and the ref it arrived with", async () => {
    vi.mocked(api.getSession).mockResolvedValue(login());
    vi.mocked(api.getBilling).mockResolvedValue(NO_PLAN);
    await mount(null, { checkout: { plan: null, ref: "hosted-no-plan" } });
    // Founding first while it is open.
    expect(container.querySelector<HTMLInputElement>('input[value="founding"]')!.checked).toBe(true);
    expect(text()).toContain("42 left at this price");
    const go = () => button("Continue to payment");
    expect(go().disabled).toBe(true);
    await tick("agree-terms");
    expect(go().disabled).toBe(true);
    await tick("agree-renewal");
    expect(go().disabled).toBe(false);
    // Renewal was agreed at founding's price: another plan asks again.
    await tick("monthly-plan");
    expect(container.querySelector<HTMLInputElement>("#agree-renewal")!.checked).toBe(false);
    expect(text()).toContain("renews automatically every month at $10");
    expect(go().disabled).toBe(true);
    await tick("agree-renewal");
    await click("Continue to payment");
    expect(api.startCheckout).toHaveBeenCalledWith("monthly", 10, "hosted-no-plan");
  });

  it("reads the new price when the cohort sold out meanwhile, and asks for agreement again", async () => {
    vi.mocked(api.getSession).mockResolvedValue(login());
    vi.mocked(api.getBilling).mockResolvedValue(NO_PLAN);
    vi.mocked(api.startCheckout).mockRejectedValueOnce(new api.PriceChangedError(PRICE_CHANGED));
    await mount(null, { checkout: { plan: "founding", ref: null } });
    await tick("agree-terms");
    await tick("agree-renewal");
    vi.mocked(api.getBilling).mockResolvedValue({ ...NO_PLAN, founding: { cohort: 1, seatsLeft: 100 } });
    await click("Continue to payment");
    expect(api.startCheckout).toHaveBeenLastCalledWith("founding", 50, null);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(PRICE_CHANGED);
    expect(text()).toContain("renews automatically every year at $60");
    for (const box of ["agree-terms", "agree-renewal"])
      expect(container.querySelector<HTMLInputElement>(`#${box}`)!.checked, box).toBe(false);
    await tick("agree-terms");
    await tick("agree-renewal");
    await click("Continue to payment");
    expect(api.startCheckout).toHaveBeenLastCalledWith("founding", 60, null);
  });

  it("says when checkout is not open, and offers a held plan the portal instead", async () => {
    vi.mocked(api.getSession).mockResolvedValue(login());
    await mount(null, { checkout: { plan: "founding", ref: null } });
    expect(text()).toContain("Checkout is not open yet.");
    expect(container.querySelector("#agree-terms")).toBeNull();
    vi.mocked(api.getBilling).mockResolvedValue(FOUNDING);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(text()).toContain("This account already has Founding.");
    await click("Manage billing");
    expect(api.openPortal).toHaveBeenCalled();
    await click("Go to your account");
    expect(location.pathname).toBe("/account");
    expect(heading()).toBe("Your account");
  });
});

describe("billing", () => {
  it("confirms the checkout Stripe returned from once, then keeps its confirmation", async () => {
    history.replaceState(null, "", "/billing");
    vi.mocked(api.getSession).mockResolvedValue(login());
    vi.mocked(api.confirmCheckout).mockResolvedValue(FOUNDING);
    await mount(null, { confirming: "op_1" });
    expect(api.confirmCheckout).toHaveBeenCalledWith("op_1");
    expect(api.getBilling).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/billing");
    expect(container.querySelector("h1")?.textContent).toBe("You’re subscribed");
    expect(text()).toContain(`To the Terms (version ${TERMS_VERSION}) and to automatic renewal`);
    expect(text()).toContain("at $50 plus any applicable tax");
    vi.mocked(api.getBilling).mockResolvedValue(FOUNDING);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(api.confirmCheckout).toHaveBeenCalledTimes(1);
  });

  it("offers a founder the row unticked, and saves the name they choose", async () => {
    history.replaceState(null, "", "/billing");
    vi.mocked(api.getSession).mockResolvedValue(login());
    vi.mocked(api.getBilling).mockResolvedValue(FOUNDING);
    vi.mocked(api.setFounder).mockResolvedValue({ ...FOUNDING, founder: { offered: true, name: "Ada" } });
    await mount(null);
    expect(container.querySelector<HTMLInputElement>("#founder-shown")!.checked).toBe(false);
    expect(container.querySelector("#founder-name")).toBeNull();
    await tick("founder-shown");
    expect(container.querySelector<HTMLInputElement>("#founder-name")!.value).toBe("Member");
    await input("founder-name", "  ");
    expect(button("Save").disabled).toBe(true);
    await input("founder-name", " Ada ");
    await click("Save");
    expect(api.setFounder).toHaveBeenCalledWith(true, "Ada");
    expect(text()).toContain("You are in the founders row as Ada.");
  });
});

describe("the plan section", () => {
  beforeEach(() => {
    vi.mocked(api.getSession).mockResolvedValue(login());
  });

  it("is absent while checkout is closed", async () => {
    await mount(null);
    expect(container.querySelector("#plan")).toBeNull();
  });

  it.each([
    [false, "so Natural Voice and the Hosted Relay are paused"],
    [true, "Hosted stays included with this account (admin)"],
  ])("keeps Manage billing for a payment that failed, entitled %s", async (entitled, copy) => {
    vi.mocked(api.getBilling).mockResolvedValue({ ...FOUNDING, active: false, entitled, founder: { offered: false, name: null } });
    await mount(null);
    expect(container.querySelector("#plan")).not.toBeNull();
    expect(text()).toContain(copy);
    await click("Manage billing");
    expect(api.openPortal).toHaveBeenCalled();
  });

  it("lets a lapsed founder leave the row", async () => {
    vi.mocked(api.getBilling).mockResolvedValue({ ...NO_PLAN, founder: { offered: false, name: "Ada" } });
    vi.mocked(api.setFounder).mockResolvedValue(NO_PLAN);
    await mount(null);
    expect(container.querySelector('a[href="/checkout"]')).not.toBeNull();
    await click("Leave the founders row");
    expect(api.setFounder).toHaveBeenCalledWith(false, "");
  });

  it("sends an account with no plan, enrolling, to checkout in another tab once it is open", async () => {
    vi.mocked(api.getHostedVoice).mockResolvedValue({ entitled: false, on: false });
    vi.mocked(api.getBilling).mockResolvedValue(NO_PLAN);
    await mount(ENROLLMENT);
    const plans = container.querySelector<HTMLAnchorElement>('a[href="/checkout?ref=hosted-no-plan"]')!;
    expect(plans.target).toBe("_blank");
  });
});

describe("startCheckout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads a 409 PRICE_CHANGED as a price change, and any other 409 as its message", async () => {
    const { startCheckout, PriceChangedError } = await vi.importActual<typeof import("./api")>("./api");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: PRICE_CHANGED }, { status: 409 }));
    await expect(startCheckout("founding", 50, null)).rejects.toBeInstanceOf(PriceChangedError);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: "Founding is closed." }, { status: 409 }));
    const closed = startCheckout("founding", 50, null);
    await expect(closed).rejects.toThrow("Founding is closed.");
    await expect(closed).rejects.not.toBeInstanceOf(PriceChangedError);
  });

  it("agrees to the current terms and to renewal, and leaves only for an https page", async () => {
    const { startCheckout } = await vi.importActual<typeof import("./api")>("./api");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ url: "javascript:alert(1)" }));
    await expect(startCheckout("yearly", 100, "settings-voice")).rejects.toThrow("Billing is temporarily unavailable");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      plan: "yearly", ref: "settings-voice", terms: TERMS_VERSION, autoRenew: true, price: 100,
    });
  });
});
