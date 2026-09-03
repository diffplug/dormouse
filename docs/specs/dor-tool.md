# Dor Tools

> Status: design — only the shared [capability gating](#capability-gating) is
> implemented; the `tool` Surface does not exist. Everything else is under
> [Future](#future).

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane
> vocabulary. Builds on `docs/specs/dor-cli.md` (surface handles, the `ensure`
> spawn path) and `docs/specs/dor-browser.md` (render modes, the iframe proxy),
> whose staged "plugin/backend target axis" this subsumes.

**Pitch**: a console app that opens a web port, framed in a pane the human and
the agent both see and both drive. No SDK, no protocol: print one escape
sequence, read one env var.

## Capability gating

Nothing in the shipped gating is `tool`-specific: `docs/specs/glossary.md` →
Panes and Surfaces owns the capability model and its `hasTerminal` /
`hasBrowser` predicates, `docs/specs/dor-cli.md` → `dor list` the `--json`
`has_terminal` / `has_browser` row fields and their `has no terminal` / `has no
browser` failures. Still owed: the kind that has both —
[The tool capability set](#the-tool-capability-set).

Source of truth: `KIND_CAPABILITIES` in `dor/src/commands/types.ts`, with
`SURFACE_KINDS` **derived** from it so `--kind` parsing cannot drift;
`dor/src/commands/list.ts`; `requireTerminalSurface` / `requireBrowserSurface`
in `lib/src/components/wall/use-dor-control.ts`.

## Future

**Scope: dor-tools** — what remains, staged, one phase per PR; Phase A, the
capability refactor, is [done](#capability-gating).

- **B — `dor open`.** Table + dispatch only: an entry resolves to a terminal
  command (`ensure`/`split`) or an existing browser Surface on a host-served
  viewer page (iframe proxy). No OSC, no atom, **nothing new persisted**, so C1
  needs zero snapshot migration. The VS Code route ([The table](#the-table)) is
  complete here, permanently for v1.
- **C0 — OSC 367 + header chip.** Parse/strip/register/sanitize the `serve`
  verb, plus the inert chip of [Security](#security) whose click reuses the
  existing port-connect flow — the entire security gate at minimal UI cost, and
  a usable chip before the atom exists.
- **C1 — the tool atom.** `dor tool`, announce-minted upgrade-in-place,
  identity dedupe, the console toggle, `surfaceType: 'tool'`, kill/teardown
  (forcing the per-surface teardown hook `docs/specs/dor-browser.md` stages),
  args-only cold restore. Standalone runs it behind `dormouse.flags.tools`;
  `dor open` re-plumbs onto the real path.
- **D1 — reaping without cooperation.** Idle-threshold reap +
  rehydrate-from-args + `persist: "never"`: every stateless tool, no new API,
  no Windows question (a stateless tool can just be killed).
- **D2 — dehydrate/rehydrate.** The `367;dehydrate` verb +
  `DORMOUSE_DEHYDRATE`, designed day 1 — its flag is reserved in the `serve`
  payload from C0. The Windows graceful-stop answer is needed here only.
- **Later** — `ab-*` rendering, pointing the shipped surface-handle addressing
  (`docs/specs/dor-cli.md` → Agent-Browser Surface Addressing) at a `tool`'s
  browser so an agent can GUI-drive it. Pocket/remote browser view (rides the
  browser-surface staging in `docs/specs/remote-api.md`; reserve the kind on
  the wire now). The VS Code full pipeline. An in-pane terminal/browser strip
  (decide against the glossary's reserved multiple-Surfaces-per-Pane). A
  `boots: web` table hint if the terminal flash grates. `--has terminal` /
  `--has browser` filters for `dor list`. A pre-spawn dedupe fast path.

### The tool capability set

`tool` = terminal + browser, the third kind on the live gating, and it changes
none of glossary.md's gating rules. Browser verbs stay renderMode-gated (an
iframe-rendered tool cannot be agent-driven), `kill` / `rename` stay universal,
and kinds stay **disjoint** for `dor list --kind`.

- **Identity**: a tool Surface's id is its `SessionId` (I1 extends to tools)
  and survives every capability and render-mode change — the tool counterpart
  of I10, stronger than browsers have today.
- **Render swaps bypass `replaceSurface`.** A tool's browser is a param of the
  tool's own leaf, so `iframe` ⇄ `ab-*` mutates `renderMode` in place instead
  of routing through the id-minting browser-surface replacement path (I10) —
  which is what makes the identity rule above hold.
- **Axes**: the tool column of the six-axis table reads terminal-column
  semantics for its terminal, browser-column for its browser.
- **Activity**: the terminal's full machine, but WATCHING defaults off for
  tool-spawned commands (`lib/src/lib/watched-commands.ts` rules).
- **Untouched**: input to **either** capability touches, so the first
  browser-side interaction arms kill-confirm while an idle just-opened viewer
  still dies silently.

### OSC 367

`DOR` on a phone keypad. Verb-multiplexed (the OSC 633 pattern): one registry
entry, extensible without burning numbers. Tools emit ST, the parser accepts
BEL. Registered in `docs/specs/terminal-escapes.md`; parsed and stripped at the
PTY data boundary (`lib/src/lib/terminal-protocol.ts`), replay-filtered like the
other reports; payload sanitized and size-capped under the OSC 9/99/777 rules of
`docs/specs/alert.md`.

```
ESC ] 367 ; serve ; {"port":4242,"name":"…","identity":"…","dehydrate":true,"persist":"respawn","v":1} ESC \
ESC ] 367 ; dehydrate ; {"v":1, …} ESC \
```

- `serve` — `port` (host derives `http://localhost:<port>/`), optional `name`
  (feeds title candidates, `docs/specs/terminal-state.md`; priority stays user
  pin > announce name > command), optional `identity` (dedupe key, below), the
  `dehydrate` capability flag, `persist` restart policy (`respawn` default |
  `never`), contract version. **Re-emittable, last-write-wins** — a scratch
  tool that saves re-announces with its file as identity.
- `dehydrate` — emitted on the graceful-stop signal; captured and size-capped
  ([Dehydrate and rehydrate](#dehydrate-and-rehydrate)).
- **No third verb, ever** — titles are OSC 0/2, progress is OSC 9;4, and the
  escape registry is the rest of the API; a `progress` or `title` verb would
  mean tools had grown a protocol.
- **Safe to emit unconditionally** — well-behaved terminals drop unknown OSCs,
  so checking `DORMOUSE_SURFACE_ID` is an optimization, not a capability sniff.
  An OSC, not a control-socket call, because the socket does not exist over
  ssh; tmux needs `allow-passthrough` (one line of tool-author docs).
- Before freezing: sweep xterm ctlseqs and the iTerm2/kitty/WezTerm/ConEmu
  private ranges to confirm 367 is clean. Runners-up: 3676 (`DORM`), 4242.

### Lifecycle

**Spawn**: shell-hosted PTY through the `ensure` spawn path — prompt-wait
typing, per-shell quoting, command-exit tracking (`dor/src/commands/ensure.ts`,
`dor/src/commands/shell-quote.ts`). **Terminal front from spawn**: startup logs
beat a spinner, and a command that never announces is a terminal running a
TUI — a complete outcome, and exactly what a "TUI tool" table entry is.

**Announce** → the same Surface **grows a browser in place**: no replacement,
no ref transfer, no new id; params gain the browser and `surfaceType` flips by
derivation. The pane flips to the browser, the terminal sits behind a toggle on
the header's far-left chip. Accepted: a fast tool flashes its terminal for
~100ms, and the flip animation reads as teaching the terminal-plus-browser
pairing.

**Command exit** → the browser is retired and the pane flips back to the
terminal, leaving a shell prompt above the tool's dying words. Re-running
re-announces and revives the browser on the same Surface.

**Kill** → universal; reaps the process and the browser's backing resources.

### Identity and dedupe

**Identity is computed by the tool, not the host** — only the tool knows that
`README.md`, `./readme.md`, and a symlink are one document, or that a scratch
editor *becomes* its save-file.

- **Scope**: dedupe matches *(tool name as the host knows it from the spawn)* ×
  *(identity string from the OSC)*, so a payload cannot claim to be a different
  tool. Identityless tools are never deduped — scratch semantics.
- **On match**: graceful-stop the redundant new spawn, tear its pane down
  through the existing untouched-kill path (no confirmation; untouched by
  construction), reveal the survivor, report its handle with an `ensure`-style
  reuse note.
- **Races**: concurrent spawns serialize at announce; first wins.
- **Containment**: a match only ever *reveals* a Surface, never transferring
  state, grants, or input — worst case for a spoofed identity is a wrong pane
  getting focus.
- **Blessed pattern**: announce-and-let-Dormouse-dedupe. Warn against VS
  Code-style internal forwarding (second invocation hands off and exits); it
  looks to Dormouse like a failed tool.

### Dehydrate and rehydrate

**Reap a tool announcing `dehydrate: true` on an idle threshold while
`Doored` / `Hidden`** — Surfaces of an inactive Workspace included — **never on
the minimize itself** (reattach must not cost a boot every time) **or under
memory pressure**. The headline case is Workspaces, not shutdown: an inactive
Workspace of dehydratable tools drops to zero processes, relieving the
parked-surface pressure the workspaces rollout projects (`docs/specs/layout.md`
Stage 4; `MAX_PARKED_SURFACES` in `docs/specs/tiling-engine.md`).

**In-session mechanism.** The payload lives with the running host; survival
across a full quit/restart follows each host's session-persistence story
(`docs/specs/transport.md`). This spec takes no position on quit/restore — the
Workspace case alone justifies it.

1. Host sends the graceful-stop signal (grace window).
2. Tool emits `367;dehydrate;{json}` on the way out; host captures it.
3. Rehydrate = respawn the command with `DORMOUSE_DEHYDRATE` in the env,
   rendered per-shell.

Degradation tiers, Lath-restore-token style: dehydrated state → bare args →
error. **Args-only restart is the mandatory floor; the payload is fidelity,
never correctness.** It stays
small versioned JSON, never a document (session blobs have bloated storage
before). **A hung tool blocks nothing**: request, grace, kill anyway, fall back
to args. Open question: the Windows graceful-stop (no SIGTERM to console apps;
candidates: an opt-in input sequence, or dehydrate-on-every-announce as the
Windows fallback).

### CLI

- `dor tool <name> [args]` — launch a registered tool by name. **Fresh instance
  every time**; no `--key`, because identity lives in the OSC.
- `dor open <target>` — sugar over `dor tool`: glob table → tool name → render
  the template with the resolved absolute target → same launch path. Reuse
  rides the identity convention: target-dispatched tools announce
  `realpath(target)`.
- **cwd**: the caller's PWD resolves the argument (existing `--cwd`
  machinery); the session's cwd is `dirname(target)` (or the target directory),
  falling back to caller PWD only when the tool has no path target. **Templates
  render absolute paths**, so command and cwd are deterministic functions of
  the target — reuse and cold restore stay caller-independent, and the tool's
  own relative assets resolve.
- `dor list`: rows report `kind: tool` with the browser's `render_mode`; the
  location column shows the **target**, else the announce name; JSON carries
  target + cwd + url.

### The table

**User-level config only** — a project-local table is arbitrary code execution
via `dor open README.md` in a malicious repo. **Host-resolved, not
CLI-resolved**, so one source of truth serves GUI gestures (file drop) as well
as the CLI. Two sections: named tools (name → command template) and glob rules
(pattern → tool name). An entry may dispatch to a plain terminal command (`*.*`
→ a pager) — the atom is minted by the announcement, not by the table.

**VS Code v1 routes `dor open` to the native editor** — an in-pane md/code
viewer competes with the editor, which native-first forbids — and reports which
route it took. An agent there loses sight of what it opened — accepted for v1,
and the eventual argument for the full pipeline.

### Security

**Honor auto-upgrade on announce only in tool-pipeline sessions and only while
the spawned command is the foreground process** (command-exit tracking knows).
Everywhere else — ordinary terminals, post-exit — it only lights an inert
pane-header chip (the Dev-Server Chip pattern of `docs/specs/dor-browser.md`,
declared instead of port-scanned), and the click is the connecting user
gesture. **Output alone never creates Surfaces.**

**Accepted risk — content-driven announce inside a blessed tool.** A tool
rendering hostile bytes (a pager on a malicious file) *is* the foreground
process, so those bytes pass the gate and can announce an attacker-chosen
localhost port, re-pointing the browser under the tool's name at a service
already listening. Accepted: the blast radius is the dedupe containment applied
to ports — an announce only reveals/frames and transfers no input authority,
grants, or state; the iframe proxy dials upstream as a fresh client with no
browser cookie authority; the link-local/cloud-metadata SSRF guard stands
regardless. The residual is a mislabeled view of the user's own service, inert
without further gestures. Escalations if field reports change the calculus:
gesture-gate re-announces that change the port, or constrain the framed port to
the session's process tree — not the default, because it breaks tools wrapping
double-forking daemons (agent-browser-style) whose port a process-tree scan
cannot see.

### Persistence and hosts

`PersistedSurfaceType` gains `'tool'`; params
`{command, args, cwd, renderMode, url?, identity?, persist?}`
(`docs/specs/transport.md` owns the persisted shapes;
`lib/src/lib/session-types.ts`). **The dehydrated payload is in-session state,
never a persisted param.** Cold restore follows each host's session-restore
story: where sessions restore, `persist: "never"` rows are dropped silently (a
clock, a calculator) and the default respawns from bare args — the args-only
floor is what makes taking no position on quit/restore safe. Remote: the
terminal is a Session and rides protocol-v1 as-is; the browser inherits the
staged browser-surface gap.

### Open questions

Beyond the two raised inline (the [OSC 367](#osc-367) collision sweep, the
Windows graceful-stop): the dehydrate idle-threshold default; whether `persist`
belongs in the announce or the table (currently the announce — self-knowledge,
like identity); the final marketing noun ("Dor Tools" carries the LLM-tool-use
collision-avoidance; the spec says "tool" throughout).
