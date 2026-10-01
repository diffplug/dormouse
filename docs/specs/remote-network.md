# Network policy and remote transport

> See `docs/specs/glossary.md` for Burrow, Client, Relay, and Session vocabulary.
> Owns the network policy — the one setting that decides every connection Dormouse opens on its own — the transport each level allows, and Settings → Network, where it is chosen. Authorization belongs to `docs/specs/remote-security-model.md`, the wire to `docs/specs/remote-api.md`, the one-time runtime to `docs/specs/one-time.md`, and the updater to `docs/specs/auto-update.md`.
> Read `docs/specs/remote-security-model.md` -> "Direct path" first.

## Policy

**The policy is one record, `{ level, allowed, autoUpdate }`, held host-side** in the Burrow state store: `dormouse.burrow.network-policy` in VS Code's `globalState`, and the sidecar's own `network-policy.json`, 0600 beside `burrow.json`. **Never keep it in `burrow.json`**, which a build from before the policy rewrites without it, letting the default recompute. **Never take it from a Client, Relay, or Hosted response**; the webview reads it with `networkPolicy` and writes it with `setNetworkPolicy`, and the Burrow service is its only writer.

| Level | Offered in | What Dormouse opens on its own |
|---|---|---|
| `nothing` | every build | nothing |
| `local` (Local networks) | Hosted builds | one-time links, managed voice |
| `relay` (My Relay only) | self-host builds | the relay socket, and push through it |

Reserved: `anywhere`, which the policy's shape accepts and no build offers, is the Anywhere level (`## Future`).

- **A new install starts at Nothing.** **Must save the default at the service's first read, so it never flips**: `relay` where an enrollment for the baked origin exists — an upgraded self-host install — else `nothing` (rationale). A VS Code window with no service reads the default unsaved.
- **A stored level the build does not offer, or a stored record that is not a policy — an unparseable file included — reads as `nothing`**; the first stays on disk, as an enrollment for another origin does.
- **Until the policy is read, the service reads it as `nothing`**; a read that fails leaves the Burrow down, and `setNetworkPolicy` saves over it.
- **Only `relay` runs the persistent Burrow.** Under any other level an enrollment is held and reported — `enrolled`, `connection: 'stopped'` — and the relay socket stays shut, since no other level has a path rule for a persistent session yet (`## Future`).
- **`setNetworkPolicy` takes a policy only exactly**: its three keys, a level the build offers, at most 32 CIDRs, and a boolean `autoUpdate`. **Must save each CIDR in its canonical form** (`canonicalCidr`), refusing one that does not parse or repeats once canonical, and answer what it saved. **Must save before acting**: a save that fails changes nothing.
- **A change to the level or the allowed networks ends the live one-time link or session with `user-ended`, and starts or stops the relay socket to match**; a narrowed policy never leaves an old path exempt. `autoUpdate` alone ends nothing (rationale).
- **Every change is a `network-policy` event** carrying what `networkPolicy` answers: the policy, the build's levels, and this machine's interfaces, each with its addresses' canonical prefixes (loopback and link-local, `169.254.0.0/16` included, left out) and a `lan`, `vpn`, or `virtual` kind. **A Tailscale interface — named `tailscale*`, or carrying an `fd7a:115c:a1e0::/48` address — offers a host route as its tailnet range**, `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, since a `/32` admits no phone; any other host route is offered as reported (rationale).

**Must enforce the policy at its choke points** — the Burrow service, the managed-voice host, and the updater ("Updates"); **a new outbound path adds one here before it ships** (rationale). What the user clicks, and what their terminals, browser panes, and agents reach, are their own connections. **Nothing opens nothing**:

- **The Burrow service's socket factory, fetch, and direct-peer factory refuse at the call while the level is `nothing` or unread, and once the service is disposed** — the socket factory throws (a runtime reads it as a closed socket), fetch rejects, the peer factory answers `null` — so a path that forgets its own check still opens nothing. Everything the service opens, the enrollment exchange included, goes through them; the checks below stay, for the error a person reads.
- **The Burrow service never opens the relay socket**, the enrollment held as above, so push, the device list, a test push, and setup codes, which need a running Burrow, make no request.
- **It refuses `enroll` and `enrollOffer` before any request**, the offer file unread.
- **It offers no one-time link**: the resting state is `unavailable` with reason `network-off`, and `oneTimeOpen` is refused, as under `local` with no network allowed.
- **Managed voice asks the service before every speak** and answers `network-off` without a request.

Source of truth: `NetworkPolicy`, `levelsFor`, and `storedNetworkPolicy` in `lib/src/remote/network-policy.ts`; `peekNetworkPolicyFor` and `BurrowService` in `lib/src/host/remote/service.ts`; `canonicalCidr`, `allowedAddressTest`, and `classifyNetworkInterfaces` in `lib/src/host/remote/network-interfaces.ts`; `NETWORK_POLICY_KEY` in `vscode-ext/src/burrow-store.ts`; `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts`; `subscribeToNetworkPolicy` in `lib/src/remote/burrow/network-policy-store.ts`. Pinned by `lib/src/host/remote/service.test.ts` and `lib/src/host/remote/network-interfaces.test.ts`.

## Local networks

Under `local` each one-time runtime is held to the networks allowed at its open; a change ends it ("Policy").

- **The attempt's UDP socket binds the one allowed address when exactly one is present**: a single interface holds every address in the allowed networks, loopback and link-local aside, and exactly one in its preferred family, IPv4 over IPv6. **Otherwise it listens on every interface** (`docs/specs/remote-security-model.md` -> "Direct path"), and the level restricts the path, not the listener. Chosen per attempt (rationale).
- **Must strip every candidate outside the allowed networks from the Burrow's answer**, and send a default address outside them as `0.0.0.0`. **An answer left with no candidate refuses the attempt.**
- **Must strip the phone's offer the same way before the Burrow applies it**, a hostname or mDNS name included, so its ICE agent sends no check and makes no lookup toward an address the level does not hold. **An offer left with no candidate is still answered**: the phone's checks reach the answer's candidates, and the pair forms peer-reflexive (rationale).
- **Must check the selected candidate pair on the Burrow before its channel reports open**, and again while it is open and `connected` — on every ICE or connection state change, and every `DIRECT_PATH_RECHECK_MS` (rationale): both ends parse as IP addresses — IPv4-mapped IPv6 matching its IPv4 range — each inside an allowed CIDR. **A hostname, an mDNS name, or a pair the stack will not report refuses**, and a frame arriving before the open is checked first; once open, a reading with no pair is left to the connection's own state (rationale).
- **Never trust SDP candidates, Hosted-observed addresses, or Client claims** as path evidence; only the Burrow's own ICE agent answers (rationale).
- **A refusal is a violation**: it ends the connection `network-not-allowed` (`docs/specs/one-time.md` -> "Burrow runtime"), switched or not.
- **The check gates terminal traffic, not approval** (rationale): an off-network phone holding a link can reach the two-digit prompt and still receives no terminal byte.
- **Never describe the level as proof of proximity** — a range is an address range, which another network can reuse, and a permitted peer can forward.

Source of truth: `bindAddressFor` and `localNetworksPath` in `lib/src/host/remote/local-networks.ts`; `createNativeDirectPeerFactory` in `lib/src/host/remote/native-direct-peer.ts`; `DirectPathPolicy` and `DirectPeer` in `lib/src/remote/direct/direct-peer.ts`; `DirectEndpoint` in `lib/src/remote/direct/direct-endpoint.ts`; `OneTimeRuntime` in `lib/src/remote/burrow/one-time-runtime.ts`; `BurrowService` in `lib/src/host/remote/service.ts`. Pinned by `lib/src/host/remote/local-networks.test.ts`, `lib/src/remote/direct/direct-peer.test.ts`, `lib/src/remote/burrow/one-time-runtime.test.ts`, `lib/src/host/remote/service.test.ts`, and on the real addon `lib/src/host/remote/native-direct-peer.test.ts`; against a browser by hand, `scripts/direct-interop/run.mjs --allow` (rationale).

## Updates

- **The Standalone updater must check automatically only when the level is not `nothing` and `autoUpdate` is on**, reading the policy at launch; **a read that fails counts as `nothing`**. **Check now** always checks, being a click.
- **Must remind in the Baseboard once the last successful check is 7 days old, and at most once per 7 days**, automatic checks on or off (rationale). Before any check, the clock starts at the first launch. The reminder reads local timestamps and contacts nothing.
- **Never in a self-host build or VS Code**, which have no updater.

The lifecycle is `docs/specs/auto-update.md` → "How it works". Source of truth: `runUpdateCheck`, `remindIfDue`, and `checkNow` in `standalone/src/updater.ts`, pinned by `standalone/src/updater.test.ts`.

## Settings → Network

The Settings dialog's Network topic (`docs/specs/alert.md` -> "Settings dialog") holds three search groups: the choice, with its connection list and allowed networks; Phones; and Updates.

- **Renders nothing without a Burrow service**, which holds the policy.
- **Never keep a draft**: every change sends a whole policy through `setNetworkPolicy`, and the panel renders the store's mirror of the answer; a refusal shows where the change was made. **Must make each change from the service's latest answer, one at a time** (`changeNetworkPolicy`).
- **Offer the service's `levels`, in its order**, `relay` titled "My Relay only"; a level the panel has no copy for — `anywhere` — is not offered.
- **Choosing Local networks with nothing allowed must first allow every prefix of this machine's `lan` interfaces**, never a `vpn` or `virtual` one; the panel fills them, not the service (rationale).
- **The connection list states only what is built** (rationale): `connectionsFor` answers these rows and no others. Under `nothing` it answers none, and the list reads "Nothing. Terminals and browser panes still reach whatever you open in them, including panes restored at launch."

| Row | Listed when |
|---|---|
| the Hosted origin: only while a one-time link is open, handshakes and never terminal traffic | `local`, a network allowed |
| your phone, on an allowed network | `local`, a network allowed |
| the Relay origin: always (unenrolled, "once this computer is enrolled") | `relay` |
| your phone, directly | `relay` |
| the Relay origin to the phone's push service, "where push is on" | `relay`, a phone paired (rationale) |
| the Hosted origin, speaking in the managed voice | a Hosted build, a voice token saved |
| `dormouse.sh`, each launch | `autoUpdate` on, in a build that updates itself ("Updates" below), in every window |

- **Allowed networks**, under `local`: one switch per interface, on when all its prefixes are allowed. **Must list every allowed range no switch reading On covers**, with Remove, naming the interface a partly allowed one belongs to; **switching one off keeps a range another switch reading On needs**. A typed range goes to the service, which saves its canonical form; more than 32 is refused in the panel. **With nothing allowed it says no phone can connect.**
- **Phones**: under any level but `nothing`, the Remote control choices (`docs/specs/relay.md` -> "Remote control, in the Settings dialog"); under `nothing`, the levels that allow a phone, each choosing itself, and Disconnect for a held enrollment, which is local.
- **Updates**: a self-host build says it never updates itself, and a host with `hostOwnsUpdates` (VS Code) names the Marketplace. Any other build updates itself: the automatic-check switch, absent under `nothing`, over "Checked at each launch." or "Checked only when you ask."; **only with the platform's `updates` port** (`docs/specs/auto-update.md` -> "Threading") the last successful check — "Never checked on this computer." for none — Check now, and the week the Baseboard waits.
- **Under `nothing`, Notifications' push and managed-voice lines say they are off because Network is set to Nothing**, each linking to this topic. **The Baseboard holds the policy store for the window's life**, so its settings preview reads the level on its first frame; the Network panel re-reads on mount, and **a failed re-read never replaces a policy already read**.

Source of truth: `NetworkSettings`, `NetworkPhones`, `NetworkUpdates`, `connectionsFor`, and `policyForLevel` in `lib/src/components/NetworkSettings.tsx`; `changeNetworkPolicy` in `lib/src/remote/burrow/network-policy-store.ts`; `AlarmSettingsSection` in `lib/src/components/SettingsDialog.tsx`; `Baseboard` in `lib/src/components/Baseboard.tsx`. Pinned by `lib/src/components/NetworkSettings.test.tsx`, `lib/src/components/SettingsDialog.test.tsx`, `lib/src/components/Baseboard.test.tsx`, and `lib/src/stories/NetworkSettings.stories.tsx`.

## Future

**Scope: remote-network** — build in order:

1. **Anywhere**: Cloudflare STUN, for one-time sessions.
2. **Hosted persistent**: the Hosted Relay and push, with **saas-multitenant** in `docs/specs/relay.md`; Local networks and Anywhere then cover paired phones.

Each stage adds its connections to `connectionsFor` (Settings → Network) in the same change as its row of the table below.

### Levels

| Level | Offered in | Burrow ICE servers | Relayed terminal traffic | Direct path must be on |
|---|---|---|---|---|
| Nothing | every build | — (no session) | — | — |
| Local networks | Hosted builds | none | never | an allowed network |
| Anywhere | Hosted builds | `stun:stun.cloudflare.com:3478` | paired phones only, via Hosted | any network |
| My Relay only | self-host builds | none | via the baked Relay | any network |

### Allowed networks

- **Where several addresses are allowed, a per-attempt UDP forwarder may narrow the listener** (rationale): the peer binds loopback, one socket per allowed address relays to it, dropping sources outside the allowed networks, and the answer names those sockets.

### Anywhere

- **Must add STUN on the Burrow only under Anywhere.** **Clients served by Hosted always use Cloudflare STUN** (rationale), so no policy crosses the wire; a Client's extra candidates cannot widen a Local networks session because the Burrow's path check decides. Clients a self-host Relay serves use none.
- **Never TURN.** A one-time session stays direct-only; only a paired phone's session may fall back to Hosted relaying.
- **Must replace the no-ICE-server rule, `scripts/e2e-lint.mjs` and its self-test, and the `docs/specs/security.md` trust base together**, allowing exactly the Cloudflare STUN URL; never delete the check without its replacement.
- **Must validate the shipped browser and native stacks on real networks** — cellular and home Wi-Fi, SDP size against `MAX_DIRECT_SDP_LENGTH`, gathering and setup budgets, STUN failure — before changing a budget.
- **Never proxy STUN over an HTTP or WebSocket endpoint**; it must observe the WebRTC socket's own mapping.

### Hosted persistent

- **Must route account-scoped Relay sockets through Durable Objects**, keyed per Burrow, preserving bounded opaque frames and tenant isolation; Hosted login never authorizes a terminal.
- **Must use WebSocket hibernation**, rebuilding routing from attachments and durable metadata, and never store terminal ciphertext.
- **Under Local networks a paired phone's session is direct-only**, with the one-time rule: an application message off the Relay ends it unread.
- **Must accept sealed push independently of terminal transport**, under `docs/specs/remote-security-model.md` -> "Push sealing".
- **Must resolve the one-origin pin first** (`docs/specs/relay.md` -> "The one-origin pin"): Pocket and the Relay share `hosted.dormouse.sh`, whose root holds the account app.
- **Never enroll Hosted into a customer's tailnet** or mint per-customer hostnames.
