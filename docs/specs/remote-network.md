# Network policy and remote transport

> Status: design — nothing here is implemented yet.
> See `docs/specs/glossary.md` for Burrow, Client, Relay, and Session vocabulary.
> Owns the network policy — the one setting that decides every connection Dormouse opens on its own — and the transport each level allows. Authorization belongs to `docs/specs/remote-security-model.md`, the wire to `docs/specs/remote-api.md`, the one-time runtime to `docs/specs/one-time.md`, and the updater to `docs/specs/auto-update.md`.
> Read `docs/specs/remote-security-model.md` -> "Direct path" first.

## Future

**Scope: remote-network** — build in order:

1. **Policy and Nothing**: the persisted policy, its choke points, Settings → Network, and the update reminder.
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

- **A new install starts at Nothing.** An install upgraded with an enrollment starts at My Relay only, every other at Nothing (rationale).
- **Must hold one policy record host-side**, `{ level, allowed, autoUpdate }`, in the Burrow state store beside the enrollment. The webview reads and writes it through the Burrow service; no Client, Relay, or Hosted response is an input to it.
- **Must enforce it at three choke points**: the Burrow service (relay socket, one-time links, push), the managed-voice host, and the updater. A new outbound path adds a fourth here before it ships.
- **Nothing opens nothing**: no relay socket while enrolled (the enrollment stays), no one-time link, no managed voice, no automatic update check. What the user clicks, and what their terminals, browser panes, and agents reach, are their own connections.
- **A policy change ends every live one-time link and session** with `user-ended`, and starts or stops the relay socket to match; a narrowed policy never leaves an old path exempt.

### Updates

- **Must check automatically only when the level is not Nothing and `autoUpdate` is on**, at launch as today; **Check now** always checks, being a click.
- **With automatic checks off, must remind in the Baseboard once the last successful check is 7 days old, and at most once per 7 days.** A fresh install's clock starts at install. The reminder reads local timestamps and contacts nothing.
- **Never in a self-host build or VS Code**, which have no updater (`docs/specs/auto-update.md`).

### Local networks

- **Must represent allowed networks as canonical IPv4 or IPv6 CIDRs** from the interface's own netmask. Choosing Local networks first allows every prefix, both families, of the active LAN interface; a VPN, bridge, container, or VM interface is never allowed by default.
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
