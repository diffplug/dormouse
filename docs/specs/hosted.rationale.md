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
- Smoke attempts (2026-09-30): the first release after the split attaches `relay.dormouse.sh` and `voice.dormouse.sh` as new custom domains, and a new certificate can take longer to issue than the health GET's six five-second retries. Repeating a relay or voice smoke sends only GETs and WebSockets on a fresh room, so it replays no POST; the account smoke's POSTs keep it at one attempt.

## Relay

Caps (2026-09-30):

- Passkeys per account (`MAX_PASSKEYS_PER_ACCOUNT`, 32): registration needs a setup token the account's own Burrow minted, so only the account grows its rows. A person registers one per phone or unsynced browser profile, and every `setup/begin` returns the whole list as `excludeCredentials`. A full account is refused rather than evicted, since evicting a passkey would sign a device out without saying so.
- Sessions per account (`MAX_SESSIONS_PER_ACCOUNT`, 32): each costs an assertion by one of the account's own passkeys, so only the account can spend it, and 32 is far above the browsers a person signs in from within the 12-hour lifetime. Evicting the oldest costs at worst one re-sign-in.
- Setup challenges are keyed by the Burrow whose token began them, which also makes a challenge unredeemable with another Burrow's token. The self-host Relay's single flat issuer was the accepted exception for one tenant; across accounts, a flat map would let one account evict another's live registration.
- Sign-in challenges stay flat: `signin/begin` has no caller to key on. The per-address limit plus two-minute expiry bounds them, rather than a global cap whose flood would evict every account's live sign-in.
