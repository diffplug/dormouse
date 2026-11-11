# Hosted account security: rationale

## Origin boundary

Cookie reads (2026-10-11):

- The packed adapter admits `get-session` and `list-accounts` whatever `Origin` they present, and the cookie routes used to admit a read with no `Origin`. Without CORS another page cannot read the answer, but the request still runs: a database lookup and a Better Auth rate-limit count against the visitor's address. The 2026-10-04 and 2026-10-07 audits read "cookie route" both as covering the auth reads and as not, so the rule now names every read.
- The auth reads are gated by default rather than by a list, so a read a later adapter release adds is gated too; only a provider callback (a cross-site navigation, or Apple's form post) and the CSRF challenge (which any page may start from, and which acts on no login) are open.
- Callers, inventoried 2026-10-11: the account page's own fetches (`hosted/src/api.ts`, `credentials: "same-origin"`); the account's cookie routes (`cookieAdmin`), which call the auth handler in-process and so never meet the rule; and the release smoke (`hosted/scripts/preview-smoke.mjs`), which sends what the page sends. Nothing on the relay or voice origin makes a cookie read: the relay bundle carries no cookie or auth route (`hosted/server/tests/boundary.test.ts`), speak is bearer-only, and the `__Host-` login cookie never reaches a sibling Worker. Pocket, the one-time page, the desktop, and the website make none; the desktop only opens account pages in the system browser.
- No caller needs a sibling's `same-site` or a navigation's `none`, so neither is admitted. Script on the relay origin renders untrusted terminal output (`docs/specs/hosted.rationale.md` -> "Application boundary"), so admitting it would admit the one page the origin split distrusts.
- A missing `Sec-Fetch-Site` is refused rather than trusted: a browser without Fetch Metadata (Chrome before 76, Firefox before 90, Safari before 16.4) sends a same-site image or script request with neither it nor `Origin`, the shape a non-browser caller has. Such a browser cannot load the account page; every caller this deployment has is in-process or can send the header.
- The requests that stay open to other sites (a provider callback, the CSRF challenge) still carry the login cookie, as does the provider list, which strips it before the handler.
- The gate is keyed on the open paths, not on a list of reads (dormouse-bot on #1104, 2026-10-11): Better Auth 1.7.7 also serves `list-sessions` and `account-info`, which take a login and the second calls the provider with its token. The packed adapter 404s both today, so a list would hold only until an upgrade. `boundary.test.ts` enumerates the installed Better Auth's GET endpoints.
- 403, not a signed-out answer, so a refusal never reads as a logout.

## Deployment boundary

pgstencil provenance at deploy time (2026-10-20):

- Renovate opens a pgstencil bump as soon as a release is approved (`.github/renovate.json`), and a production deploy can follow its merge within hours, between two nightly audits. The `verify` job therefore asks npm for each package's registry signature and provenance attestation before every deploy.
- npm verifies the signature, the certificate chain, and the subject against the registry's tarball, not who signed: the payload's workflow claim is the signer's own statement. pgstencil's `release.yml` stages only a `main` commit whose `security-audit` passed, and its npm trusted publisher names that workflow, but those are its settings, which this repository cannot read and a hand publish would skip (0.2.0 was one). So the `verify` job reads the signer, source commit, and audit itself (2026-11), rather than leaving a mismatch for that night's audit to find.
- `verify` holds a commit to S120 as written, so any failed `security-audit` on it refuses a deploy, a flake included, until that run is rerun or a new release ships. A rerun replaces the failed run in the API's default (`latest`) view.
