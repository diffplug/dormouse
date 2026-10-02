# Relay (selfhost) — Rationale

> Informative companion to [relay.md](relay.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative — every rule it explains is stated in the spec.

## Guardrails

**Why the pruning matters.** Transient state is cheap to mint: `POST /api/signin/begin` needs no auth, and a `connect` frame needs only a session — not a pairing — yet issues a challenge in the Burrow process on the user's laptop. Unpruned, single-use/TTL stores grow from traffic nobody had to earn authority to send, on laptop as on the Relay.

**Why the presence-nonce cap is per session.** A presence nonce is minted *before* its WebAuthn prompt, so it waits out human latency; under a global cap, any other session's flood evicted it mid-prompt and failed every pairing and connection ceremony for as long as the flood ran.

## Configuration

**Loopback-lint scope.** The lint covers browser-reachable proxies whose loopback literal appears in source; the Relay binds from `DORMOUSE_BIND_HOST`, never a literal, so the spec's containment argument covers what text matching cannot.

**Why `burrows.json` existence closes bootstrap.** Its first atomic write commits the first enrollment. Row count would reopen bootstrap after documented revocation removes the last row; a separate marker would duplicate the transition.

**Why a relative path is a `ConfigError`.** `DORMOUSE_RUNTIME_FILE` and `DORMOUSE_ENROLL_TOKEN_FILE` come from the installer's `run-relay` wrapper, which a service manager launches with a working directory that is not the installer's — a relative value lands where neither side can predict. The same drift is why `DORMOUSE_POCKET_DIR` resolves from the compiled Relay's own location: a service manager could otherwise change what is served.

**Why the installers keep the runtime file outside the state dir.** It is runtime truth about one process — pid, port, release — not durable state a backup should capture and a restore replay.

**Why a blank `PORT` is not zero.** `Number('')` is 0, which asks the OS for an ephemeral port and moves the Relay out from under whatever proxy is pointed at it — the same reason an explicit `PORT=0` is refused.

**Why only the exact string `true` turns user verification on.** Enabling it without UV-capable authenticators locks the account out of its own Relay: the cost of reading a misspelling as on.

**Why the origin is normalized rather than compared as typed.** A trailing slash reads as correct in an `.env` file and then fails every compare it reaches, unless every compare site re-parses it first.

## State files

**What an unguarded row costs.** A `burrows.json` row with a null `burrowToken` makes `findByToken`'s digest compare throw, and that lookup runs on every relay upgrade and every push route — so one typo during the *documented* hand-edit revocation becomes a 500 on `/ws/burrow` and on every push endpoint until the file is repaired; dropping the row degrades exactly one burrow's access instead.

**Where `0600` earns its place, and where it does not.** It matters on a multi-user unix host: home-directory permissions vary by distro, so without an explicit mode whether a second local account can read `burrows.json` depends on which distro the selfhoster picked. It buys nothing where file modes are not the mechanism — Windows, a container, a database-backed deployment.

**Why `burrowId` has one pinned shape.** Every `e2e` envelope routes on it and the QR fragment carries it at a fixed width: another shape is a Burrow the relay admits, no Client can address, and whose codes no phone can parse — un-enrolled is what the person hand-editing the file was reaching for.

**Why a fresh `deliveryId` cannot close the endpoint gap.** Linking a new delivery id to its scope's previous address would take cross-Burrow device identity on the Relay, which the model does not have; until the push service 404/410s them, the stale rows are the price.

**Why the subscription store gets per-field bounds and row caps.** A `deliveryId` is the caller's own choice and no Relay can check one against a Burrow's ACL, and every push route re-parses the whole file, so unchecked growth is paid on every request. An evicted Client reads as un-registered and repairs by pressing Enable, the recovery a dropped row already has.

## WebAuthn without a WebAuthn library

**Two facts made the dependency unnecessary.** The browser hands the new credential's public key back as SPKI DER, and `remote-lib-common` already carried a full assertion verifier — written for the Burrow — that works against an SPKI key. Nothing was left for a library to do.

**Why the challenge issuers are capped as well as swept.** The mint is unauthenticated (Guardrails), so expiry alone lets the map plateau at request-rate × TTL rather than at a bound the process chose. A flood evicts abandoned challenges of its own making, the ceremony that loses one retries, and single use is untouched.

## HTTP API

**Why the body bound runs before the credential gate.** Those routes must read the body to find its credential, so an unbounded reader would let a public caller make the process buffer arbitrary input before proving anything.

**What three route answers are protecting.** `POST /api/setup/retire` exists so a QR a phone scanned but will not register with cannot stay redeemable in a photograph. `/api/burrow/enroll` checks its `MAX_ENROLLED_BURROWS` cap after the credential so a caller that proved nothing cannot learn the Relay is full. `/api/push/subscribe` 404s an unknown `burrowId` so no subscription row strands where no Burrow can read or prune it.

**Why the enroll origin check runs ahead of the credential, unlike the cap.** Its answer is the Relay's own origin, which every page it serves already names, where the cap would tell a caller that proved nothing how full the Relay is. Checked first, it also refuses before the first password enrollment takes the installer's offer with it, and a Burrow built for another Relay learns what to fix even through a mistyped password (review, 2026-09).

**Why only Burrow enrollment pays the failure delay.** A delay retains a request. The setup password route is protected by the process-global admission bucket, so its retained work is bounded. Setup, Burrow, and session tokens are random bearer capabilities with no plausible online search; delaying their rejection buys public traffic held connections without protecting a human secret.

## Setup tokens and the pairing QR

**Why the enroll credential is counted by presence, not tried in turn.** Trying the password and then the enroll token — or the reverse — would let a spent token fall through to the other credential, turning a one-shot offer into a second guess at the password.

**Why the localhost exception is a list, not a rule.** Each of `localhost`, `127.0.0.1` and `[::1]` is a secure context by the platform's own rule, but that rule is broader than these three; admitting exactly them parses the documented `http://localhost:3000` dev loop with nothing wider along for the ride.

## Web Push

**Why the log carries the service's reason body.** A status alone does not separate a bad subject from a bad key from a bad payload, and the service's own explanation is visible nowhere else — the route answers 200 either way and the Burrow sees only a `failed` count.

**The outer deadline protects delivery waiting, not the socket.** `web-push` accepts no `AbortSignal`: a request that loses the race keeps running under its own inactivity timeout. The route-level deadline stops a wedged push service from holding the handler open while successive alarms stack sends behind it, and catches what socket inactivity cannot — trickled bytes or a stall mid-handshake reset that timer forever. Every send in a fan-out starts at once, so one wall-clock bound covers delivery waiting at any device count; state reads and pruning writes remain outside it.

**Why a stale-VAPID row is hidden rather than reported.** Such an endpoint cannot receive a send signed by the current key, so listing it would let the Burrow name and retry an unreachable device; omitting it surfaces Pocket's re-registration action instead.

**A loopback VAPID subject: measured, not guessed.** Apple answers `403 {"reason":"BadJwtToken"}` — verified against `web.push.apple.com` (2026-08) for `mailto:admin@localhost` and `https://localhost:3000`, while `mailto:admin@example.com` and an ordinary https origin were accepted; the rule is loopback specifically, not reachability of the contact. `web-push` warns only about the https form, at send time, and nothing at all about `mailto:` at `localhost`. The previous default, `mailto:admin@localhost`, let a Relay boot clean, answer 200 on send, and deliver to no iPhone — the one platform the feature targets.

## Routing

**Why the Burrow cannot lean on the Relay's shape guard.** Trusting the relay's own `isE2eClientFrame` would take a relay-supplied object on faith where that is least acceptable: the routing values it uses as map keys, and the ciphertext it is about to spend WebCrypto on. The relay's copy keeps a bad frame off the wire; the Burrow's exists because the model does not trust the relay.
