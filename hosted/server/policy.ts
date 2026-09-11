import type { AuthAppOptions } from "@pgstencil/auth/better-auth";

export const authPolicy = {
  appName: "Dormouse Hosted",
  sessionPolicy: "multiple",
  accountLinking: "explicit",
  allowMissingEmail: true,
  rememberLoginMethod: false,
  successPath: "/account",
  errorPath: "/login",
} satisfies Partial<AuthAppOptions>;

export const providerIds = ["github", "google", "microsoft", "apple"] as const;
export type ProviderId = (typeof providerIds)[number];

// Only an explicit deployment allowlist enables a provider; stale secrets do not.
export function providerBindings(env: Record<string, unknown>) {
  const enabled = String(env.OAUTH_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bindings: Record<string, string> = {};
  for (const provider of enabled) {
    if (!providerIds.includes(provider as ProviderId))
      throw new Error("Unknown OAuth provider");
    for (const suffix of ["CLIENT_ID", "CLIENT_SECRET"]) {
      const key = `${provider.toUpperCase()}_${suffix}`;
      const value = env[key];
      if (typeof value !== "string" || !value.trim())
        throw new Error(`Missing ${key}`);
      bindings[key] = value;
    }
  }
  return bindings;
}
