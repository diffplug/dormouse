import { providerIds, providerNames } from "../server/providers.js";
import type { ProviderId } from "../server/providers.js";

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
  if (response.status >= 500) throw new Error(unavailable);
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
  const url = new URL(result.url);
  if (url.protocol !== "https:")
    throw new Error("Sign-in is temporarily unavailable. Please try again.");
  window.location.assign(url.href);
}

export interface VoiceToken {
  id: string;
  createdAt: string;
  /** Stamped by each speak. */
  lastUsedAt: string | null;
  revokedAt: string | null;
}
async function voice(method: string, path = ""): Promise<Response> {
  return request(
    `/api/voice/tokens${path}`,
    { method },
    "Voice tokens are temporarily unavailable. Try again.",
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
/** A voice or relay call's error when the server gave none written for this page. */
const failed = () =>
  new Error("That did not work. Reload the page and try again.");
/** Null when the server says this account may not use managed voice. */
export async function getVoiceTokens(): Promise<VoiceToken[] | null> {
  const response = await voice("GET");
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw failed();
  return ((await response.json()) as { tokens: VoiceToken[] }).tokens;
}
export async function createVoiceToken() {
  const response = await voice("POST");
  if (!response.ok) throw failed();
  return (await response.json()) as Pick<VoiceToken, "id" | "createdAt"> & {
    token: string;
  };
}
export async function revokeVoiceToken(id: string) {
  if (!(await voice("DELETE", `/${encodeURIComponent(id)}`)).ok)
    throw failed();
}

export interface Computer {
  burrowId: string;
  enrolledAt: string;
}
async function relay(path: string, init: RequestInit = {}): Promise<Response> {
  return request(
    `/api/relay${path}`,
    init,
    "Computers are temporarily unavailable. Try again.",
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
export async function approveEnrollment(userCode: string) {
  const response = await relay("/enrollments/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  if (!response.ok) throw await refused(response);
}
