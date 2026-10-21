// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://hosted.example.test/login?signin"}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as api from "./api";
import type { Enrollment } from "./enrollment";
import { ENROLLMENT_POLL_INTERVAL_S, TERMS_VERSION } from "../server/policy-constants";

vi.mock("./api", async (original) => ({
  ...await original<typeof import("./api")>(),
  getSession: vi.fn(), getProviders: vi.fn(), getAccounts: vi.fn(),
  getHostedVoice: vi.fn(), getComputers: vi.fn(), getPasskeys: vi.fn(),
  getApproval: vi.fn(), approveEnrollment: vi.fn(), acceptTerms: vi.fn(),
  post: vi.fn(), turnOffHostedVoice: vi.fn(),
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

async function mount(enrollment: Enrollment | null) {
  await act(async () => root.render(<App enrollment={enrollment} />));
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
    vi.mocked(api.getComputers).mockResolvedValue([{ burrowId: "new-computer", enrolledAt: new Date(NOW).toISOString() }]);
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(ENROLLMENT_POLL_INTERVAL_S * 1000); });
  expect(container.querySelector("[role=status]")?.textContent).toBe(
    purpose === "voice" ? "Natural Voice is on." : "Your computer is enrolled.",
  );
  expect(api.getApproval).toHaveBeenCalledWith("7KQM-X4TD");
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
