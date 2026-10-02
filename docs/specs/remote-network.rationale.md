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

**Three personas set the levels (2026-09-30).** One wants no network requests at
all; one will try Pocket but only over their LAN or VPN; one wants it to work
anywhere. One choice per persona, with the connections it implies listed beside
it, replaced a transport matrix (persistent vs one-time × restricted vs not)
whose rows the UI never needed to distinguish.

**Why `autoUpdate`, and the allowed networks outside Local networks, end
nothing.** The rule that a change ends the live one-time session exists so a
narrowed policy cannot leave an old path exempt. `autoUpdate` governs no path a
phone uses, and the allowed networks govern one only under Local networks, so
ending a phone's session because the person toggled update checks, or edited a
list that Anywhere never reads, would cost them the connection and protect
nothing.

## Updates

**The reminder runs with automatic checks on too (2026-09-30).** Standalone
checks only at launch, a terminal app stays open for weeks, and a launch check
fails offline; a reminder gated on automatic checks being off left exactly those
users with neither a check nor a warning. It reads local timestamps alone, so it
needs no policy to run.

## Settings → Network

**Why the list states only what is built (2026-09-30).** The list is what a
person reads to decide which level to trust, so a row for unbuilt behavior
promises traffic that never happens, and a missing row hides one that does.
The 2026-09-30 prototype listed the whole design; `connectionsFor` now derives
rows from the shipped policy and runtime facts, including Hosted enrollment.

**Why the push row names its condition (2026-09-30).** Push is on by the
application default or by any Workspace's own override, and Workspaces in other
windows are out of the panel's reach, so a row keyed on the default alone
omitted a push the code sends. Listed whenever a phone is paired, the row's
"where push is on" is true however push was turned on.

**Why the panel fills the LAN prefixes.** `setNetworkPolicy` takes a policy
only exactly and answers what it saved; filling in networks there would save
something the request did not say. The panel already holds the interfaces the
person is looking at, and the switches show at once what was allowed.

## Local networks

**Why the check is not before approval.** The earlier design verified the path
before the laptop's approval prompt, so an outsider could not raise one. That
needed the offer before `ConnectionOutcomeV1`, a direct path inside the pairing
ceremony, and a new pre-authorization proof. The outsider it stops must already
hold a secret: a one-time link shown on the laptop, or an invitation QR. With
the check at channel open, every guarantee the user sees still holds — no
terminal byte crosses a disallowed path — for none of that protocol.

**Why the code still comes first (Ned, 2026-10-01).** Failing a wrong-network
phone before the two-digit prompt was weighed again, so pairing could double as
the connection test. Only the Burrow's ICE agent can judge the path — browsers
hide their addresses behind mDNS, and the Relay sees only public IPs — so the
check would run ICE and DTLS with a phone nobody has approved, for anyone
holding the QR or link, and hand that holder the laptop's addresses: the
allowed-network ones under Local networks, the STUN-learned public IP under
Anywhere. With the code first, a grabbed QR or link yields the Relay's address
and the Burrow id, nothing more, unless the person at the laptop types its
digits. The phone learns at its first session instead, from a message naming the
address the laptop saw.

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

**Why a reported address is named, and never decides.** A phone on cellular
forms no pair: the Burrow strips every candidate it offers and answers with
allowed addresses the phone cannot reach, so the attempt gives up with nothing
observed — the common case Ned hit testing the one-time preview (2026-10-01).
The phone's offer still carries its server-reflexive candidate, the public
address Cloudflare STUN saw, and naming it tells the person at the laptop
"that was a carrier, not your Wi-Fi". But the offer is the phone's own text,
written before any check answered, so it is shown as what the phone reported
and read by nothing that decides. Only a pair the policy refused is named as
where the phone connected from: an allowed pair that never carried a channel
is no evidence of the network the phone was on.

**Why a refusal says which end (review, 2026-10-01).** A laptop that left its
allowed networks — off the home Wi-Fi, a VPN down — gets its pair's local end
refused while the phone sits on the right network; naming the phone's address
then told the person at the laptop the phone was at fault, and told the phone
to join a network it was already on. The local end is checked first, since a
phone's address says nothing while the laptop is itself off the networks. A
reported address is read outside the allowed networks only, since one inside
them is no reason for a refusal, and its copy never asserts it is off them: the
phone's offer is a claim, and an allowed range can be public.

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

**Stripping the offer against a real browser** *(2026-09-30, HeadlessChrome 150
on macOS 27 via `dor agent-browser`, `node-datachannel` 0.33.4 over
libdatachannel 0.24.5)*. `scripts/direct-interop/run.mjs --allow
192.168.86.0/24` with the offer stripped: Chrome offered one mDNS candidate,
the Burrow applied none, bound `192.168.86.160`, and answered with that one
candidate. The pair formed from Chrome's own checks — local `host`
`192.168.86.160`, remote `prflx` `192.168.86.160` — and the three frames came
back intact. So an offer stripped to nothing costs no connection, and
`native-direct-peer.test.ts` pins the same open on the addon alone.

## Anywhere

**Why no ICE server outside Anywhere, and never TURN.** A STUN server learns the
public address of each end that asks it, and the fact of a session, from a
party neither endpoint chose. The self-host deployment is a tailnet, where host
candidates reach on both ends — the Burrow's tailnet address is one the phone
can route to, and the phone's mDNS-obfuscated candidate is learned
peer-reflexively from its first check — so there a server buys connectivity
that is already there. A STUN answer is unauthenticated, and the worst a false
one does is advertise a candidate that never connects: the session's ciphers
decide what rides the channel, not the address. A TURN server would learn the
traffic pattern and carry the ciphertext, exactly the position the Relay
already holds and the security model treats as untrusted, and a one-time
session is direct-only by design, so it never needs one.

**Why Hosted-served Clients always use STUN.** Hosted runs on Cloudflare, so a
phone that loaded Pocket or the one-time page from `relay.dormouse.sh` has
already shown Cloudflare its address. STUN to Cloudflare discloses nothing new,
and making it unconditional removes a policy signal from the wire and from
version skew. The Burrow's STUN is what reveals the laptop's public address,
hence the Burrow alone depends on the level. The cost falls on Local networks,
whose phone gathers a srflx it cannot use: with the grace its attempt opened at
0.59 s against 0.22 s with no STUN (2026-09-30, `remote-api.rationale.md` ->
"Direct path"), and on a network that drops UDP 3478 its offer waits the whole
3 s `DIRECT_GATHER_TIMEOUT_MS`.

**On a real phone** *(2026-10-01, iPhone 15 Pro, iOS Safari, against PR #865's Hosted preview; laptop on home Wi-Fi, macOS 27, innerdogfood)*. Under Anywhere, the phone on Verizon cellular with Wi-Fi and Tailscale off connected directly and felt instant from the confirmation, as did the phone on the same home Wi-Fi; typed and pasted input arrived intact. Under Local networks with only the home Wi-Fi allowed, the phone on cellular never reached a terminal: the attempt ended `direct-failed` about 5 s after the confirmation (Burrow log: the direct channel did not open in time), because both ends' candidates outside the allowed network were stripped and no pair formed, so the page's STUN did not widen the level. Not yet measured on the phone: its offer size and gathering time, and a Burrow whose STUN is blocked.

**The endpoint.** Cloudflare documents `stun:stun.cloudflare.com:3478` as free
and unlimited in its Realtime FAQ; ordinary Workers expose no UDP listener, so
Hosted cannot run its own. Checked 2026-09-30.

**What STUN adds** *(2026-09-30, macOS 27, HeadlessChrome 150 against
`node-datachannel` 0.33.4 / libdatachannel 0.24.5 / libjuice 1.7.2,
`scripts/direct-interop/run.mjs --stun`)*.
- One `srflx` per end. Chrome's offer grew from 587 to 720 characters (one mDNS
  host, one srflx), the Burrow's answer from 759 to 843 (four host, one srflx).
  libjuice completed gathering in 57–84 ms, against 13–21 ms with none.
  Chrome's settle, and the ceiling on the answer: `remote-api.rationale.md` ->
  "Direct path".
- Every run selected host↔prflx on the LAN, never srflx, which on one machine
  would need router hairpinning. The two ends named different pairs (the addon
  an IPv6 ULA one, Chrome an IPv4 one), harmless where no path is checked.
  Under `--allow … --stun` the Burrow stripped the page's srflx and the pair
  stayed on the allowed LAN.

**When STUN goes unanswered** *(same setup, `--stun-blackhole`: both factories
pointed at TEST-NET-1)*. Uncapped, libjuice gives up after 23.5 s
(`MAX_STUN_SERVER_RETRANSMISSION_COUNT`) and Chrome later still
(`remote-api.rationale.md` -> "Direct path"), so `DIRECT_GATHER_TIMEOUT_MS` is
what bounds the attempt. Capped, each end sent its host candidates at 3.0 s and
the attempt opened at 6.07–6.08 s on the offerer and 3.07 s on the answerer,
inside every setup budget. Across a NAT that answer carries no srflx, so the
phone has nothing to reach: a reachability failure, not a budget one.

## Allowed networks

**Why no UDP forwarder (2026-09-30).** A forwarder narrows the listener where
several addresses are allowed: the peer binds loopback, and one Node UDP socket
per allowed address relays to it, dropping sources outside the allowed networks.
A native-to-native probe connected through one. It was not built because its
cost — a relay socket per outside source, its own lifetime and bounds, and an
answer rewritten to name it — buys narrowing only for a user who allows several
networks, while the person most concerned allows only their VPN, which the
single-address bind already covers.
