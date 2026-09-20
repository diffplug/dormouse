// Policy values the Worker and the frontend bundle both need. This module
// imports nothing, for the reason `./providers.js` does not either: `./policy`
// reaches the OAuth client secrets through `providerBindings`, and
// docs/specs/security-hosted.md -> "Origin boundary" has an auditor inspect the
// frontend import graph. The account screen takes its constants from here so
// that graph never walks back to the module holding the secrets.

// How long after signing in a login still counts as recent enough to connect a
// provider. The packed adapter enforces it as Better Auth's `session.freshAge`
// and the account screen gates its buttons on the same window, so the two would
// desync silently on a pgstencil bump: a UI that offers "connect" for a login
// the server has already stopped accepting 302s to /login?error=. One value,
// and `hosted/server/tests/policy.test.ts` pins it to what the adapter builds.
export const LOGIN_FRESH_AGE_MS = 10 * 60 * 1000;
