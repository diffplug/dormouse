# Security rationale

Maintainer-facing context for `docs/specs/security.md`, keyed by its headings. The spec is published whole at `https://dormouse.sh/security`, so what a reader there does not need lives here.

## Security

**Why Hosted's status is not on the page (2026-10).** Hosted's live production controls and its paid-service acceptance still need verification (`docs/specs/hosted.md`), and paid cloud operation needs the review under `docs/specs/security-remote.md` -> "Cloud-hosted mode". Both are maintainer work items, not guarantees a reader can rely on, so the page names what Hosted implements and leaves the open review here.

## Guarantees

**Why some rows cite `cargo test`.** Native Cargo tests run in separate CI jobs in `.github/workflows/ci.yml`, outside root `pnpm test`, so a row pinned by one is checked on every pull request but not by a local `pnpm test`.

**Why the network-policy rows name what still leaves.** The 2026-10-07 claims review found the Settings → Network copy promising more than the level enforced: Local networks holds terminal traffic to the allowed networks, while the relay socket (handshakes, pairing, push) and managed voice reach Hosted from any network. Each row now states what crosses the boundary alongside what the level keeps in.

## Known gaps

**agent-browser's listeners (measured with agent-browser 0.31.1 and Chrome for Testing 150, 2026-10-07).** agent-browser launches Chrome with `--remote-debugging-port=0` and no `--remote-allow-origins`; the port binds `127.0.0.1`, and `/json/version` names the browser's WebSocket URL to anyone who asks. A WebSocket upgrade with no `Origin` header got `101` from both the CDP port and the daemon's stream port; one carrying `Origin: https://evil.example` or `Origin: http://localhost:1234` got no upgrade from either. CDP grants `Runtime.evaluate` and navigation to `file://`, and the stream carries the screencast and input. Dormouse runs the user's installed agent-browser (`docs/specs/security-supply-chain.md`) and chooses none of its browser's flags, so closing the gap needs an upstream change or a launch flag Dormouse would have to own.

## How the guarantees are checked

**Why every lint carries a self-test.** A lint rule that no self-test mutates can go silently vacuous — a renamed file or a regex that stops matching passes forever — so a rule without one is a claim, not a check. `scripts/security-audit-local.sh` runs the nightly audit's prompts locally.

The public issue carries verdicts and counts because the audit's findings are vulnerabilities until fixed. Issue #1027 (2026-10) published a BLOCKER with a working command-injection payload, which contradicted `docs/specs/security.md` -> "Reporting a vulnerability" telling a reporter never to open a public issue; the detail now goes where an advisory would (`docs/specs/security-audit.md` -> "Embargo").

## Reporting a vulnerability

The advisory form is the only channel this spec offers, and a disabled one sends a reporter to a public issue.
