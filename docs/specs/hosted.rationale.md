# Dormouse Hosted accounts: rationale

## Managed voice

History sweep (sources checked 2026-09-22):

- ElevenLabs stores every text-to-speech generation, including its text, in the account's speech history (`GET /v1/history`). Turning that off per request (`enable_logging=false`, zero-retention mode) is available to enterprise accounts only, so deletion is the remaining control.
- Deleting the item straight after the speech call fails: the operator observed (2026-09) that the history item does not exist yet. The after-speech pass therefore waits about 10 s, and the cron pass catches anything that was still not listed.
- `ctx.waitUntil()` extends an HTTP invocation for at most 30 s after the response is sent (https://developers.cloudflare.com/workers/runtime-apis/context/), so a 10 s wait plus one short pass has margin. A Cron Trigger cannot fire more often than once a minute; every 5 minutes is the backstop because the after-speech pass handles the common case.
- Workers limits (https://developers.cloudflare.com/workers/platform/limits/): 50 subrequests per invocation on Free and 10,000 on Paid; six connections may await response headers at once; cron CPU time is 10 ms on Free and 30 s on Paid for intervals under an hour; a scheduled invocation may run 15 minutes of wall time. The per-pass caps in `hosted/server/voice.ts` fit the Free subrequest limit, so the sweep does not depend on the account's plan. The work is almost entirely waiting on fetches, not CPU.
- A pass lists before it deletes because `start_after_history_item_id` would otherwise name an item the same pass had just removed. The endpoints used are `GET /v1/history` (`page_size` up to 1000, `start_after_history_item_id`, response `history[].history_item_id`, `has_more`, `last_history_item_id`) and `DELETE /v1/history/{history_item_id}`, both authenticated with `xi-api-key` (https://elevenlabs.io/docs/api-reference/history/list, https://elevenlabs.io/docs/api-reference/history/delete).
- The sweep is whole-account because the history API has no filter for "items this Worker created" beyond voice or model, so a shared account would lose unrelated history.
