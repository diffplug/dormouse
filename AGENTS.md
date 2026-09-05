# Dormouse

A mouse-friendly multitasking terminal built with pnpm, react, typescript, vite, tailwind, storybook, and xterm.js.

## Setup

```
pnpm install     # install deps
pnpm build       # build lib, vscode extension, Pocket, and website
```

## Architecture

- **`lib/`** — Shared React + TailwindCSS frontend library: components, tests, Storybook.
  - `lib/src/lib/platform/` — platform abstraction (`PlatformAdapter` interface, fake + VSCode adapters)
  - `lib/src/host/` — Node-side host modules bundled into both hosts: the iframe proxy, the agent-browser host, and `remote/` (the `BurrowService` that runs in the Tauri sidecar and the VS Code extension host)
  - `lib/src/remote/` — remote control: `burrow/` (laptop side: protocol-v1 session, security, the webview's responder + pairing UI), `client/` (phone-side protocol + `RemotePtyAdapter`), `pocket-app/` (Pocket shell), `ws.ts` (shared socket surface)
- **`standalone/`** — Tauri desktop app (Rust + Vite frontend).
  - `standalone/sidecar/` — Node.js PTY manager (native PTY via node-pty), bundled as the Tauri sidecar
  - `standalone/src-tauri/` — Rust backend bridging webview ↔ sidecar
- **`vscode-ext/`** — VS Code extension wrapping the lib in a webview (esbuild; node-pty via forked child process)
- **`website/`** — Marketing site (Vite) bundling part of the lib as an interactive demo on `FakePtyAdapter`
- **`relay/`** — Selfhost coordinating Relay for remote control (Hono): accounts + passkey auth in local JSON files (no database), WebSocket routing between Clients and Burrows, serves the built Pocket app
- **`dor/`** — The `dor` CLI (stricli) staged onto the `PATH` of every Dormouse-launched terminal; talks to its host over a private control socket
- **`remote-lib-common/`** — Security primitives + remote wire contract shared by `relay`, the Burrow module in `lib`, and the Pocket app (bare ES2022 — no DOM or Node types)
- **`dor-lib-common/`** — Cross-platform external-process spawning (`spawnAndCapture`) shared by `dor` and the `lib` host. Despite the parallel names, the two `*-lib-common` packages are unrelated: `remote-lib-common` is remote security/wire, `dor-lib-common` is spawn plumbing.
- **`canopy/`** — Experimental 3D/WebXR terminal-rendering lab (Storybook-only, not in the production build). Consumes `@diffplug/xterm-addon-webgl-sdf` — the webgl addon from our [xterm.js fork](https://github.com/diffplug/xterm.js) (`sdf` branch).

**Burrow, Client, Relay** — the three remote-control roles — are defined in `docs/specs/glossary.md` -> "Roles". *Host* is reserved for the platform host, the `Host` header, hostnames, and self-hosting; *server* for HTTP servers and dev servers.

## Specs

A spec is the accurate reference for the current code: it states the invariants and edge cases the code alone does not show, and its paired `<foo>.rationale.md` holds the evidence. To modify a feature, read its spec plus the rationale sections for the headings you touch.

One implementation map per spec: an exhaustive `Files` / `Code Map` section or section-local `Source of truth:` pointers, never both.

- **`docs/specs/glossary.md`** — Canonical vocabulary: the Surface model, Session layers, `Window ⊃ Workspace ⊃ Pane ⊃ Surface`, transition verbs, invariants I1–I10. Read first; every spec defers to it for state, kind, and verb names.
- **`docs/specs/layout.md`** — The interaction model over the tiling engine: modes, command-mode dispatch, navigation, minimize/reattach, kill/rename, session lifecycle and persistence recovery, the workspaces-rollout ledger. Read before touching keyboard/navigation/mode/workspace behavior.
- **`docs/specs/shortcuts.md`** — Quick-reference table of every shortcut by mode/context; layout.md owns the behavior — update both when a binding changes.
- **`docs/specs/tiling-engine.md`** — **Lath**, the in-house headless tiling engine: pure split-tree core, never-re-parent LathHost adapter, wall store + engine, Lath-only persistence.
- **`docs/specs/alert.md`** — The Activity layer: alert tracks, attention model, TODO lifecycle, notification protocols with their sanitization rules, the Workspace union projection.
- **`docs/specs/terminal-state.md`** — Per-Session semantic state: CWD, prompt/command lifecycle, title candidates and header derivation, grouping keys.
- **`docs/specs/terminal-escapes.md`** — Registry of every escape sequence parsed, answered, or ignored, each row pointing at its owning spec. Read before touching OSC/CSI parsing.
- **`docs/specs/transport.md`** — Adapter-agnostic webview ↔ host protocol: PTY lifecycle and buffering, reconnection, message contracts, persisted-session types, the invariants every adapter honors.
- **`docs/specs/mouse-and-clipboard.md`** — Terminal-owned selection, copy (Raw / Rewrapped), paste tiers, smart URL/path extension, the mouse-ownership state matrix.
- **`docs/specs/theme.md`** — The two-layer CSS variable strategy, consumed-token resolver, terminal color contract, theme debugger.
- **`docs/specs/dor-cli.md`** — The `dor` CLI on every Dormouse terminal's `PATH`: bundling and env contract, `spawnAndCapture` rules, control-socket plumbing, the Surface handle model, the command set.
- **`docs/specs/dor-browser.md`** — The browser surface: `BrowserPanel` with swappable `renderMode`, browser chrome, the agent-browser stack, the iframe proxy and CSP boundaries.
- **`docs/specs/dor-tool.md`** — Dor Tools (design-stage): the `tool` Surface — a terminal and a browser on one Session spine — its capability-gated verbs and OSC 367 contract. Only capability gating is built.
- **`docs/specs/vscode.md`** — VS Code host: webview hosting, webview ↔ Workspace mapping, persistence ordering, theme integration, CSP, the build/dogfood pipeline.
- **`docs/specs/standalone.md`** — Tauri host: the Rust ↔ Node-sidecar bridge, boot sequence, AppBar, persistence, shutdown ordering, the build/dev workflow.
- **`docs/specs/auto-update.md`** — Standalone auto-update: check → approved download → install-on-quit, the Baseboard notice, Windows sidecar teardown, per-platform quit behavior.
- **`docs/specs/mobile-terminal-ui.md`** — The mobile composition (`MobileTerminalUi` / `MobileWall`): stable viewport + keyboard reserve, touch modes, the radial gesture menu; shipped in the Pocket playground and the Pocket app.
- **`docs/specs/tutorial.md`** — Website playground tutorial: device-specific routes, the `tut` runner and progress state, desktop and Pocket profiles, the lib hooks for tutorial observability.
- **`docs/specs/website-docs.md`** — Public documentation on the marketing site: the generated references, the Markdown rendering contract they share, the left rail across the docs section, `vscode-ext/README.md` as the canonical guide published off-site, and the lint that pins their links.
- **`docs/specs/webgl-text.md`** — SDF text rendering for the 3D/WebXR effort: the diffplug/xterm.js fork pipeline and its version lockstep, the SDF glyph architecture, the canopy Storybook lab.
- **`docs/specs/remote-security-model.md`** — Remote-control trust model: one Noise channel per ceremony, passkeys proving presence inside it, per-Burrow Client statics, the Burrow (not the Relay) authorizing the pair. Read first for anything remote.
- **`docs/specs/remote-api.md`** — What an authorized Client speaks: the shipped terminal-only **protocol-v1** and the staged remainder.
- **`docs/specs/relay.md`** — The selfhost coordinating Relay and shared Burrow-service runtime: env config, JSON-file state, WebAuthn without a library, HTTP API, relay flow, enrollment, running it end to end.
- **`SELF_HOST.md`** (repo root) — Self-host deployment: the assistant-run install runbook plus the Installer contract that `docs/specs/security-remote.md`'s `FAIL IF` lines and `scripts/deploy-lint.mjs` audit.
- **`docs/specs/pocket-app.md`** — Pocket: the remote session is a `PlatformAdapter` (`RemotePtyAdapter`), so Pocket is auth screens plus the mobile composition; owns the same-origin deployment rule.
- **`docs/specs/deploy.md`** — Release process: artifact matrix, release checklist, two-stage sign-and-release pipeline, updater manifest, changelog flow.
- **`docs/specs/security.md`** — The guarantees Dormouse makes, what it does not defend, the known gaps, and how it is all checked; published at `/docs/security`, rows split by audience. Read first for anything security. Root `SECURITY.md` is the GitHub policy pointer at it.
- **`docs/specs/security-local.md`** — The boundaries a user of the local application has: terminal output, browser panes, the `dor` control socket, loopback listeners, persisted state.
- **`docs/specs/security-remote.md`** — The audited checks on remote control: trust boundary, relay allowlist, credentials at rest, the setup password, cross-origin access, network posture, what crosses the boundary, revocation.
- **`docs/specs/security-supply-chain.md`** — Disclosure of everything that reaches a user's machine, the bundled runtime pin, dependency cooldown and alerts.
- **`docs/specs/security-ci.md`** — GitHub Actions, the tend bot, and the two release paths: what each identity can reach and what stays admin-gated.
- **`docs/specs/security-audit.md`** — The nightly audit contract: schedule and release gate, the domains and their prompts in `.github/audit/`, orchestration, outcomes, reporting, `AUDIT_PAT`. `scripts/security-audit-local.sh` runs it locally.

When code covered by a spec changes, change the spec. Where two specs overlap (pane header elements), layout.md owns placement and sizing, alert.md behavior and visual states. `docs/stories/pairing.mdx` narrates the remote setup and owns nothing; when a remote spec changes, check whether it needs the same edit — the specs win where they disagree.

**What, not why.** A spec says what the code is: each rule once, as a bolded imperative, in the spec that owns it, or as a comment at the code when one module alone carries the constraint. Every other mention is a one-line pointer to the spec and heading, never a paraphrase or a count of its items. The why (evidence, measurements, dead approaches, history) goes to `docs/specs/<foo>.rationale.md` (required past 2,500 words), keyed by the spec's headings and marked `(rationale)` at the rule it backs. The test for what stays: if deleting a sentence would let a careful editor reintroduce a bug or break compatibility, its one-line form stays in the spec, and facts such as constants, bounds, directions, and "only" or "never" are not evidence. Keep the rationale concise too: it is read to change one rule, not to relearn the codebase.

- **Keying.** Each `## X` in `<foo>.rationale.md` is a heading in `<foo>.md`, at any level, including one under `## Future`. A rule whose evidence moved gets a trailing `(rationale)` marker, alone or as the last item of its parenthetical (`(…; rationale)`) — a hint, not a link — and the marker replaces the why-clause; a rule never carries both. Rationale files are informative, not normative: no `## Future`, no `Reserved:`, no `Source of truth:` obligations, no bolded imperatives; date measurements (`measured in Safari 26.5, 2026-08`) so later pruning is safe.
- **Rule first.** Within a spec paragraph the normative statement leads and any remaining inline why follows (applied opportunistically, not as a corpus rewrite).

**House form for rules.** A rule leads with a bolded imperative — **Never …**, **Must …**, **May …** — and at most one clause of why; the bold carries the emphasis, so scaffolding ("deliberately", "note that", "it is worth stating") is deleted. An audited rule leads with **FAIL IF** instead — the condition, what the auditor reads, at most one clause of why — and lives only in a `docs/specs/security*.md` spec, each claimed by exactly one domain prompt in `.github/audit/`. A rule list, precedence ladder, or flow renders as invariant bullets or a table, not prose; number rules only where another spec cites them. Mechanism constraining a single module lives as a comment at that code, the spec keeping the one-line rule and a `Source of truth:` pointer; mechanism constraining editors of *other* files stays in the spec. Consolidate `Source of truth:` pointers at the end of a section, as `` `symbol` in `path` `` with full repo paths — a bare file name dodges the path lint and rots. Name the test that pins a rule; never reproduce its case inventory. A diagram earns its place only for ordering or fan-out no table carries; prose beside a figure or table adds only what it cannot show, and a flow converts to a numbered list, never a sentence. A table cell states the fact, the section the rule, the rationale the why; a qualifier repeated in every row becomes a caption. A coined term is defined at its heading, not in an intro. Registries — `docs/specs/terminal-escapes.md`, `docs/specs/shortcuts.md`, the glossary tables — keep their inventories and own no behavior.

Generated help and canonical types own syntax and shape; specs own behavior and cross-boundary invariants, including the contract of a consumer that does not exist yet. Keep specs concise, but never replace an invariant or edge case with only a code pointer. `Source of truth:` is the form for implementation references; protocols, command orchestration, and cross-package boundaries state direction and scope. Docs-only compression spot-checks referenced symbols, message directions, and root-vs-package script ownership against code before committing.

**Front matter.** Every spec using Session / Pane / Door / baseboard / passthrough vocabulary opens with a `> See \`docs/specs/glossary.md\` for ...` blockquote (exemplars: `layout.md`, `alert.md`, `terminal-state.md`); introducing that vocabulary into a spec without the callout adds it in the same edit. The callout licenses glossary terms bare — never re-explain them locally. The opening blockquotes are the front matter: the callout plus, where useful, one line each for what the spec owns, what it defers and to whom, and what to read first. Ownership is stated there once, never re-disclaimed per section.

### Spec lifecycle

Specs are written ahead of the code: a new component's spec starts as a full design (a "dream"), is cut to the smallest slice that unblocks the system, that slice is built, and the uncut remainder is kept because it was expensive to generate and stays useful for planning. These conventions keep the body an accurate reference for the current code:

- **The fold.** Everything above `## Future` describes the code as it is — present tense, anchored with `Source of truth:` pointers. Everything unbuilt lives under `## Future`, always the last section; a spec with no unbuilt design has none.
- **Design-stage specs.** A spec for a component that does not exist yet keeps its whole design under `## Future`, opens with `> Status: design — nothing here is implemented yet.`, and is indexed above like any other.
- **Named scopes.** A cut is recorded as a named scope at the top of `## Future` (`**Scope: workspaces-rollout**`), listing what remains in staged order. A scope is defined in exactly one spec; other specs link it by name and never restate it. Rollout ledgers live in the owning spec's `## Future`, nowhere else.
- **Reservations.** Unbuilt design that constrains present code — a reserved wire field, a reserved ref grammar, an additive-evolution guarantee — is stated in the body, marked `Reserved:`, pointing at the `## Future` item it serves. Test: if deleting the sentence would let someone break future compatibility today, it belongs in the body.
- **Promotion is part of done.** A staged item is finished only when its text moves above the fold — "will" rewritten to "is", `Source of truth:` added — and the built portion is deleted from `## Future`. Never leave completed plan text (build orders, phase lists) below the fold; git keeps the record.

`scripts/spec-lint.mjs` (`pnpm lint:specs`, the first step of the root `pnpm test`) enforces the mechanically checkable conventions above — its header comment lists the checks — and ratchets size: every spec, this file, `SECURITY.md`, and `SELF_HOST.md` carry a word budget in `scripts/spec-word-budgets.json`, its size rounded up to the nearest 50. Rationale files carry none; evidence may grow without limit. Over budget: cut to fit, or re-baseline with `node scripts/spec-lint.mjs --ratchet <spec>` in the same PR. `SECURITY.md` and `SELF_HOST.md` ride the same checks. Advisory prose reviews follow `docs/prose-audit.md` (`pnpm audit:prose`).

Six sibling lints run in `pnpm test`. Five enforce one invariant a spec states in prose, each naming the line it enforces and failing if that line is gone; the sixth guards the one shipped file nothing else can parse:

| Lint | Enforces |
|---|---|
| `scripts/public-docs-lint.mjs` (`pnpm lint:public-docs`) | The public-doc contracts in `docs/specs/website-docs.md`, every inventory derived from the file that owns it. |
| `scripts/xterm-lint.mjs` (`pnpm lint:xterm`) | The `@xterm/*` version lockstep in `docs/specs/webgl-text.md`. |
| `scripts/loopback-lint.mjs` (`pnpm lint:loopback`) | `docs/specs/security-local.md` -> "Loopback Listeners": a loopback bind is not an access control — a new listener references a guard module or is allowlisted with a reason. |
| `scripts/deploy-lint.mjs` (`pnpm lint:deploy`) | `docs/specs/security-remote.md` -> "Credentials at rest" and "Network posture (self-hosted)": the installer controls binding all three of `deploy/local/install-{macos,windows,linux}`. |
| `scripts/ps1-cmdlet-lint.mjs` (`pnpm lint:deploy`) | Every `Verb-Noun` call in `deploy/local/install-windows.ps1` uses an approved verb and a noun that is not this project's vocabulary. No job has a PowerShell, so this is the Windows installer's only syntax gate — a repo-wide rename once turned all 147 `Write-Host` calls into `Write-Burrow`. |
| `scripts/e2e-lint.mjs` (`pnpm lint:e2e`) | The structural half of `docs/specs/security-remote.md` -> "Remote Control": one Noise suite with no selector, no JavaScript curve, no legacy relay discriminant, no Relay-side protocol-v1 type, no checked-in service worker, no optional field on a ciphertext or transcript. |

`scripts/spec-lint-selftest.mjs` plants one defect per finding check in the spec lint. The last two sibling lints carry self-tests that mutate each rule in whichever direction it points: a present-control rule has its control deleted (and, for exact-count rules, a copy added), a `forbidden` rule has the banned text appended. `scripts/e2e-lint-selftest.mjs` is wholly the second kind; `scripts/deploy-lint-selftest.mjs` is mostly the first. Either way the lint must go red. **A rule added to one of these lints without its self-test case is not enforced** — it is a claim that something is checked. They share plumbing, and only that, through `scripts/lint-kit.mjs`. `scripts/installer-verify-test.mjs` (also `pnpm lint:deploy`) runs the installer shell helpers lint can only read, extracted from the shipped files; `scripts/ps1-cmdlet-lint-selftest.mjs` carries the sixth lint's two mutations. `pnpm test` also runs `scripts/clamp-issue-body-selftest.mjs`, the test for `scripts/clamp-issue-body.mjs` (the helper the audit workflows use to keep an issue body postable); it lives at the repo root because its callers do.


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
class anywhere in `lib/src/`. The `@theme` token definitions are split: colors
in [`lib/src/theme-colors.css`](lib/src/theme-colors.css), which a host can
import on its own, and the type scale, fonts, and animation tokens in
[`lib/src/theme.css`](lib/src/theme.css). When adding or removing a color
token, update `theme-colors.css` and `design.tsx` together.
