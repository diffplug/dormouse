# Hosted account security: rationale

## Origin boundary

The cohort exception (2026-10): the Hosted page on `dormouse.sh` reads seats and founders after hydration. Serving that one `GET` path same-origin through a zone route keeps the page free of CORS and of any request to another host, and the account Worker answers that origin nothing else, so no cookie route, auth route, or page of the account becomes reachable as `dormouse.sh`.

## Billing boundary

- Stripe's synchronized rows are the only billing state the entitlement trusts: `@pgstencil/stripe` rewrites them from Stripe's own subscription list under the owner's lock on every webhook, confirm, view, and resync, so a forged or replayed event can at most trigger a resync. A success URL alone never grants access.
- The entitlement compares against the database's `now()` rather than a Worker clock so the relay, voice, and account Workers agree on one instant within the same query that resolves the bearer.
- The cohort endpoint is public and cached, so anything it carries is published. A founder's chosen name is the only per-person field, and only an opted-in, current founder appears.
