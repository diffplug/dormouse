# Network policy and remote transport — rationale

Evidence for `docs/specs/remote-network.md`, keyed by its headings.

## Policy

**Nothing is the default because defaults are for the cautious.** A user who
wants more makes one click; a user who wants less may never find the setting.
The cost is that Standalone stops checking for updates on its own, which the
weekly reminder offsets. An upgraded install with an enrollment keeps its Relay,
because a self-hoster who built for their Relay did choose it, and silently
dropping their phones would read as breakage.

**Three choke points, from the inventory.** A 2026-09-30 sweep of the shipped
desktop code found every background connection behind the Burrow service
(relay, one-time rendezvous, push, the direct path), the managed-voice host, or
the Standalone updater. No telemetry, remote fonts, CDN loaders, or browser
downloads exist.

**Why a Tailscale host route offers the tailnet range.** macOS reports the
tailnet's IPv4 address as a `/32` (measured on macOS 27, 2026-09-30), and
Linux's `tailscale0` carries `/32` and `/128` (not measured here); offered as
reported, allowing the Tailscale row admitted only the laptop's own address,
so the path check refused every phone on the tailnet. Tailscale assigns every node from
`100.64.0.0/10` and `fd7a:115c:a1e0::/48`, so those are what the row means. A
CGNAT address with a real netmask, a hotspot's, keeps its own prefix. Another
VPN's host route stays as reported, since nothing says what range its peers
use; the user adds that range by hand. A CGNAT address alone does not say
Tailscale — Cloudflare WARP assigns devices from `100.96.0.0/12`, and a carrier
link or hotspot can carry one — so the interface needs the tailnet's IPv6
address, which only Tailscale draws from, or Tailscale's name. Once allowed, the
range is still an address range: an address inside it on another interface,
WARP's included, passes the path check as the level's proximity caveat says.

**Why `autoUpdate` alone ends nothing.** The rule that a change ends the live
one-time session exists so a narrowed policy cannot leave an old path exempt.
`autoUpdate` governs no path a phone uses, so ending a phone's session because
the person toggled update checks would cost them the connection and protect
nothing.

## Updates

**The reminder runs with automatic checks on too (2026-09-30).** Standalone
checks only at launch, a terminal app stays open for weeks, and a launch check
fails offline; a reminder gated on automatic checks being off left exactly those
users with neither a check nor a warning. It reads local timestamps alone, so it
needs no policy to run.

## Levels

**Three personas set the levels (2026-09-30).** One wants no network requests at
all; one will try Pocket but only over their LAN or VPN; one wants it to work
anywhere. One choice per persona, with the connections it implies listed beside
it, replaced a transport matrix (persistent vs one-time × restricted vs not)
whose rows the UI never needed to distinguish.

## Local networks

**Why the check is not before approval.** The earlier design verified the path
before the laptop's approval prompt, so an outsider could not raise one. That
needed the offer before `ConnectionOutcomeV1`, a direct path inside the pairing
ceremony, and a new pre-authorization proof. The outsider it stops must already
hold a secret: a one-time link shown on the laptop, or an invitation QR. With
the check at channel open, every guarantee the user sees still holds — no
terminal byte crosses a disallowed path — for none of that protocol.

**Why the selected pair is evidence.** The pair's remote address is the one that
answered ICE connectivity checks under the attempt's ufrag and password, which
reach the peer only inside the session. SDP text, mDNS names, and addresses
Hosted observed are claims; the pair is an observation. `node-datachannel`
0.33.4 exposes it as `getSelectedCandidatePair()` on the native `PeerConnection`
and on the polyfill's `RTCIceTransport`. Unbound, the socket sits on the
unspecified address and the kernel routes each datagram by its destination, so
the pair's local end is the ICE agent's record, not the egress interface; the
remote end inside an allowed range is what holds the path. A route that carries
an allowed range elsewhere — a VPN claiming the LAN's range — is the proximity
caveat again.

**Why a timer as well as the state events.** libjuice, the ICE agent under
`node-datachannel`, makes the first nominated pair in its priority order the
selected one on every bookkeeping pass, and changes state only through a
function that returns early on an unchanged state (`agent_bookkeeping` and
`agent_change_state` in `src/agent.c`, read 2026-09-30): once `completed`, a
pair the controlling phone nominates later carries the session with no event
at all. The polyfill declares `onselectedcandidatepairchange` and never
dispatches it. A one-second re-read bounds how long such a move carries
terminal bytes; it costs one native call a second, only on a held session.

**Why an open connection with no pair is not refused.** libjuice's
`agent_send` returns an error without sending while it has no selected entry
(read 2026-09-30), so a connection reporting no pair carries nothing, and a
pair lost for good fails the connection by its state. Refusing the reading
would end a phone that simply left as `network-not-allowed`, more often with a
re-read every second. Before the open nothing has been sent, so there a missing
pair still refuses.

**Why bind only the single-address case.** `bindAddress` takes one address,
and a policy may allow several networks, so binding narrows the listener only
where exactly one allowed address is present; elsewhere the listener stays as
the security model states it and the path check alone holds the level. The
single case is the common one for the users who care: a person who allows only
their VPN has one interface, and IPv4 is preferred there because a VPN
interface with both families still needs one address, and both shipped Clients
reach IPv4. Probed on `node-datachannel` 0.33.4 (macOS, 2026-09-30): the
polyfill spreads its configuration into the native `PeerConnection`, so
`bindAddress` reaches it; with it the peer binds exactly that address and
advertises one host candidate, without it one socket on `*:port` advertises
every interface in both families.

**The bound path against a real browser** *(2026-09-30, HeadlessChrome 150 on
macOS 27 via `dor agent-browser`, `node-datachannel` 0.33.4 over libdatachannel
0.24.5)*.
`scripts/direct-interop/run.mjs --allow` with the LAN's two prefixes bound
`192.168.86.160`, answered with that one candidate, and carried the three
frames intact. Chrome offered one mDNS host candidate (`<uuid>.local`), and the
addon's selected pair reported `192.168.86.160` → `192.168.86.160`, the remote
end `prflx`: the addon learns the browser's real address from its connectivity
check, so the pair is an IP literal even when every candidate the browser sent
was a name. With the ULA prefix and the tailnet allowed — two interfaces,
unbound — the stripped answer carried two candidates and `c=IN IP4 0.0.0.0`,
Chrome accepted it, and the pair was the ULA address at both ends, again
`prflx`.

## Anywhere

**Why Hosted-served Clients always use STUN.** Hosted runs on Cloudflare, so a
phone that loaded Pocket or the one-time page from `hosted.dormouse.sh` has
already shown Cloudflare its address. STUN to Cloudflare discloses nothing new,
and making it unconditional removes a policy signal from the wire and from
version skew. The Burrow's STUN is what reveals the laptop's public address,
hence the Burrow alone depends on the level.

**The endpoint.** Cloudflare documents `stun:stun.cloudflare.com:3478` as free
and unlimited in its Realtime FAQ; ordinary Workers expose no UDP listener, so
Hosted cannot run its own. Checked 2026-09-30.

## Allowed networks

**Why no UDP forwarder (2026-09-30).** A forwarder narrows the listener where
several addresses are allowed: the peer binds loopback, and one Node UDP socket
per allowed address relays to it, dropping sources outside the allowed networks.
A native-to-native probe connected through one. It was not built because its
cost — a relay socket per outside source, its own lifetime and bounds, and an
answer rewritten to name it — buys narrowing only for a user who allows several
networks, while the person most concerned allows only their VPN, which the
single-address bind already covers.
