# Network policy and remote transport

> See `docs/specs/glossary.md` for Burrow, Client, Relay, and Session vocabulary.
> Owns the network policy — the one setting that decides every connection Dormouse opens on its own — and the transport each level allows. Authorization belongs to `docs/specs/remote-security-model.md`, the wire to `docs/specs/remote-api.md`, the one-time runtime to `docs/specs/one-time.md`, and the updater to `docs/specs/auto-update.md`.
> Read `docs/specs/remote-security-model.md` -> "Direct path" first.

## Policy

**The policy is one record, `{ level, allowed, autoUpdate }`, held host-side** in the Burrow state store beside the enrollment: `network` in the sidecar's `burrow.json`, `dormouse.burrow.network-policy` in VS Code's `globalState`. **Never take it from a Client, Relay, or Hosted response**; the webview reads it with `networkPolicy` and writes it with `setNetworkPolicy`, and the Burrow service is its only writer.

| Level | Offered in | What Dormouse opens on its own |
|---|---|---|
| `nothing` | every build | nothing |
| `local` (Local networks) | Hosted builds | one-time links, managed voice |
| `relay` (My Relay only) | self-host builds | the relay socket, and push through it |

Reserved: `anywhere`, which the policy's shape accepts and no build offers, is the Anywhere level (`## Future`).

- **A new install starts at Nothing.** **Must save the default at the service's first read, so it never flips**: `relay` where an enrollment for the baked origin exists — an upgraded self-host install — else `nothing` (rationale). A VS Code window with no service reads the default unsaved.
- **A stored level the build does not offer, or a stored record that is not a policy, reads as `nothing`**; the first stays on disk, as an enrollment for another origin does.
- **Until the policy is read, the service reads it as `nothing`**; a read that fails leaves the Burrow down.
- **`setNetworkPolicy` takes a policy only exactly**: its three keys, a level the build offers, at most 32 canonical CIDRs (`canonicalCidr` returns each unchanged) listed once, and a boolean `autoUpdate`. **Must save before acting**: a save that fails changes nothing.
- **A change to the level or the allowed networks ends the live one-time link or session with `user-ended`, and starts or stops the relay socket to match**; a narrowed policy never leaves an old path exempt. `autoUpdate` alone ends nothing (rationale).
- **Every change is a `network-policy` event** carrying what `networkPolicy` answers: the policy, the build's levels, and this machine's interfaces, each with its addresses' canonical prefixes (loopback and IPv6 link-local left out) and a `lan`, `vpn`, or `virtual` kind.

**Must enforce the policy at its choke points** — the Burrow service, the managed-voice host, and the updater (`## Future`); **a new outbound path adds one here before it ships** (rationale). What the user clicks, and what their terminals, browser panes, and agents reach, are their own connections. **Nothing opens nothing**:

- **The Burrow service never opens the relay socket.** An enrollment is held and reported — `enrolled`, `connection: 'stopped'`, not `serving` — so push, the device list, a test push, and setup codes, which need a running Burrow, make no request.
- **It refuses `enroll` and `enrollOffer` before any request**, the offer file unread.
- **It offers no one-time link**: the resting state is `unavailable` with reason `network-off`, and `oneTimeOpen` is refused, as under `local` with no network allowed.
- **Managed voice asks the service before every speak** and answers `network-off` without a request.

Source of truth: `NetworkPolicy`, `levelsFor`, and `storedNetworkPolicy` in `lib/src/remote/network-policy.ts`; `peekNetworkPolicyFor` and `BurrowService` in `lib/src/host/remote/service.ts`; `canonicalCidr`, `addressAllowed`, and `classifyNetworkInterfaces` in `lib/src/host/remote/network-interfaces.ts`; `NETWORK_POLICY_KEY` in `vscode-ext/src/burrow-store.ts`; `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts`; `subscribeToNetworkPolicy` in `lib/src/remote/burrow/network-policy-store.ts`. Pinned by `lib/src/host/remote/service.test.ts` and `lib/src/host/remote/network-interfaces.test.ts`.

## Future

**Scope: remote-network** — build in order:

1. **Policy and Nothing**: the updater's choke point and the update reminder ("Updates"), then Settings → Network.
2. **Local networks**: the path check, for one-time sessions.
3. **Anywhere**: Cloudflare STUN, for one-time sessions.
4. **Hosted persistent**: the Hosted Relay and push, with **saas-multitenant** in `docs/specs/relay.md`; Local networks and Anywhere then cover paired phones.

The UI contract is the prototype `NetworkSettings` in `lib/src/components/NetworkSettings.tsx` (story `Prototypes/NetworkSettings`); its `connectionsFor` list is this table in the user's words, and each stage changes the two together.

### Levels

| Level | Offered in | Burrow ICE servers | Relayed terminal traffic | Direct path must be on |
|---|---|---|---|---|
| Nothing | every build | — (no session) | — | — |
| Local networks | Hosted builds | none | never | an allowed network |
| Anywhere | Hosted builds | `stun:stun.cloudflare.com:3478` | paired phones only, via Hosted | any network |
| My Relay only | self-host builds | none | via the baked Relay | any network |

### Updates

- **Must check automatically only when the level is not Nothing and `autoUpdate` is on**, at launch as today; **Check now** always checks, being a click.
- **With automatic checks off, must remind in the Baseboard once the last successful check is 7 days old, and at most once per 7 days.** A fresh install's clock starts at install. The reminder reads local timestamps and contacts nothing.
- **Never in a self-host build or VS Code**, which have no updater (`docs/specs/auto-update.md`).

### Local networks

- **Choosing Local networks must first allow every prefix, both families, of the active LAN interface**; a VPN, bridge, container, or VM interface is never allowed by default.
- **Must check the selected candidate pair on the Burrow before its channel reports open**: both ends parse as IP addresses, IPv4-mapped IPv6 unwrapped, each inside an allowed CIDR. A hostname, an mDNS name, or a missing pair refuses. Must re-check on every ICE state change while connected; a violation disposes the session.
- **The check gates terminal traffic, not approval** (rationale): an off-network phone holding a link can reach the two-digit prompt and still receives no terminal byte.
- **Never trust SDP candidates, Hosted-observed addresses, or Client claims** as path evidence; only the Burrow's own ICE agent answers.
- **Must strip candidates outside the allowed networks from the Burrow's answer.**
- **Allowed networks restrict the path, not the listener**: the attempt's UDP socket still answers on every interface (`docs/specs/remote-security-model.md` -> "Direct path"). Never describe the level as a listener restriction, or as proof of proximity — a range is an address range, which another network can reuse, and a permitted peer can forward.

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
