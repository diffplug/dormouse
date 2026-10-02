# Burrow service — Rationale

> Informative companion to [burrow-service.md](burrow-service.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative — every rule it explains is stated in the spec.

## Relay origin

**Why one origin rather than an allowlist.** The retired `DORMOUSE_REMOTE_CONNECT_SRC` default, `https://*.dormouse.sh wss://*.dormouse.sh`, was a wildcard only to leave room for BYOT's per-tenant hosts, which nothing shipped used; any DNS name added under `dormouse.sh` widened what every stock binary would talk to. The Hosted origin was a second baked value (`DORMOUSE_HOSTED_ORIGIN`) that had to agree with the list, or one-time links went dark. One exact origin is both narrower and one fact: a build is Hosted or points at exactly one self-host Relay, and nothing else it reaches in the background is left to configure.

**Why a self-host build reaches nothing of Dormouse's in the background.** A self-hoster runs their own Relay to keep their traffic off infrastructure they do not control. An update check, a rendezvous room, or a voice request would each tell `dormouse.sh` that the machine exists and when it runs, and the updater would do worse: the manifest names the stock binaries, so installing one over a source build replaces its baked origin with Hosted's and silently drops its Relay.

**Why a release build refuses the Hosted flag and a loopback origin.** The flag turns on Hosted behavior — the voice token, the rendezvous — for an origin Dormouse may not operate; that is useful against a local `pnpm dev:hosted` or a PR preview and wrong in anything installed. A loopback `http:` origin in an installed binary points it at whatever listens on that port of the user's own machine.

**Why managed voice speaks at a fixed origin rather than a baked one.** A second baked value would be the drift `DORMOUSE_HOSTED_ORIGIN` was (above): a variable that must agree with the relay origin, or a feature goes dark. Voice has no self-host counterpart, so nothing needs to point it elsewhere; a dev Hosted build on loopback speaks to the real service. It is its own origin, not the relay's, so the Worker holding `ELEVENLABS_API_KEY` serves nothing else.

**Why an enrollment for another origin is kept rather than deleted.** The `burrowToken` in it cannot be re-minted without the setup password, so a user moving between a stock build and a self-host build — or between two dogfood builds — would lose every pairing on each switch. Reading it as none is enough: nothing connects to an origin the build was not baked with.

**The build-time guards.** A lost esbuild `define` compiles fine, surfacing only as a Burrow quietly using the shipped default — Hosted — instead of the self-hoster's Relay: a build that looks correct and has no Relay at all, so `assertRelayOriginBaked` greps the emitted bundle for the value. An origin outside the accepted rule would never match what the runtime composes, and a retired variable left over from older instructions would build a stock Hosted binary without a word, so `resolveRelayOrigin` fails the build on both.

## Burrow side (`lib` + the two Node hosts)

**Why two rapid ACL writes are serialized.** Two pairing approvals in quick succession each write a whole ACL snapshot, the second larger; out of order, the older lands last and erases the device the newer one had just added.

**Why `WS_CLOSE_BURROW_REPLACED` is terminal rather than retried.** Reconnecting on it would evict the newer Burrow, which would reconnect and evict this one, forever; an explicit `reconnect()` breaks the loop.

**Why `removed` and `not-entitled` latch too.** Tested on the Hosted preview (2026-10): a computer removed on the account page had its socket closed 4001, then reconnected with backoff forever, each upgrade refused 401, which the global `WebSocket` reports only as an error event — so Settings still showed it enrolled and reconnecting while every phone's Connect failed as "did not answer". Retrying a token the Relay refuses changes nothing. 4002 is its own code because the fix differs: a plan, not a re-enrollment.

**Why the probe, and its route.** A machine that starts after its removal never sees the 4001, and a refused upgrade carries no status a `WebSocket` exposes, so only an HTTP request can learn why. `GET /api/push/devices` is the one Burrow-gated read both Relays serve and answer with the gate's refusal; a plain `GET /ws/burrow` would not do, since Hosted answers 426 before it looks the token up. A probe that got no answer spends nothing because a laptop waking before its network would otherwise spend the streak's probe on a timeout and never learn; a 5xx or other status not about the token — a Relay restarting, a proxy's 502 — spends nothing for the same reason; the reconnect backoff already bounds how often it asks.

**Why all socket events check ownership.** In a loopback `ws` experiment (2026-09), closing the client in its open callback still delivered a queued message while CLOSING. The runtime assigns a frame's epoch when it arrives, so the in-flight handshake guard alone cannot reject a retired socket's later delivery: it adopts the new epoch. Such an init recreated pending state after stop; a late `client-gone` disposed a replacement connection. Guarding message and open delivery alongside close preserves the stopped or replacement lifetime.

**Where a bad enrollment record would surface.** A record minted with an `undefined` in its `ConnectionPolicy` fails at no point during enrollment; it fails at the *next* read, where the store rejects it, so the machine silently un-enrolls at the next launch — an app-restart away from the response that caused it. Failing the exchange on the spot names the missing fields instead.

**Why the enrollment request's 10 s timeout is the shorter one.** It runs on the service's lifecycle chain, where every later start/stop command queues behind it, so an enrollment hanging past the webview's own 15 s command budget would replace the real error with a timeout and stall every command queued after it.

**What losing the `burrowToken` costs.** The alternative ordering — stop the running Burrow, then save — strands the machine with no Burrow, a status that says otherwise, and a credential that cannot be re-minted from the same password exchange; the only recovery is a fresh enrollment against the Relay.

## Remote control, in the Settings dialog

**What the offer read is bounded to.** The un-enrolled state, not the dialog: the 2 s poll is the loudest reader, but the enrolled-gate seeds itself from `status` too, so an un-enrolled machine pays roughly two ENOENT opens per webview activation on top of it. An enrolled machine, left running for days, pays nothing.

**Why the connection is polled.** Without the 2 s poll, a machine that finished connecting a moment after the dialog opened would read as permanently "Connecting…".

**Why the QR panel names the decision that ended a code.** Every outcome — approval, denial, mismatch — spends the invitation and dismisses the modal, so with one attempt and no retry a mismatch would look exactly like a success, the paired-device count being absolute rather than a delta.
