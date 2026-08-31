# Dor Tools

> Status: design. The `tool` Surface does not exist yet; the only implemented
> piece is the shared capability gating below. Everything else is under
> [Future](#future).

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane
> vocabulary. Builds on `docs/specs/dor-cli.md` (surface handles, the `ensure`
> spawn path) and `docs/specs/dor-browser.md` (render modes, the iframe proxy,
> the Dev-Server Chip port scan); this design subsumes the "plugin/backend
> target axis" staged in that spec's Future.

**Pitch**: a Dor Tool is a console app that opens a web port. Dormouse frames
it in a pane where the human and the agent both see it and both drive it — the
human clicks, the agent sees the click; the agent types, the human sees the
typing. No SDK, no protocol, and in the common case no cooperation: Dormouse
already watches the ports its Sessions bind.

## Capability gating

Phase A of the ledger below is implemented, and nothing in it is
`tool`-specific, so it is documented where it belongs: the capability model and
its `hasTerminal` / `hasBrowser` predicates in `docs/specs/glossary.md` → Panes
and Surfaces, the `dor list --json` `has_terminal` / `has_browser` row fields
and the matching `has no terminal` / `has no browser` failures in
`docs/specs/dor-cli.md` → `dor list`.

Source of truth: `dor/src/commands/types.ts` (the `KIND_CAPABILITIES` table
both predicates read, and `SURFACE_KINDS` derived from it so `--kind` parsing
cannot drift), `dor/src/commands/list.ts`,
`lib/src/components/wall/use-dor-control.ts` (`requireTerminalSurface` /
`requireBrowserSurface`, the host-side gates that emit those failures).

What this spec still owes is the kind that has both — see
[The tool capability set](#the-tool-capability-set).

## Future

**Scope: dor-tools** — what remains, staged, one phase per PR. (Phase A, the
capability refactor, is implemented; see
[Capability gating](#capability-gating).)

- **B1 — the tool atom.** `dor tool` in both forms, repo-local `dormouse.yml`
  with `prespawn_dedupe`, the [trust](#trust) gate, port-triggered
  [upgrade-in-place](#serving), `surfaceType: 'tool'`, the terminal toggle,
  kill/teardown (forcing the per-surface teardown hook
  `docs/specs/dor-browser.md` stages), args-only cold restore. No OSC, no
  prespawn process, no glob table. Standalone gates it on
  `dormouse.flags.tools` (`lib/src/lib/feature-flags.ts`).
- **B2 — OSC 367 `serve` + header chip.** Parse/strip/register/sanitize, the
  runtime re-key, and the inert chip in ordinary terminals. Ships value alone —
  any announcing tool gets a clickable chip — and exercises the security gate
  with minimal UI. `dev:standalone:ab` is the first announcer.
- **B3 — `ab-*` rendering for tools.** Agent GUI-driving of a tool's browser.
  Its CLI mechanism, `dor ab --surface surface:N <verb>`, is shipped
  (`docs/specs/dor-cli.md` → Agent-Browser Surface Addressing); what remains is
  pointing it at a `tool` Surface and letting a tool declare its renderer.
- **C — glob table + `dor open`.** The user-global tools file, glob rules
  (pattern → tool name), `dor open <target>` as sugar over `dor tool`, argument
  substitution in `prespawn_dedupe` so per-target viewers do not collapse into
  one pane, and the loopback file/viewer endpoint a local *file* needs (the
  iframe proxy instruments only `http://` upstreams).
- **D1 — reaping without cooperation.** Idle-threshold reap +
  rehydrate-from-args + `persist: "never"`: every stateless tool, no new API,
  no Windows question.
- **D2 — dehydrate/rehydrate.** The `367;dehydrate` verb +
  `DORMOUSE_DEHYDRATE`; the `dehydrate` flag is reserved in the serve payload
  from B2. The Windows graceful-stop is needed here only.
- **Later** — `prespawn_*` beyond the dedupe literal: a computed key, and
  `prespawn_port`. Pocket/remote browser view (rides the browser-surface
  staging in `docs/specs/remote-api.md`; reserve the kind on the wire now). The
  VS Code pipeline. An in-pane terminal/browser strip (decide against the
  glossary's reserved multiple-Surfaces-per-Pane). A `boots: web` hint if the
  terminal flash grates. `--has terminal` / `--has browser` for `dor list`.

### The tool capability set

`tool` = terminal + browser, the third kind in the live gating. Verbs stay
gated on the capability they need, and browser verbs stay renderMode-gated (an
iframe-rendered tool cannot be agent-driven). `kill` / `rename` stay universal;
kinds remain **disjoint** for `dor list --kind`.

- **Identity**: a tool Surface's id is its SessionId (I1 extends to tools).
  Capabilities and render modes change over its life without changing identity
  — the tool counterpart of I10, stronger than browsers have today.
- **Render swaps bypass `replaceSurface`.** A tool's browser is a param of its
  own leaf: swapping `iframe` ⇄ `ab-*` mutates `renderMode` in place instead of
  routing through the browser-surface replacement path, which is what makes the
  invariant above true.
- **Axes**: the tool column of the six-axis table reads terminal-column
  semantics for its terminal, browser-column for its browser.
- **Activity**: full machine via the PTY; WATCHING defaults off for
  tool-spawned commands (`lib/src/lib/watched-commands.ts` rules).
- **Untouched**: input to **either** capability touches, so the first
  browser-side interaction arms kill-confirm — an unsaved scratch tool gets the
  confirmation letter while an idle just-opened viewer dies silently.

### Declaring tools

A repo declares its tools in a `dormouse.yml` at its root: a name → entry map
whose only required field is the command.

```yaml
tools:
  storybook:
    run: pnpm storybook
    prespawn_dedupe: [storybook, $PROJECT_ROOT]
```

- **`run`** — typed into the spawned shell exactly as `dor ensure` types one.
- **`prespawn_dedupe`** — the dedupe key, evaluated before anything spawns (see
  [Identity and dedupe](#identity-and-dedupe)). Optional; absence means no
  dedupe.
- **`dormouse.yml` holds static facts; OSC 367 carries what changes at
  runtime.** A title, or a key that changes when a scratch document is saved,
  is [OSC](#osc-367), never a file field.
- **Never give `prespawn_dedupe` a second value shape.** `prespawn_*` is
  reserved, and staged additions each take their own field name (rationale).
- **Must reject an unrecognized `$NAME` at parse**, never keep it as a literal
  (rationale). Substitutions are a closed set: `$PROJECT_ROOT` (the directory
  holding the declaring `dormouse.yml`) and `$CWD` (the caller's resolved PWD);
  phase C adds argument substitution.
- **Must reject `$PROJECT_ROOT` in the phase-C user-global file**, where no
  project root is defined.
- **Should warn on a repo-local key without `$PROJECT_ROOT`**, naming the file:
  it dedupes across every checkout declaring that name. Warning, not error — a
  repo-declared machine-wide singleton is legitimate.

A bare scalar is one element (`prespawn_dedupe: clock`).

### Identity and dedupe

**A tool has an identity if and only if it was given one.** No key is derived
from the command, the cwd, or anything else the host can see; an entry with no
`prespawn_dedupe`, and every `dor tool -- <command>`, spawns a fresh Surface
every time (rationale).

- **Namespacing is host-enforced.** Keys compare within the tool identity the
  host resolved from the spawn; the declared list is scope inside that
  namespace, and a key's first element is never trusted as a tool name.
  Without this the runtime re-key of [OSC 367](#osc-367) is an impersonation
  primitive.
- **Dedupe at spawn time only.** A key matching a live Surface means the new
  spawn is redundant by construction, so it never starts: the survivor is
  revealed and its handle reported with an `ensure`-style reuse note.
- **A runtime re-key never dedupes.** It re-labels its own Surface and nothing
  else — killing either side of a late collision would destroy work.
- **Scope is a slot, not a convention.** Keys are lists so parallel worktrees
  differ by `$PROJECT_ROOT` rather than by an author remembering to concatenate
  one in (rationale).
- **A key match only reveals**, never transferring state, grants, or input; the
  worst case for a spoofed key is a wrong pane getting focus.
- **Races**: concurrent spawns serialize on the key; first wins.

### Trust

`dormouse.yml` is repo-controlled and its entries execute, so it is inert until
the repo is trusted. The phase-C user-global file needs none of this.

1. **Keyed on the absolute repo root**, granted once and remembered. Denial is
   remembered too, so a hostile repo cannot re-ask every invocation.
2. **Only a gesture in Dormouse's own chrome grants it** — a dialog naming the
   repo and the command, never a prompt rendered as terminal output. The
   [naked-prompt test](#cli) signals human intent but is not a security
   boundary (rationale). Same shape as the local-approval ceremony in
   `docs/specs/remote-security-model.md`.
3. **Agents cannot grant trust.** `dor tool <name>` against an untrusted repo
   fails, telling the caller to have a human approve it.
4. **Anything `prespawn_*` is behind the same gate**, since it executes — the
   natural implementation order, probe-then-prompt, is backwards.
5. **The phase-C glob table stays user-global and may only name user-global
   tools.** Implicit dispatch reaching repo-local entries is the
   `dor open README.md`-in-a-malicious-repo attack.
6. **Path-level, never content-hashed.** A `dormouse.yml` that changes under a
   trusted root does not re-prompt (rationale).

### Serving

A tool's browser appears when Dormouse learns the tool is serving. Two triggers
feed one internal upgrade path; the atom does not care which fired.

- **The port scan is the primary trigger** and the only one correct under
  contention: it reports the port actually **bound**, where an announcement
  states intent (rationale). Already shipped for the Dev-Server Chip, scanning
  a Session's own process tree.
- **OSC 367 is the disambiguator, never the trigger.** It names *which* of a
  multi-port tool's ports to frame, plus ssh transparency, a name, and a
  runtime re-key. The hint names the port; the scan supplies the number.
- **Upgrade requires a tool-designated Session with its spawned command still
  in the foreground** (see [Security](#security)).

**Reserved:** a tool's URL is derived, never restored verbatim (see
[Persistence and hosts](#persistence-and-hosts)) — a precondition for
`prespawn_port` in the scope **dor-tools** [Later](#future), where Dormouse
picks a free port and exports
`DORMOUSE_TOOL_PORT`, so `storybook dev -p ${DORMOUSE_TOOL_PORT:-6006}` cannot
collide across worktrees. It supplements the scan rather than replacing it.

Source of truth (shipped scan): `lib/src/components/wall/use-dev-server-ports.ts`,
`lib/src/components/wall/port-url.ts`, `lib/src/components/wall/connect-port.ts`.

### Lifecycle

**Spawn** — a shell-hosted PTY using the `ensure` spawn path's mechanics
(`dor/src/commands/ensure.ts`: prompt-wait typing, per-shell quoting via
`dor/src/commands/shell-quote.ts`, command-exit tracking) but **not** its
command+cwd matching. Terminal front from spawn; a command that never serves is
a terminal running a TUI, which is a complete outcome.

**Serving** → the Surface **grows a browser in place**: no replacement, no ref
transfer, no new id — params gain the browser and `surfaceType` flips by
derivation. The pane flips to the browser, terminal behind the header's
far-left chip. Accepted: a fast tool flashes its terminal for ~100ms.

**Command exit** → the browser retires and the pane flips back to a prompt
above the tool's dying words; re-running revives it on the same Surface.
**Kill** → universal, reaping the process and the browser's resources.

`surfaceKindFromParams` (`lib/src/components/wall/browser-surface.ts`) is the
params → kind seam; its own comment warns the compiler cannot force the edit,
so a `tool` params shape carrying a `renderMode` classifies as `browser` until
taught otherwise.

### CLI

- **`dor tool -- <command>`** — designate an arbitrary command as a tool. No
  key, always a fresh Surface; distinct from `dor split` because it arms the
  [serving](#serving) trigger.
- **`dor tool <name> [args]`** — run a `dormouse.yml` entry with whatever
  `prespawn_dedupe` it declares.
- **Takes over the calling pane only when the invocation is the sole command on
  the line, the pane is at a prompt, and the pane is not already a tool.**
  Typing a command at a prompt runs it there; splitting would be the surprise.
  The test is on command shape, so `dor tool storybook --fresh` qualifies.
- **Must split focus-neutrally whenever that is unclear** — a script, an agent,
  a compound line, a shell without integration, a busy pane — and return a
  handle.
- **A keyed invocation that matches reveals and reports**, in both placements,
  so the calling pane never appears to do nothing.
- `dor list`: rows report `kind: tool` with `render_mode`; the location column
  shows the announce name, else the command; JSON carries command + cwd + url.

### OSC 367

`DOR` on a phone keypad. Verb-multiplexed (the OSC 633 pattern): one registry
entry, extensible without burning numbers. Tools emit ST; the parser accepts
BEL. Registered in `docs/specs/terminal-escapes.md`, parsed and stripped at the
PTY data boundary (`lib/src/lib/terminal-protocol.ts`), replay-filtered like
the other reports, sanitized and size-capped under the rules
`docs/specs/alert.md` applies to OSC 9/99/777.

```
ESC ] 367 ; serve ; {"port":4242,"name":"…","key":["…"],"dehydrate":true,"persist":"respawn","v":1} ESC \
ESC ] 367 ; dehydrate ; {"v":1, …} ESC \
```

- `serve` — refines what the scan found, never mints a tool. `port` names which
  port to frame; `name` feeds the title candidates of
  `docs/specs/terminal-state.md` (priority stays user pin > announce name >
  command); `key` re-keys under the host's namespace; `dehydrate` capability
  flag; `persist` (`respawn` default | `never`); contract version.
  **Re-emittable, last-write-wins.**
- `dehydrate` — emitted on graceful stop; captured, size-capped, stored in the
  pane's persisted params.
- **Never add a third verb.** Titles are OSC 0/2, progress is OSC 9;4; the
  existing escape registry is the rest of the API.
- **Safe to emit unconditionally** — well-behaved terminals drop unknown OSCs,
  so checking `DORMOUSE_SURFACE_ID` is an optimization only. ssh-transparency is
  why this is an OSC and not a control-socket call; tmux needs
  `allow-passthrough` (tool-author docs, one line).
- Before freezing: sweep xterm ctlseqs and the iTerm2/kitty/WezTerm/ConEmu
  private ranges. Runners-up: 3676 (`DORM`), 4242.

### Dehydrate and rehydrate

For tools announcing `dehydrate: true`. Reap on an idle threshold while
`Doored` / `Hidden` — including an inactive Workspace's Surfaces — **never on
the minimize itself** (reattach must not cost a boot) or under memory pressure.
The headline case is Workspaces: an inactive one full of dehydratable tools
drops to zero processes, relieving the parked-surface pressure the workspaces
rollout projects (`docs/specs/layout.md` Stage 4; `MAX_PARKED_SURFACES` in
`docs/specs/tiling-engine.md`).

**This is an in-session mechanism.** The payload lives with the running host;
whether it survives a host quit follows each host's session-persistence story
(`docs/specs/transport.md`). The flow: host sends the graceful-stop signal →
tool emits `367;dehydrate;{json}` on the way out → rehydrate respawns with
`DORMOUSE_DEHYDRATE` in the env.

**Args-only restart is the mandatory floor; the payload is fidelity, never
correctness.** Degradation is Lath-restore-token style — dehydrated state →
bare args → error. Small versioned JSON, never a document. A hung tool blocks
nothing: request, grace, kill anyway, fall back to args.

### Security

Three gates, one per actor:

1. **Repo-controlled config executes only after a human approves the repo** —
   see [Trust](#trust).
2. **Only a tool-designated Session upgrades in place**, designation being the
   `dor tool` spawn. Elsewhere the [serving](#serving) trigger is ignored and
   the announcement lights the inert Dev-Server Chip, whose click is the
   gesture that connects. **Output alone never creates surfaces.**
3. **Upgrade requires the spawned command to still be the foreground process**,
   so an exited tool's pane cannot be re-pointed by whatever runs next.

**Accepted risk — content-driven announce inside a blessed tool.** A tool
rendering hostile bytes (a pager on a malicious file) passes the foreground
gate, so embedded bytes can name an attacker-chosen port and re-point the
browser at a service already listening locally, under the tool's name. The
residual is a mislabeled view of the user's own service, inert without further
gestures (rationale). Escalations if that changes: gesture-gate re-announces
that move the port, or constrain the framed port to the session's process tree
— not the default, since it breaks tools wrapping double-forking daemons.

### Persistence and hosts

`PersistedSurfaceType` gains `'tool'`; params
`{command, args, cwd, renderMode, key?, persist?}` (`docs/specs/transport.md`
owns the persisted shapes; `lib/src/lib/session-types.ts`). Because `'tool'` is
a new type rather than an edit to an existing one, everything staged after B1
is additive and no snapshot migration is required.

**The URL is never persisted.** A tool's port is whatever it bound this time,
so the URL is re-derived from the [scan](#serving) after respawn. A restored
tool is a terminal running its command until it serves again — the same state a
cold spawn passes through.

The dehydrated payload is in-session state, not persisted params. Cold restore
follows each host's session-restore story: `persist: "never"` rows drop silently
and the default respawns from bare args. Remote: the terminal rides protocol-v1
as-is; the browser inherits the staged browser-surface gap.

**`dor tool` is never routed to a native editor** — a verb returning a handle
on one host and a note on another is one command with two types (rationale).
Until the pipeline lands in VS Code it fails there, pointing at the editor;
handing a target to the host's editor is a separate additive verb.

### Open questions

- **Does a key match a Surface whose command has exited?** `ensure` stops
  matching a dead command because it targets arbitrary shells; a tool Surface
  is dedicated, so that ambiguity does not exist. Leaning: reuse and re-run in
  place, keeping position and scrollback.
- **Which renderer does a tool get?** B1 gives every tool an `iframe`; B3 needs
  `ab-screencast`, and that choice is arguably the repo's rather than the
  tool's, making it a `dormouse.yml` field.
- The [OSC 367](#osc-367) collision sweep; the Windows graceful-stop; the
  dehydrate idle threshold; whether `persist` belongs in the announce or the
  file; the final marketing noun.
