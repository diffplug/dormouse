# Network policy and remote transport — rationale

Evidence for `docs/specs/remote-network.md`, keyed by its headings.

## Levels

**Three personas set the levels (2026-09-30).** One wants no network requests at
all; one will try Pocket but only over their LAN or VPN; one wants it to work
anywhere. One choice per persona, with the connections it implies listed beside
it, replaced a transport matrix (persistent vs one-time × restricted vs not)
whose rows the UI never needed to distinguish.

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
and on the polyfill's `RTCIceTransport`.

**Why not bind the listener.** `bindAddress` takes one address, and a policy may
allow several networks. The listener's exposure is already stated and accepted
in the security model; the level promises a path, not a socket.

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
