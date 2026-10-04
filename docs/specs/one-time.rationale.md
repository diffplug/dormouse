# One-time connection — rationale

Evidence for `docs/specs/one-time.md`, keyed by its headings.

## Hosted rendezvous

**Why the room reads nothing.** Every bound the room enforces is on the raw string: its length, its type, and how many there have been. A room that parsed a frame would have started to act on what a handshake says, and a room that logged or stored one would keep handshake ciphertext past the handshake. The ends run the frame guards; the room is a counter with two sockets.

**Why the count includes dropped frames.** A Burrow's frames before any phone joins go nowhere, but each one still wakes the object. Counting them bounds the room's wake-ups, not just its forwarding, and a real Burrow sends nothing before the phone's first message anyway.

**The Origin rules are abuse control, not authorization.** Every browser sends `Origin` on a WebSocket handshake, and Node's `WebSocket` sends none unless given one (measured on Node 24.18, 2026-09-28), so refusing any `Origin` on the Burrow route keeps a web page from minting rooms from its visitors' addresses. The client route's exact `APP_ORIGIN` keeps other sites from joining. A non-browser client can forge either header; what authorizes a session is the Noise handshake against the link's one-use key and the laptop's confirmation.

**Why IPv6 is limited by its /64.** A single subscriber commonly holds a whole /64, so a per-address key would give one client 2^64 fresh limits. An IPv4-mapped address names one IPv4 client, and its /64 is all zeros: keyed by that, every such client in the world would share one limit. Only the mapped prefix is unwrapped, since keying any address with a dotted tail by its last 32 bits would give a /64's holder 2^32 fresh limits.

**Why a refusal is accepted outside hibernation.** Measured in workerd 1.20260908.1 under Miniflare, 2026-09-28: when an object closes a hibernatable socket from any event but that socket's own, the close frame arrives at once but the TCP connection is dropped only when the object goes idle, about ten seconds later, and a WHATWG or `ws` client fires `close` only then. A refused socket accepted with `accept()` and closed in the same request drops promptly. It also never reaches `webSocketClose`, which would otherwise end the room it was refused from. The same lag applies to the end an ending closes from the other end's event (4013, 4014, 4015); production behavior is unverified. The suite reads close frames over a bare socket for this reason. Local `wrangler dev` also logs `Uncaught Error: Network connection lost.` once per refused join; it appears for any socket accepted outside hibernation, even one the client closes cleanly, so it is workerd noise rather than a room fault (reproduced 2026-09-28; production logging unverified).

**Cost** (Cloudflare Durable Object pricing, checked 2026-09-28). Waiting for a phone costs nothing: the Burrow socket is hibernated and pings are answered without waking. A connection's handshake is about 10–20 incoming messages, billed 20:1 so under one request, and a few seconds awake, about 1–4 GB-s at 128 MB. The free plan's 13,000 GB-s and 100,000 requests a day cover thousands of connections a day; Workers Paid's 400,000 GB-s and one million requests a month cover about 100,000 a month. One room's worst case is bounded by the message cap and the deadline (about 40 GB-s, about $0.0005), and the number of rooms by the per-address mint limit.

## Phone page

**Why the sandbox keeps `allow-same-origin`.** Without it the page runs in an opaque origin, so its WebSocket handshake carries `Origin: null`, which the client route refuses. Chrome logs "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing" for the pair even on a top-level document (measured in agent-browser's Chrome, 2026-09-28); a top-level document has no parent to escape through, and the sandbox still withholds popups, forms, modals, and downloads. It was the one console entry on the ready, expired, and invalid screens; no directive reported a violation, and a tap's socket to the client route and a WebAssembly compile both ran.

**Why the page reloads on `hashchange`.** Opening a link in the tab already showing `/connect/` changes only the fragment, which a browser treats as a same-document jump: measured in agent-browser's Chrome, 2026-09-28, the page stayed on its "invalid" screen with the new link left in the address bar.

**Why the page names the device rather than borrowing Pocket's label.** Pocket names its install mode, "Dormouse Pocket (browser)" or "(Home Screen)", because one phone can hold two Client identities. The one-time page holds none, and the end-to-end run (standalone harness, 2026-09) showed the laptop's approval modal calling a one-time phone "Dormouse Pocket (browser)", an app it never opened. The platform string gives a coarse name without a user-agent parser, with two exceptions it cannot see: iPadOS Safari reports a Mac's `MacIntel` (desktop-class browsing, the default since iPadOS 13), which only its touch points tell apart, and Firefox for Android has no `userAgentData` and reports a `Linux` platform, while its user agent names Android. A device none of these name falls to "Phone browser", which is also what the Burrow shows for any label outside the set.

## Service and hosts

**Why a service announces its one-time state as it starts.** A UI can outlive the service instance it heard from: a VS Code window that takes the broker over from one with a phone connected, or a restarted sidecar. Its panel kept showing that phone with End, on a connection gone with its window, until someone pressed End (review, 2026-09). The state needs no enrollment, so it goes out before the keychain read.

## Laptop UI

**Why nothing re-opens on a timer.** The Relay's "Set up a phone" panel re-mints shortly before its code expires, because a setup code is replaced without anyone noticing. A one-time link cannot be: each open mints a room and a one-use key, and a link someone already sent to their phone would die under them. An expired link waits for New link instead, and the runtime ends it `expired` on its own clock.

**Why `ended {user-ended}` renders as idle.** Only this machine produces that reason — End, Cancel, or the service shutting down; a replaced runtime ends unannounced — so there is nothing to tell the person who did it. Reporting it would make Cancel two clicks, Cancel then Done, and sending that second `oneTimeEnd` on the user's behalf could, in VS Code, end a link another window opened between the two commands.

**Why the indicator starts at `connecting`.** The modal has been answered by then, so the phone is authorized, and with Settings closed the Baseboard is the only place to stop it during the direct deadline.
