export const providers = ["github", "google", "microsoft", "apple"] as const;
export type Provider = (typeof providers)[number];
export const providerNames: Record<Provider, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
};
export interface Session {
  user: { id: string; email: string | null; name: string };
  session: { createdAt: string; expiresAt: string };
}
export interface Account {
  providerId: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
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
  if (!response.ok) {
    if (response.status === 429)
      throw new Error("Too many attempts. Wait a minute before trying again.");
    if (response.status >= 500)
      throw new Error("Sign-in is temporarily unavailable. Please try again.");
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
