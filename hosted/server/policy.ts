import type { AuthAppOptions } from "@pgstencil/auth/better-auth";
import { providerIds } from "./providers.js";
import type { ProviderId } from "./providers.js";

export const authPolicy = {
  appName: "Dormouse Hosted",
  sessionPolicy: "multiple",
  accountLinking: "explicit",
  allowMissingEmail: true,
  rememberLoginMethod: false,
  successPath: "/account",
  errorPath: "/login",
} satisfies Partial<AuthAppOptions>;

// The allowlist itself lives in ./providers.js, which the frontend and the
// plain-node deploy scripts import without this module's dependencies.
export { providerIds, type ProviderId };

// How long after signing in a login still counts as recent enough to connect a
// provider. The packed adapter enforces it as Better Auth's `session.freshAge`
// and the account screen gates its buttons on the same window, so the two would
// desync silently on a pgstencil bump: a UI that offers "connect" for a login
// the server has already stopped accepting 302s to /login?error=. One value,
// and `hosted/server/tests/policy.test.ts` pins it to what the adapter builds.
export const LOGIN_FRESH_AGE_MS = 10 * 60 * 1000;

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
