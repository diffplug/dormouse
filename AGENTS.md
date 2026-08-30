# Dormouse

A mouse-friendly multitasking terminal built with pnpm, react, typescript, vite, tailwind, storybook, and xterm.js.

## Setup

```
pnpm install     # install deps
pnpm build       # build lib, vscode extension, and website
```

## Architecture

- **`lib/`** — Shared React + TailwindCSS frontend library: components, tests, Storybook.
  - `lib/src/lib/platform/` — platform abstraction (`PlatformAdapter` interface, fake + VSCode adapters)
  - `lib/src/host/` — Node-side host modules bundled into both hosts: the iframe proxy, the agent-browser host, and `remote/` (the `RemoteHostService` that runs in the Tauri sidecar and the VS Code extension host)
  - `lib/src/remote/` — remote control: `host/` (laptop side: protocol-v1 session, security, the webview's responder + pairing UI), `client/` (phone-side protocol + `RemotePtyAdapter`), `pocket-app/` (Pocket shell), `ws.ts` (shared socket surface)
- **`standalone/`** — Tauri desktop app (Rust + Vite frontend).
  - `standalone/sidecar/` — Node.js PTY manager (native PTY via node-pty), bundled as the Tauri sidecar
  - `standalone/src-tauri/` — Rust backend bridging webview ↔ sidecar
- **`vscode-ext/`** — VS Code extension wrapping the lib in a webview (esbuild; node-pty via forked child process)
- **`website/`** — Marketing site (Vite) bundling part of the lib as an interactive demo on `FakePtyAdapter`
- **`server/`** — Selfhost coordinating server for remote control (Hono): accounts + passkey auth in local JSON files (no database), WebSocket relay between Pocket clients and Hosts, serves the built Pocket app
- **`dor/`** — The `dor` CLI (stricli) staged onto the `PATH` of every Dormouse-launched terminal; talks to its host over a private control socket
- **`server-lib-common/`** — Security primitives + remote wire contract shared by `server`, the Host module in `lib`, and the Pocket app (bare ES2022 — no DOM or Node types)
- **`dor-lib-common/`** — Cross-platform external-process spawning (`spawnAndCapture`) shared by `dor` and the `lib` host. Despite the parallel names, the two `*-lib-common` packages are unrelated: `server-lib-common` is remote security/wire, `dor-lib-common` is spawn plumbing.
- **`canopy/`** — Experimental 3D/WebXR terminal-rendering lab (Storybook-only, not in the production build). Consumes `@diffplug/xterm-addon-webgl-sdf` — the webgl addon from our [xterm.js fork](https://github.com/diffplug/xterm.js) (`sdf` branch). The fork pipeline, SDF rendering architecture, and version-lockstep rules live in `docs/specs/webgl-text.md`.

## Specs

The primary job of a spec is to be an accurate reference for the current state of the code. To understand a feature, read its spec; to modify one, read the spec **plus** its `<foo>.rationale.md` sections for the headings you touch (see **The rationale split** below) — the spec states the invariants and edge cases that are not obvious from the code alone, and the rationale file holds the evidence behind them.

Where a spec has a `Files` / `Code Map` section, it is the exhaustive file→spec mapping; in specs without one, the `Source of truth:` pointers are the mapping.

- **`docs/specs/glossary.md`** — Canonical vocabulary: the Surface model, the Session layers, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, transition verbs, and invariants I1–I10. Read this first; every other spec defers to it when naming a state, a surface kind, or a verb.
- **`docs/specs/layout.md`** — The interaction model on top of the tiling engine: modes, command-mode keyboard dispatch, navigation, minimize/reattach, kill/rename, session lifecycle + persistence recovery, and the workspaces-rollout ledger. Read it before touching any keyboard/navigation/mode/workspace behavior; the engine internals live in tiling-engine.md.
- **`docs/specs/shortcuts.md`** — Quick-reference table of every keyboard shortcut by mode/context. layout.md owns the behavior; update both when a binding changes.
- **`docs/specs/tiling-engine.md`** — **Lath**, Dormouse's in-house headless tiling engine (it replaced dockview-react): the pure split-tree core, the never-re-parent LathHost adapter, the wall store + engine, and Lath-only persistence. layout.md owns the interaction model on top.
- **`docs/specs/alert.md`** — The Activity layer: the alert tracks, attention model, TODO lifecycle, notification protocols with their sanitization/security rules, and the Workspace union projection. layout.md defers to it for all alert/TODO behavior.
- **`docs/specs/terminal-state.md`** — Per-Session semantic state: CWD, the prompt/command lifecycle, title candidates + header derivation, and grouping keys.
- **`docs/specs/terminal-escapes.md`** — Registry of every escape sequence Dormouse parses, answers, or deliberately ignores, each row pointing at the owning spec. Read it before touching OSC/CSI parsing or adding any escape sequence.
- **`docs/specs/transport.md`** — Adapter-agnostic webview ↔ host protocol: PTY lifecycle + buffering, reconnection, message contracts, persisted-session types, and the invariants every adapter must honor.
- **`docs/specs/mouse-and-clipboard.md`** — Terminal-owned selection, copy (Raw / Rewrapped), paste tiers, smart URL/path extension, and the state matrix for which layer owns mouse events.
- **`docs/specs/theme.md`** — Theme system: the two-layer CSS variable strategy, the consumed-token resolver, the terminal color contract, and the theme debugger.
- **`docs/specs/dor-cli.md`** — The `dor` CLI staged onto every Dormouse terminal's `PATH`: bundling + env contract, `spawnAndCapture` rules for external binaries, control-socket plumbing, the Surface handle model, and the command set.
- **`docs/specs/dor-browser.md`** — The unified browser surface: `BrowserPanel` with swappable `renderMode`, browser chrome, the agent-browser stack, and the iframe proxy + CSP boundaries. Builds on the handle model in dor-cli.md.
- **`docs/specs/dor-tool.md`** — Dor Tools (design-stage): the `tool` Surface — a terminal and a browser on one Session spine — with its capability-gated verb model and OSC 367 contract. Only the capability gating is implemented.
- **`docs/specs/vscode.md`** — VS Code host layer: webview hosting, webview ↔ Workspace mapping, persistence ordering, theme integration, CSP, and the build/dogfood pipeline. The transport protocol it speaks lives in transport.md.
- **`docs/specs/standalone.md`** — Standalone (Tauri) host layer: the Rust ↔ Node-sidecar bridge, boot sequence, AppBar, persistence, shutdown ordering, and the build/dev workflow. The transport protocol it speaks lives in transport.md.
- **`docs/specs/auto-update.md`** — Standalone auto-update: check → user-approved download → install-on-quit, the Baseboard update notice, Windows sidecar teardown, and per-platform quit behavior.
- **`docs/specs/mobile-terminal-ui.md`** — The mobile terminal composition (`MobileTerminalUi` / `MobileWall`): stable viewport + keyboard reserve, touch modes, and the radial gesture menu. Shipped in the website Pocket playground and reused by the real Pocket app.
- **`docs/specs/tutorial.md`** — Website playground tutorial: device-specific routes, the `tut` runner + progress state, desktop and Pocket profiles, and the lib hooks that exist for tutorial observability.
- **`docs/specs/webgl-text.md`** — The SDF text-rendering stack for the 3D/WebXR terminal effort: the diffplug/xterm.js fork pipeline with its version-lockstep rules, the SDF glyph architecture, and the canopy Storybook lab.
- **`docs/specs/remote-security-model.md`** — The trust model for remote control: passkeys prove fresh user presence, per-browser device keys prove Client identity, and the Host — never the Server — authorizes the pair. Read this first for anything remote; the other three remote specs build on it.
- **`docs/specs/remote-api.md`** — The protocol a Client speaks after `authorizeConnection`: the shipped terminal-only **protocol-v1** and the staged remainder.
- **`docs/specs/server.md`** — The selfhost coordinating server and the shared Host-service runtime: env config, local JSON-file state, WebAuthn without a library, the HTTP API, the relay frame flow, enrollment, and how to run it end to end.
- **`SELF_HOST.md`** (repo root) — The self-host deployment spec: the assistant-run install runbook plus the Installer contract that `SECURITY.md`'s `FAIL IF` lines and `scripts/deploy-lint.mjs` audit.
- **`docs/specs/pocket-app.md`** — Pocket app architecture: the remote session is a `PlatformAdapter` (`RemotePtyAdapter`), so Pocket is auth screens + the mobile-terminal-ui composition; owns the same-origin deployment rule.
- **`docs/specs/deploy.md`** — Release process: the artifact matrix, release checklist, the two-stage sign-and-release pipeline, the updater manifest, and the changelog flow.

When updating code covered by a spec, update the spec to match. When the two specs overlap (e.g. pane header elements appear in both), layout.md documents placement and sizing while alert.md documents behavior and visual states.

**Narrative docs are not specs.** `docs/stories/pairing.mdx` is a Storybook page that walks the self-hosted remote-control setup end to end, embedding the real screens from `lib/src/stories/`. It restates specs for narrative flow rather than owning anything, `scripts/spec-lint.mjs` does not check it, and the `## Future` fold does not apply. When a remote spec changes, check whether it needs the same edit — the specs win where they disagree.

**Say it once.** An invariant and its rationale live in exactly one place — the owning spec when one covers it, otherwise a comment at the code it constrains. Everywhere else gets at most a one-line pointer. Write a comment only for a constraint the code cannot show, and keep prose proportional to the change: a one-line fix earns a sentence of spec plus pointers, not three restatements of the same explanation. A "must stay in sync" claim names the test that pins it (exemplars: `lib/src/lib/themes/consumed-keys.test.ts`, `lib/src/lib/mirrored-constants.test.ts`).

**The rationale split.** A spec stays dense and normative; the evidence behind its rules moves to a paired `docs/specs/<foo>.rationale.md`. Opt-in per spec — thin specs keep rationale inline. What moves and what stays:

- Every prohibition and constraint keeps a one-line form in the spec. The boundary test: if deleting the sentence would let a competent editor reintroduce a bug or break compatibility, its one-line form stays in the spec; everything past that line is rationale.
- Mechanism explanation stays inline when the invariant is illegible without it.
- Forensic history — measurement narratives, dead-approach stories, grievances against replaced dependencies — moves to the rationale file, or is deleted outright once depreciated (git history keeps the record).

Rationale entries are keyed by the spec's own headings: each `## X` in `<foo>.rationale.md` is a heading that exists in `<foo>.md`. In the spec, a rule whose evidence moved gets a trailing `(rationale)` marker — a hint, not a link; the pairing is by heading. Rationale files are informative, not normative: no `## Future`, no `Reserved:`, no `Source of truth:` obligations, and measurements should be dated (`measured in Safari 26.5, 2026-08`) so later pruning is safe. Within spec paragraphs, the normative statement leads and any remaining inline why follows — rule first, rationale after (applied opportunistically, not as a corpus rewrite).

**House form for rules.** A rule leads with a bolded imperative — **Never …**, **Must …**, **May …** — and at most one clause of why; the bold carries the emphasis, so scaffolding words ("deliberately", "note that", "it is worth stating") are deleted rather than kept. A section that is really a rule list, precedence ladder, or flow renders as invariant bullets or a table, not narrative prose; number rules only where another spec cites them. Mechanism that constrains a single module lives as a comment at that code, with the spec keeping the one-line rule and a `Source of truth:` pointer; mechanism that constrains editors of *other* files stays in the spec. Consolidate `Source of truth:` pointers at the end of a section rather than per paragraph.

When editing specs, keep them concise but do not replace invariants or edge cases with only a code pointer. Use `Source of truth:` for implementation references, and include direction/scope for protocols, command orchestration, and cross-package boundaries. For docs-only compression, spot-check referenced symbols, message directions, and root-vs-package script ownership against code before committing.

Every spec that uses Session / Pane / Door / baseboard / passthrough vocabulary leads with a `> See \`docs/specs/glossary.md\` for ...` blockquote (see `layout.md`, `alert.md`, `terminal-state.md`). When introducing glossary vocabulary into a spec that lacks the callout, add it in the same edit. The callout licenses using glossary terms bare — do not re-explain them locally. A spec's opening blockquotes are its front-matter: the callout plus, where useful, one line each for what the spec owns, what it defers and to whom, and what to read first; ownership is stated there once, not re-disclaimed per section.

### Spec lifecycle

Specs are written ahead of the code on purpose: a new component's spec starts as a full design (a "dream"), gets cut down to the smallest slice that unblocks the broader system, that slice is implemented, and the uncut remainder is kept because it was expensive to generate and stays useful for planning. These conventions keep that workflow from eroding the rule that a spec's body is an accurate reference for the current code:

- **The fold.** Everything above a spec's `## Future` section describes the code as it is — present tense, anchored with `Source of truth:` pointers. Everything not yet built lives under `## Future`, which is always the last section of the file. A spec with no unbuilt design has no `## Future` section.
- **Design-stage specs.** A spec for a component that doesn't exist yet keeps its whole design under `## Future` and opens with `> Status: design — nothing here is implemented yet.` It is indexed above like any other spec.
- **Named scopes.** When a dream is cut down, record the cut as a named scope at the top of `## Future` (e.g. `**Scope: workspaces-rollout**`), listing what remains in staged order. A scope is defined in exactly one spec; other specs link to it by name and never restate its contents. Rollout ledgers live in the owning spec's `## Future`, nowhere else.
- **Reservations.** When unbuilt design constrains present code — a reserved wire field, a reserved ref grammar, an additive-evolution guarantee — state that constraint in the body, marked `Reserved:`, pointing at the `## Future` item it serves. Test: if deleting the sentence would let someone break future compatibility today, it belongs in the body.
- **Promotion is part of done.** Implementing a staged item is not finished until its text moves above the fold — rewritten from "will" to "is", with `Source of truth:` added — and the built portion is deleted from `## Future`. Never leave completed plan text (build orders, phase lists) below the fold; delete it — git history keeps the record.

The mechanically checkable parts of these conventions are enforced by `scripts/spec-lint.mjs` (`pnpm lint:specs`, also the first step of the root `pnpm test`): every spec indexed here, `## Future` last, relative links/anchors resolving, backticked repo paths existing on disk, the leading glossary callout wherever its vocabulary is used, scopes defined exactly once with references resolving, `Reserved:` paragraphs naming `## Future` or a scope, and every `*.rationale.md` pairing with its spec, keyed by that spec's headings, with no `## Future`. It also ratchets file size: every spec, rationale file, and this file carries a word budget in `scripts/spec-word-budgets.json`, and growth past it fails the lint — cut, or raise the budget deliberately in the same PR. `SELF_HOST.md` — the one spec living outside `docs/specs/` — rides the same checks.

Three sibling lints run alongside it in `pnpm test`, each enforcing one invariant a spec states in prose: `scripts/xterm-lint.mjs` (`pnpm lint:xterm`) for the `@xterm/*` version lockstep in `docs/specs/webgl-text.md`; `scripts/loopback-lint.mjs` (`pnpm lint:loopback`) for the rule in `SECURITY.md` -> "Loopback Listeners" that a loopback bind is not an access control — a new listener must reference a guard module or be allowlisted with a reason; and `scripts/deploy-lint.mjs` (`pnpm lint:deploy`) for the installer controls in `SECURITY.md` -> "Credentials at rest" and "Network posture (self-hosted)", which bind all three of `deploy/local/install-{macos,windows,linux}` and were previously enforced by nothing. Its companion `scripts/deploy-lint-selftest.mjs` proves each rule is load-bearing by deleting the control — and, for exact-count rules, adding a copy — and requiring the lint to fail.

`pnpm test` also runs `scripts/clamp-issue-body-selftest.mjs` — not a lint but the test for `scripts/clamp-issue-body.mjs`, the helper the audit workflows use to keep an issue body postable. It lives at the repo root because its callers do.

## Design

See [PRODUCT.md](PRODUCT.md) for users, brand personality, and aesthetic direction (including the anti-references), and [DESIGN.md](DESIGN.md) for the full design system — tokens, named rules, and component vocabulary. Key principles:

1. **Native first** — Inside VSCode, feel indistinguishable from a built-in feature. Use the host's theme tokens.
2. **Information density without intimidation** — Dense for power users, approachable for beginners. Progressive disclosure.
3. **Status at a glance** — Scannable in under a second across many terminals.
4. **No chrome, all content** — Minimize UI chrome. Terminals are the content.
5. **Theme-adaptive** — Never hardcode colors. Support light and dark from day one.

The concrete type scale, color strategy (surfaces, foregrounds, header palette, dynamic door bg, selection ring), and shared chrome constants live in
[`lib/src/components/design.tsx`](lib/src/components/design.tsx) — read it
before adding or changing any `text-*`, `bg-*`, `text-color-*`, or border
class anywhere in `lib/src/`. The actual `@theme` token definitions are in
[`lib/src/theme.css`](lib/src/theme.css); when adding or removing a token,
update both files together.

## GitHub

The maintainer's GitHub handle is `@nedtwigg`. `ntwigg` is their local shell username — it appears verbatim in prompt fixtures like `ntwigg@ntwigg-mac-2025` in [`lib/src/lib/terminal-prompt-shape.test.ts`](lib/src/lib/terminal-prompt-shape.test.ts) — and on GitHub it belongs to an unrelated person, so writing `@ntwigg` in a comment, PR body, or commit message pings a stranger and subscribes them to the thread, which only they can undo.
