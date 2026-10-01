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
| `anywhere` (Anywhere) | Hosted builds | one-time links to any network, Cloudflare STUN as a phone connects, managed voice |
| `relay` (My Relay only) | self-host builds | the relay socket, and push through it |

- **A new install starts at Nothing.** **Must save the default at the service's first read, so it never flips**: `relay` where an enrollment for the baked origin exists — an upgraded self-host install — else `nothing` (rationale). A VS Code window with no service reads the default unsaved.
- **A stored level the build does not offer, or a stored record that is not a policy — an unparseable file included — reads as `nothing`**; the first stays on disk, as an enrollment for another origin does.
- **Until the policy is read, the service reads it as `nothing`**; a read that fails leaves the Burrow down, and `setNetworkPolicy` saves over it.
- **Only `relay` runs the persistent Burrow.** Under any other level an enrollment is held and reported — `enrolled`, `connection: 'stopped'` — and the relay socket stays shut, since no other level has a path rule for a persistent session yet (`## Future`).
- **`setNetworkPolicy` takes a policy only exactly**: its three keys, a level the build offers, at most 32 CIDRs, and a boolean `autoUpdate`. **Must save each CIDR in its canonical form** (`canonicalCidr`), refusing one that does not parse or repeats once canonical, and answer what it saved. **Must save before acting**: a save that fails changes nothing.
- **Must end the live one-time link or session with `user-ended`, and rest an ended one, on a change to the level, or to the allowed networks under `local`, and start or stop the relay socket to match**; a narrowed policy never leaves an old path exempt. **The allowed networks under any other level, and `autoUpdate`, end nothing** (rationale).
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

Source of truth: `holdsToAllowedNetworks` in `lib/src/remote/network-policy.ts`; `bindAddressFor` and `localNetworksPath` in `lib/src/host/remote/local-networks.ts`; `createNativeDirectPeerFactory` in `lib/src/host/remote/native-direct-peer.ts`; `DirectPathPolicy` and `DirectPeer` in `lib/src/remote/direct/direct-peer.ts`; `DirectEndpoint` in `lib/src/remote/direct/direct-endpoint.ts`; `OneTimeRuntime` in `lib/src/remote/burrow/one-time-runtime.ts`; `BurrowService` in `lib/src/host/remote/service.ts`. Pinned by `lib/src/host/remote/local-networks.test.ts`, `lib/src/remote/direct/direct-peer.test.ts`, `lib/src/remote/burrow/one-time-runtime.test.ts`, `lib/src/host/remote/service.test.ts`, and on the real addon `lib/src/host/remote/native-direct-peer.test.ts`; against a browser by hand, `scripts/direct-interop/run.mjs --allow` (rationale).

## Anywhere

Under `anywhere` a one-time link opens with no network allowed, and its attempt carries no path policy: its socket binds every interface, and no pair is refused.

- **Must gather through Cloudflare STUN on the Burrow under Anywhere alone**, else through no ICE server (rationale).
- **Must choose a runtime's STUN and its path policy together, from the policy it opens or starts under**, and hold both for its life: a change to either ends it ("Policy").
- **Clients Hosted serves must always gather through Cloudflare STUN; Clients a self-host Relay serves, through none.** No policy crosses the wire, and a Client's extra candidates cannot widen Local networks, whose Burrow checks the path (rationale).
- **Never TURN** (direct-only: `docs/specs/one-time.md` -> "Burrow runtime"; rationale).
- **Never proxy STUN over an HTTP or WebSocket endpoint**; only STUN on the WebRTC socket observes its mapping.

Source of truth: `CLOUDFLARE_STUN_URL` and `stunServers` in `lib/src/remote/direct/ice-servers.ts`; `burrowUsesStun` in `lib/src/remote/network-policy.ts`; `directPeeringFor` in `lib/src/host/remote/direct-peering.ts`; `BurrowDirectPeerFactory` and `createNativeDirectPeerFactory` in `lib/src/host/remote/native-direct-peer.ts`; `hostedDirectPeer` and `selfHostDirectPeer` in `lib/src/remote/client/browser-direct-peer.ts`. Pinned by `lib/src/host/remote/service.test.ts`, `lib/src/remote/client/browser-direct-peer.test.ts`, and on the real addon `lib/src/host/remote/native-direct-peer.test.ts`; by hand, `scripts/direct-interop/run.mjs --stun` (rationale); audited at `docs/specs/security-remote.md` -> "Direct path".

## Updates

- **The Standalone updater must check automatically only when the level is not `nothing` and `autoUpdate` is on**, reading the policy at launch; **a read that fails counts as `nothing`**. **Check now** always checks, being a click.
- **Must remind in the Baseboard once the last successful check is 7 days old, and at most once per 7 days**, automatic checks on or off (rationale). Before any check, the clock starts at the first launch. The reminder reads local timestamps and contacts nothing.
- **Never in a self-host build or VS Code**, which have no updater.

The lifecycle is `docs/specs/auto-update.md` → "How it works". Source of truth: `runUpdateCheck`, `remindIfDue`, and `checkNow` in `standalone/src/updater.ts`, pinned by `standalone/src/updater.test.ts`.

## Settings → Network

The Settings dialog's Network topic (`docs/specs/alert.md` -> "Settings dialog") holds three search groups: the choice, with its connection list and allowed networks; Phones; and Updates.

- **Renders nothing without a Burrow service**, which holds the policy.
- **Never keep a draft**: every change sends a whole policy through `setNetworkPolicy`, and the panel renders the store's mirror of the answer; a refusal shows where the change was made. **Must make each change from the service's latest answer, one at a time** (`changeNetworkPolicy`).
- **Offer the service's `levels`, in its order**, `relay` titled "My Relay only".
- **Choosing Local networks with nothing allowed must first allow every prefix of this machine's `lan` interfaces**, never a `vpn` or `virtual` one; the panel fills them, not the service (rationale). **Any other choice must keep `allowed`.**
- **The connection list states only what is built** (rationale): `connectionsFor` answers these rows and no others. Under `nothing` it answers none, and the list reads "Nothing. Terminals and browser panes still reach whatever you open in them, including panes restored at launch."

| Row | Listed when |
|---|---|
| the relay origin: only while a one-time link is open, handshakes and never terminal traffic | `opensOneTimeLinks` (`local`, a network allowed; `anywhere`) |
| `stun.cloudflare.com`, as a phone connects | `burrowUsesStun` (`anywhere`) |
| your phone, on any network where `phoneOnAnyNetwork` (`anywhere`), else an allowed one | `opensOneTimeLinks` |
| the Relay origin: always (unenrolled, "once this computer is enrolled") | `relay` |
| your phone, directly | `relay` |
| the Relay origin to the phone's push service, "where push is on" | `relay`, a phone paired (rationale) |
| `voice.dormouse.sh`, speaking in the managed voice | a Hosted build, a voice token saved |
| `dormouse.sh`, each launch | `autoUpdate` on, in a build that updates itself ("Updates" below), in every window |

- **Allowed networks**, under `local`: one switch per interface, on when all its prefixes are allowed. **Must list every allowed range no switch reading On covers**, with Remove, naming the interface a partly allowed one belongs to; **switching one off keeps a range another switch reading On needs**. A typed range goes to the service, which saves its canonical form; more than 32 is refused in the panel. **With nothing allowed it says no phone can connect.**
- **Phones**: under any level but `nothing`, the Remote control choices (`docs/specs/relay.md` -> "Remote control, in the Settings dialog"); under `nothing`, the levels that allow a phone, each choosing itself, and Disconnect for a held enrollment, which is local.
- **Updates**: a self-host build says it never updates itself, and a host with `hostOwnsUpdates` (VS Code) names the Marketplace. Any other build updates itself: the automatic-check switch, absent under `nothing`, over "Checked at each launch." or "Checked only when you ask."; **only with the platform's `updates` port** (`docs/specs/auto-update.md` -> "Threading") the last successful check — "Never checked on this computer." for none — Check now, and the week the Baseboard waits.
- **Under `nothing`, Notifications' push and managed-voice lines say they are off because Network is set to Nothing**, each linking to this topic. **The Baseboard holds the policy store for the window's life**, so its settings preview reads the level on its first frame; the Network panel re-reads on mount, and **a failed re-read never replaces a policy already read**.

Source of truth: `NetworkSettings`, `NetworkPhones`, `NetworkUpdates`, `connectionsFor`, and `policyForLevel` in `lib/src/components/NetworkSettings.tsx`; `opensOneTimeLinks`, `burrowUsesStun`, `phoneOnAnyNetwork`, and `holdsToAllowedNetworks` in `lib/src/remote/network-policy.ts`; `changeNetworkPolicy` in `lib/src/remote/burrow/network-policy-store.ts`; `AlarmSettingsSection` in `lib/src/components/SettingsDialog.tsx`; `Baseboard` in `lib/src/components/Baseboard.tsx`. Pinned by `lib/src/components/NetworkSettings.test.tsx`, `lib/src/components/SettingsDialog.test.tsx`, `lib/src/components/Baseboard.test.tsx`, and `lib/src/stories/NetworkSettings.stories.tsx`.

## Future

**Scope: remote-network** — build in order:

1. **Anywhere on a phone**: **Must measure iOS Safari's offer size and gathering time, and the Burrow with STUN blocked**, before changing a budget.
2. **Hosted persistent**: desktop enrollment, the Hosted Relay's sockets, and push, beyond its routes in `docs/specs/hosted.md` -> "Relay" and "Burrow enrollment", with **saas-multitenant** in `docs/specs/relay.md`, its connections in `connectionsFor`; Local networks and Anywhere then cover paired phones.

### Allowed networks

- **Where several addresses are allowed, a per-attempt UDP forwarder may narrow the listener** (rationale): the peer binds loopback, one socket per allowed address relays to it, dropping sources outside the allowed networks, and the answer names those sockets.

### Hosted persistent

- **Must route account-scoped Relay sockets through Durable Objects**, keyed per Burrow, preserving bounded opaque frames and tenant isolation; Hosted login never authorizes a terminal.
- **Must use WebSocket hibernation**, rebuilding routing from attachments and durable metadata, and never store terminal ciphertext.
- **Under Local networks a paired phone's session is direct-only**, with the one-time rule: an application message off the Relay ends it unread. **May fall back to Hosted relaying under Anywhere.**
- **Must choose Pocket's direct-peer factory by deployment** ("Anywhere"), one bundle serving both; `lib/src/remote/pocket-app/App.tsx` hard-codes `selfHostDirectPeer`.
- **Must start `BurrowRuntime` on the level's `directPeeringFor`, restarting it on any change `samePaths` sees** ("Anywhere").
- **Must accept sealed push independently of terminal transport**, under `docs/specs/remote-security-model.md` -> "Push sealing".
- **Must enroll a Hosted build's Burrow by device code from the service** (`docs/specs/hosted.md` -> "Burrow enrollment"): begin and poll every `interval`, validate the begin answer, show the user code, and stop on `NOT_ENTITLED_ERROR`. The Burrow composes the verification URL itself from `ENROLL_PAGE_PATH` and the user code, never trusting the Relay's `verificationUrl`, and opens it only on the user's click and only at `https://hosted.dormouse.sh` in a release Hosted build; a dev Hosted build may follow the `verificationUrl` origin, as `DORMOUSE_RELAY_IS_HOSTED` relaxes the relay origin. `isEnrollment` in `lib/src/remote/burrow/enrollment.ts` stays the one guard of the enrollment shape.
- **Never enroll Hosted into a customer's tailnet** or mint per-customer hostnames.
