# dor-tools-lib

The Dor Tool integration protocol, for Tools and for the hosts that run them. MIT-licensed, with no runtime dependencies. It is private until the protocol reaches 1.0, and its API may change before then.

- `dor-tools-lib/osc`: OSC 367. A Tool writes `serveSequence({ port, path })` once it listens and `stateSequence({ dirty })` on every change. A host reads both with `parseToolAnnounce` / `parseToolState`.
- `dor-tools-lib/frame`: `connectToolFrame({ dirty, save })` lets a framed page report its dirty state and save when the host's close prompt asks.
- `dor-tools-lib/protocol`: the save channel's messages, validated in both directions.

The contract lives in Dormouse's `docs/specs/dor-tool.md`, and the package's own rules in `docs/specs/dor-tools-lib.md`.
