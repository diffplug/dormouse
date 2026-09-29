# One-time connection — rationale

Evidence for `docs/specs/one-time.md`, keyed by its headings.

## Hosted rendezvous

**Why the room reads nothing.** Every bound the room enforces is on the raw
string: its length, its type, and how many there have been. A room that parsed
a frame would have started to act on what a handshake says, and a room that
logged or stored one would keep handshake ciphertext past the handshake. The
ends run the frame guards; the room is a counter with two sockets.

**Why the count includes dropped frames.** A Burrow's frames before any phone
joins go nowhere, but each one still wakes the object. Counting them bounds the
room's wake-ups, not just its forwarding, and a real Burrow sends nothing before
the phone's first message anyway.

**The Origin rules are abuse control, not authorization.** Every browser sends
`Origin` on a WebSocket handshake, and Node's `WebSocket` sends none unless given
one (measured on Node 24.18, 2026-09-28), so refusing any `Origin` on the Burrow
route keeps a web page from minting rooms from its visitors' addresses. The
client route's exact `APP_ORIGIN` keeps other sites from joining. A non-browser
client can forge either header; what authorizes a session is the Noise
handshake against the link's one-use key and the laptop's confirmation.

**Why IPv6 is limited by its /64.** A single subscriber commonly holds a whole
/64, so a per-address key would give one client 2^64 fresh limits.

**Why a refusal is accepted outside hibernation.** Measured in workerd
1.20260908.1 under Miniflare, 2026-09-28: when an object closes a hibernatable
socket from any event but that socket's own, the close frame arrives at once but
the TCP connection is dropped only when the object goes idle, about ten seconds
later, and a WHATWG or `ws` client fires `close` only then. A refused socket
accepted with `accept()` and closed in the same request drops promptly. It also
never reaches `webSocketClose`, which would otherwise end the room it was
refused from. The same lag applies to the end an ending closes from the other
end's event (4013, 4014, 4015); production behavior is unverified. The suite
reads close frames over a bare socket for this reason.

**Cost** (Cloudflare Durable Object pricing, checked 2026-09-28). Waiting for a
phone costs nothing: the Burrow socket is hibernated and pings are answered
without waking. A connection's handshake is about 10–20 incoming messages,
billed 20:1 so under one request, and a few seconds awake, about 1–4 GB-s at
128 MB. The free plan's 13,000 GB-s and 100,000 requests a day cover thousands
of connections a day; Workers Paid's 400,000 GB-s and one million requests a
month cover about 100,000 a month. One room's worst case is bounded by the
message cap and the deadline (about 40 GB-s, about $0.0005), and the number of
rooms by the per-address mint limit.
