# Dormouse Hosted accounts: rationale

## Managed voice

History sweep (sources checked 2026-09-22):

- ElevenLabs stores every text-to-speech generation, including its text, in the account's speech history. Turning that off per request (`enable_logging=false`, zero-retention mode) is available to enterprise accounts only, so deletion is the remaining control. The history API filters only by voice or model, not by "items this Worker created", so a sweep of a shared account would delete unrelated history.
- Deleting the item straight after the speech call fails: the operator observed (2026-09) that the history item does not exist yet. The after-speech pass therefore waits about 10 s, and the cron pass catches anything that was still not listed. Spoken text usually leaves ElevenLabs about 10 s after the call, otherwise within the 5-minute interval plus ElevenLabs' indexing delay.
- `ctx.waitUntil()` extends an HTTP invocation for at most 30 s after the response is sent (https://developers.cloudflare.com/workers/runtime-apis/context/), so a 10 s wait plus one short pass has margin. Every 5 minutes is the backstop because the after-speech pass handles the common case.
- Workers limits (https://developers.cloudflare.com/workers/platform/limits/, checked 2026-09-22): 50 subrequests per invocation on Free, and six connections may await response headers at once. The per-pass caps fit the Free limit, so the sweep does not depend on the account's plan; a test pins the arithmetic.
- Endpoints: https://elevenlabs.io/docs/api-reference/history/list and https://elevenlabs.io/docs/api-reference/history/delete.
- The cron resolves bindings through the same mapper as a request, so a broken OAuth allowlist in the production mapper also fails the cron run loudly instead of sweeping silently.
