# Dormouse Hosted accounts: rationale

## Managed voice

History sweep (sources checked 2026-09-22):

- ElevenLabs stores every text-to-speech generation, including its text, in the account's speech history. Turning that off per request (`enable_logging=false`, zero-retention mode) is available to enterprise accounts only, so deletion is the remaining control. The history API filters only by voice or model, not by "items this Worker created", so a sweep of a shared account would delete unrelated history.
- Deleting the item straight after the speech call fails: the operator observed (2026-09) that the history item does not exist yet. The after-speech pass therefore waits about 10 s, and the cron pass catches anything that was still not listed. Spoken text usually leaves ElevenLabs about 10 s after the call, otherwise within the 5-minute interval plus ElevenLabs' indexing delay.
- `ctx.waitUntil()` extends an HTTP invocation for at most 30 s after the response is sent (https://developers.cloudflare.com/workers/runtime-apis/context/), so a 10 s wait plus one short pass has margin. Every 5 minutes is the backstop because the after-speech pass handles the common case.
- Workers limits (https://developers.cloudflare.com/workers/platform/limits/, checked 2026-09-22): 50 subrequests per invocation on Free, and six connections may await response headers at once. The per-pass caps fit the Free limit, so the sweep does not depend on the account's plan; a test pins the arithmetic.
- Endpoints: https://elevenlabs.io/docs/api-reference/history/list and https://elevenlabs.io/docs/api-reference/history/delete.
- The cron resolves bindings through the same mapper as a request, so a key the voice mapper drops is a key the sweep never sees, the same as for speak.
- A failed cron pass fails its invocation because the sweep is a privacy control that nothing else watches. A key scoped to text-to-speech alone, or rotated later with that narrower scope, keeps speech working while every list is refused, and spoken text would pile up in ElevenLabs history unseen. `hosted/wrangler.voice.jsonc` disables observability and `productionConfig` in `hosted/scripts/production.mjs` requires it off (checked 2026-09-30), so production retains no logs; a failed invocation in the Worker's Cron Events is the signal. A failed delete fails the invocation only after the others are attempted, so one stuck item never holds back the rest. The after-speech pass runs in `waitUntil` on a request that already succeeded, and the next cron pass retries what it missed.

## Application boundary

Three origins (decided 2026-09-30):

- Pocket (staged for the relay origin's root) and the `/connect/` page render untrusted terminal output. Script running on the account's origin could make any request the login cookie authorizes and read the answer, so `/connect/` moved to `relay.dormouse.sh` and the account kept its origin.
- Sibling origins under `dormouse.sh` are same-site, not same-origin: `SameSite=Lax` does not stop a browser from attaching the account's cookie to a request a `relay.` or `voice.` page makes to `hosted.`. The exact-`Origin` check on every cookie route is what refuses those requests.
- No released desktop build bakes `hosted.dormouse.sh` (v1.1.0, the last release, predates one-time and managed voice), so the routes moved off it with no compatibility shim.

## Production releases

- Deploy order (2026-09-30): the account's `v2` deletes the `OneTimeRoom` namespace the relay's `v1` replaces, and a deployed migration is a rollback floor. Deploying the account first would make the deletion permanent before the replacement is known to deploy; with the relay first, a failed relay deploy stops the release before the account changes.
- Relay smoke before the account (2026-10-01): a relay deploy can succeed while its custom domain or rendezvous does not serve, and the full smoke runs only after the account deployed, so by then `v2` had already deleted the old room. Smoking the relay right after its deploy keeps the deletion behind a proven replacement.
- Relay readiness before the account (2026-10-03): the relay connects as `dormouse_relay`, and a grant the role lacks fails only the queries that need it, which the revision, push, and rendezvous checks never run. `/api/ready` runs the session lookup's shape, so a role that cannot log in, or lacks that lookup's grants, stops the release before the voice or account deploys; the rest of the grants are pinned by `hosted/server/tests/runtime-roles.test.ts`, not the release.
- Smoke attempts (2026-09-30): the first release after the split attaches `relay.dormouse.sh` and `voice.dormouse.sh` as new custom domains, and a new certificate can take longer to issue than the health GET's six five-second retries. Repeating a relay or voice smoke sends only GETs and WebSockets on a fresh room, so it replays no POST; the account smoke's POSTs keep it at one attempt.

## PR previews

- One owner-role Hyperdrive per PR (decided 2026-10-03): a Hyperdrive per role would triple each PR's Hyperdrives against a preview-account limit nobody has measured, and the grants are exercised where they can fail a PR, in `hosted/server/tests`, which binds the relay and voice Workers to their roles.

## Relay

Caps (2026-09-30):

- Passkeys per account (`MAX_PASSKEYS_PER_ACCOUNT`, 32): registration needs a setup token the account's own Burrow minted, so only the account grows its rows. A person registers one per phone or unsynced browser profile, and every `setup/begin` returns the whole list as `excludeCredentials`. A full account is refused rather than evicted, since evicting a passkey would sign a device out without saying so.
- Sessions per account (`MAX_SESSIONS_PER_ACCOUNT`, 32): each costs an assertion by one of the account's own passkeys, so only the account can spend it, and 32 is far above the browsers a person signs in from within the 12-hour lifetime. Evicting the oldest costs at worst one re-sign-in.
- Setup challenges are keyed by the Burrow whose token began them, which also makes a challenge unredeemable with another Burrow's token. The self-host Relay's single flat issuer was the accepted exception for one tenant; across accounts, a flat map would let one account evict another's live registration.
- Sign-in challenges stay flat: `signin/begin` has no caller to key on. The per-address limit, the two-minute expiry, and the hourly sweep bound them, rather than a global cap whose flood would evict every account's live sign-in.
- A capped write prunes only its own key's expired rows because a table-wide prune would make every unauthenticated request a full-table delete; the Cron Trigger sweeps the rest.

Sweep interval (2026-09-30): hourly, not the voice sweep's five minutes. Each pass opens a Postgres connection, which wakes a suspended Neon compute; expired rows are refused on read whatever their age, so the sweep only bounds storage, and an hour of sign-in challenges is the per-address limit times an hour per address.

Rate limits (2026-09-30): `signin/*` and `setup/begin`/`finish` are the unauthenticated routes that read or write a row; `/api/ready` reaches Postgres too, as the account's has since launch, but reads none. A ceremony's two routes share one budget, so 30 a minute per address is 15 ceremonies, far above one person's retries and enough that a burst costs Postgres little. Like the one-time limits, they are keyed per address (an IPv6 /64), so they bound one caller, not a botnet.

Push (2026-10-01):

- Per-account cap (`MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT`, 256) in place of self-host's total: a self-host Relay is one account, so its total already was a per-account bound, and the same 256 keeps the two Relays' ceilings equal. A global cap across accounts would let one account's subscribe loop evict every other account's phones; keyed by the account, a caller only ever evicts its own. 256 is eight laptops' worth at the per-Burrow cap, far above the phones a person pairs, and the per-Burrow cap still stops one Burrow from holding them all.
- Endpoint allowlist instead of the DNS guard: a Worker's `fetch` resolves and connects inside Cloudflare's network, so the Relay can neither see nor pin the address a hostname resolves to, which is the whole of the self-host guard. Cloudflare's egress cannot reach a customer tailnet either way, so the risk left is the Worker as a blind POST relay at an arbitrary public host, carrying a VAPID JWT for that host. Every browser Pocket runs in subscribes at one of four services: Chrome and Android at FCM (`fcm.googleapis.com`), Firefox at autopush (`updates.push.services.mozilla.com`), Safari at APNs, which Apple documents as `https://*.push.apple.com`, and Edge on Windows at WNS (`*.notify.windows.com`). A browser that adds a service needs a line here before it can register, which is the intended failure. A redirect is failed rather than followed, so a push service's answer cannot steer the request off the allowlist.
- A repeated recipient is sent once: Workers Free allows 50 subrequests per invocation, and with each `deliveryId` sent at most once a send makes at most `MAX_PUSH_SUBSCRIPTIONS_PER_BURROW` (32) fetches, whatever `recipients` holds, plus its two database connections (the read and the prune). The Burrow names each ACL record once, so only a malformed send repeats one.
- Preview VAPID pairs derive from the preview secret and the Worker's name, as its other secrets do, so a PR's subscriptions survive redeploys and no production key reaches a preview.

## Relay sockets

A `RelayRoom` that opened a Postgres connection through Hyperdrive could not be evicted afterwards: `unsafeEvictDurableObject` timed out on "it still has active references" even after the client had ended and its socket was closed, while an object that opened and closed a bare socket to the same host evicted normally (measured in Miniflare 5.20260908, 2026-10). Reading the rows in a Worker invocation of their own, through `ctx.exports`, leaves the object hibernatable.

## Burrow enrollment

- Begin stores nothing (2026-10-01): a stored request needed a cap, and `begin` is unauthenticated, so the cap could only be global, which a few /64s at the per-address limit could fill, locking every Burrow out of enrolling. With the expiry inside the device code and the user code derived from it, begin costs one HMAC and grows nothing.
- User code derivation: the HMAC key keeps the user code unpredictable from the device code, so no one can mint a device code for a code a victim is about to approve without about 30⁸ ≈ 6.6 × 10¹¹ begins, against 10 a minute per address. Two live device codes sharing a user code is a 40-bit collision; the approval then redeems for whichever polls first, as owned by the approver. Skipping the two 5-bit values past the alphabet keeps characters uniform; a 256-bit MAC holds 51 groups for 8 characters.
- Approvals table bound: the approval route is its only writer, authenticated, admin-only, and limited to 10 attempts a minute per account, each approval living 10 minutes, so one account holds at most about 100 live approvals.
- Guessing: approving a well-formed code no Burrow holds enrolls nothing; to steal a pending enrollment the account would have to be the one approving its code, which is the flow itself.
