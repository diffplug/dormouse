import { providerIds, providerNames } from "../server/providers.js";
import type { ProviderId } from "../server/providers.js";
import { NOT_ENTITLED_ERROR } from "../../remote-lib-common/src/remote/wire.ts";
import { ADMIN_METRICS_PATH, type AdminMetricsBody } from "../server/metric-labels";
import { CHECKOUT_CLOSED, PRICE_CHANGED, TERMS_VERSION } from "../server/policy-constants";
import type { BillingSummary, Plan } from "./billing";

export const providers = providerIds;
export type Provider = ProviderId;
export { providerNames };
export interface Session {
  user: { id: string; email: string | null; name: string };
  session: { createdAt: string; expiresAt: string };
}
export interface Account {
  providerId: string;
}

async function request(
  path: string,
  init: RequestInit | undefined,
  unavailable: string,
  /** Let a 503 through, for a caller that reads its message. */
  pass503 = false,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new Error("Could not connect. Check your connection and try again.");
  }
  if (response.status >= 500 && !(pass503 && response.status === 503)) throw new Error(unavailable);
  return response;
}
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(
    path,
    init,
    "Sign-in is temporarily unavailable. Please try again.",
  );
  if (!response.ok) {
    if (response.status === 429)
      throw new Error("Too many attempts. Wait a minute before trying again.");
    throw new Error(
      "That did not work. Check your details and try again. If connecting a provider, sign in again first.",
    );
  }
  return response.json() as Promise<T>;
}
export const getSession = () => json<Session | null>("/api/auth/get-session");
export const getAccounts = () => json<Account[]>("/api/auth/list-accounts");
export const getProviders = async () => {
  const enabled = await json<string[]>("/api/providers");
  return providers.filter((provider) => enabled.includes(provider));
};
export async function post<T = unknown>(
  path: string,
  body: unknown = {},
): Promise<T> {
  const { csrf } = await json<{ csrf: string }>("/api/auth/csrf");
  return json<T>(`/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(body),
  });
}
export async function social(provider: Provider, linking: boolean) {
  const result = await post<{ url: string }>(
    linking ? "link-social" : "sign-in/social",
    { provider },
  );
  leaveFor(result.url, "Sign-in is temporarily unavailable. Please try again.");
}
/**
 * Sends this tab to `href`, an https page the server named (a provider's,
 * Stripe's), or in development a loopback stand-in such as StripeDev's.
 */
function leaveFor(href: string, unavailable: string) {
  const url = new URL(href);
  const loopback = import.meta.env.DEV && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error(unavailable);
  window.location.assign(url.href);
}

export interface HostedVoice {
  /** Whether this account's plan includes Natural Voice. */
  entitled: boolean;
  /** Whether any computer of this account has it on. */
  on: boolean;
}
async function voice(method: string): Promise<Response> {
  return request(
    "/api/voice",
    { method },
    "Natural Voice is temporarily unavailable. Try again.",
  );
}
/**
 * Records that this account continued past the sign-in notice naming
 * `version`. False when the server no longer accepts that version.
 */
export async function acceptTerms(version: string): Promise<boolean> {
  const response = await request(
    "/api/terms/acceptance",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    },
    "Sign-in is temporarily unavailable. Please try again.",
  );
  if (response.status === 409) return false;
  if (!response.ok) throw failed();
  return true;
}
/** A call's error when the server gave none written for this page. */
const failed = () =>
  new Error("That did not work. Reload the page and try again.");
export async function getHostedVoice(): Promise<HostedVoice> {
  const response = await voice("GET");
  if (!response.ok) throw failed();
  return (await response.json()) as HostedVoice;
}
/** Turns Natural Voice off on every computer of this account. */
export async function turnOffHostedVoice() {
  if (!(await voice("DELETE")).ok) throw failed();
}

export interface Computer {
  burrowId: string;
  /** The name it enrolled under, by default its hostname; null if it sent none. */
  label: string | null;
  enrolledAt: string;
}
async function relay(path: string, init: RequestInit = {}): Promise<Response> {
  return request(
    `/api/relay${path}`,
    init,
    "Computers and passkeys are temporarily unavailable. Try again.",
  );
}
/** The server's message for a refused request: each is written for this page. */
async function refused(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
  } | null;
  return typeof body?.message === "string" ? new Error(body.message) : failed();
}
/** Null when the server says this account may not use the Hosted Relay. */
export async function getComputers(): Promise<Computer[] | null> {
  const response = await relay("/burrows");
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw await refused(response);
  return ((await response.json()) as { burrows: Computer[] }).burrows;
}
export async function removeComputer(burrowId: string) {
  const response = await relay(`/burrows/${encodeURIComponent(burrowId)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await refused(response);
}
export interface Passkey {
  credentialId: string;
  /** Chosen by the phone that registered it. */
  label: string;
  createdAt: string;
  /** The enrolled computer whose setup code registered it, or null once removed. */
  burrowId: string | null;
}
/** Null when the server says this account may not use the Hosted Relay. */
export async function getPasskeys(): Promise<Passkey[] | null> {
  const response = await relay("/passkeys");
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw await refused(response);
  return ((await response.json()) as { passkeys: Passkey[] }).passkeys;
}
export async function removePasskey(credentialId: string) {
  const response = await relay(`/passkeys/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await refused(response);
}
/** An approval the server refused because this account has no plan. */
export class NoPlanError extends Error {}
export async function approveEnrollment(
  userCode: string,
  purpose: "remote" | "voice" | undefined,
  confirmDigits: string,
) {
  const response = await relay("/enrollments/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode, purpose: purpose ?? "remote", confirmDigits }),
  });
  if (response.ok) return;
  const error = await refused(response);
  throw response.status === 403 && error.message === NOT_ENTITLED_ERROR
    ? new NoPlanError(error.message)
    : error;
}
/** What a poll made of this account's live approval of a code; neither when there is none. */
export interface ApprovalState {
  /** Typed with other digits than its computer showed: it never redeems. */
  mismatched: boolean;
  redeemed: boolean;
}
export async function getApproval(userCode: string): Promise<ApprovalState> {
  const response = await relay(`/enrollments/${encodeURIComponent(userCode)}`);
  if (!response.ok) throw await refused(response);
  return (await response.json()) as ApprovalState;
}

/** What the admin page's read answered. */
export type AdminMetricsRead =
  | { status: "ok"; body: AdminMetricsBody }
  | { status: "signed-out" }
  /** Anyone but the admin: the route answers as if it were not there. */
  | { status: "not-found" };
export async function getAdminMetrics(): Promise<AdminMetricsRead> {
  const response = await request(ADMIN_METRICS_PATH, undefined, "Metrics are temporarily unavailable. Try again.");
  if (response.status === 401) return { status: "signed-out" };
  if (response.status === 404) return { status: "not-found" };
  if (!response.ok) throw await refused(response);
  return { status: "ok", body: (await response.json()) as AdminMetricsBody };
}

const BILLING_UNAVAILABLE = "Billing is temporarily unavailable. Try again.";
async function billing(path: string, init?: RequestInit): Promise<Response> {
  return request(`/api/billing${path}`, init, BILLING_UNAVAILABLE, true);
}
/** A billing call's error: closed, or the server's message for this page. */
async function billingRefused(response: Response): Promise<Error> {
  return response.status === 503 && !(await response.clone().json().then((body) => body?.message === CHECKOUT_CLOSED, () => false))
    ? new Error(BILLING_UNAVAILABLE)
    : refused(response);
}
const sendJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
/** This account's plan; `closed` until checkout opens. */
export async function getBilling(): Promise<BillingSummary | "closed"> {
  const response = await billing("");
  if (response.ok) return (await response.json()) as BillingSummary;
  const error = await billingRefused(response);
  if (error.message === CHECKOUT_CLOSED) return "closed";
  throw error;
}
/** A checkout refused because `price` is no longer what it would charge. */
export class PriceChangedError extends Error {}
/**
 * Starts a checkout of `plan` at the `price` the page showed, agreeing to the current terms and to automatic
 * renewal, and sends this tab to Stripe.
 */
export async function startCheckout(plan: Plan, price: number, ref: string | null) {
  const response = await billing(
    "/checkout",
    sendJson("POST", { plan, ...(ref ? { ref } : {}), terms: TERMS_VERSION, autoRenew: true, price }),
  );
  if (!response.ok) {
    const error = await billingRefused(response);
    throw response.status === 409 && error.message === PRICE_CHANGED ? new PriceChangedError(error.message) : error;
  }
  leaveFor(((await response.json()) as { url: string }).url, BILLING_UNAVAILABLE);
}
/** Confirms the checkout Stripe returned from, answering the plan it bought. */
export async function confirmCheckout(checkout: string): Promise<BillingSummary> {
  const response = await billing("/confirm", sendJson("POST", { checkout }));
  if (!response.ok) throw await billingRefused(response);
  return (await response.json()) as BillingSummary;
}
/** Sends this tab to Stripe's billing portal for this account's subscription. */
export async function openPortal() {
  const response = await billing("/portal", { method: "POST" });
  if (!response.ok) throw await billingRefused(response);
  leaveFor(((await response.json()) as { url: string }).url, BILLING_UNAVAILABLE);
}
/** Withdraws from the contract `subscription` names, answering the plan with its acknowledgement. */
export async function withdraw(subscription: string): Promise<BillingSummary> {
  const response = await billing("/withdraw", sendJson("POST", { subscription }));
  if (!response.ok) throw await billingRefused(response);
  return (await response.json()) as BillingSummary;
}
/** Closes this account, cancelling its subscription first; its login ends with it. */
export async function closeAccount() {
  const response = await request(
    "/api/account/close",
    sendJson("POST", { close: true }),
    "Your account cannot be closed right now. Try again.",
    true,
  );
  if (!response.ok) throw await refused(response);
}
/** Joins the founders row under `name`, or leaves it. */
export async function setFounder(shown: boolean, name: string): Promise<BillingSummary> {
  const response = await billing("/founder", sendJson("PUT", shown ? { shown, name } : { shown }));
  if (!response.ok) throw await billingRefused(response);
  return (await response.json()) as BillingSummary;
}
