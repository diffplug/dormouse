# Dor Tools

> Status: the `tool` Surface is implemented, behind the `dormouse.flags.tools`
> localStorage flag (`lib/src/lib/feature-flags.ts`) — off by default, so
> nothing is designated a tool and no pane can transform. The glob table,
> `dor open`, reaping, and dehydrate/rehydrate remain under
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

The kind that has both is [`tool`](#the-tool-capability-set).

## The tool capability set

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

## Declaring tools

A repo declares its tools in a `dormouse.yml` at its root: a name → entry map
whose only required field is the command.

```yaml
tools:
  storybook:
    run: pnpm storybook
    prespawn_dedupe: [storybook, $PROJECT_ROOT]
```

- **`run`** — typed into the spawned shell exactly as `dor ensure` types one.
- **`render`** — `iframe` (default) or `ab-screencast`. The repo declares the
  renderer, not the tool: which one suits a tool is a Dormouse-side judgement,
  and `ab-screencast` is what makes a tool agent-drivable, since browser verbs
  stay renderMode-gated. **The Display modal never offers pop-out on a tool** —
  there is no third renderer to land in, so the swap would only re-derive the
  one it has.
- **`port`** — `announced` (default) or `auto`, deciding how a port is chosen
  when the tool has not announced one; an announcement always wins over either.
  See [Serving](#serving) for what each does.
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

- **An unknown `prespawn_*` field is a parse error**, where an unknown ordinary
  field only warns. Silently dropping a dedupe directive is the destructive
  failure; failing to parse is the loud one.

A bare scalar is one element (`prespawn_dedupe: clock`).

Source of truth: `lib/src/host/tool-registry.ts` (parsing, substitution, key
rendering), `lib/src/host/tool-trust.ts` (discovery — the walk up to the
nearest file), `lib/src/host/tool-host.ts` (the entry both hosts install). The
repo's own `dormouse.yml` is pinned against the parser in
`lib/src/host/tool-registry.test.ts`.

## Identity and dedupe

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
- **A match whose command has exited is re-run in place**, keeping the pane's
  position and scrollback, and reported as `adopted`. `ensure` stops matching a
  dead command because it targets arbitrary shells that may be busy with
  something else; a tool Surface is dedicated, so that ambiguity does not exist.
- **Races**: concurrent spawns serialize on the key; first wins.

Source of truth: the `surface.tool` handler in
`lib/src/components/wall/use-dor-control.ts`; `resolveDedupeKey` in
`lib/src/host/tool-registry.ts`; `toolKeysEqual` in
`lib/src/components/wall/browser-surface.ts`.

## Trust

`dormouse.yml` is repo-controlled and its entries execute, so it is inert until
the repo is trusted. The phase-C user-global file needs none of this.

1. **Keyed on the branch's upstream remote URL**, canonicalized, so every
   worktree and clone of one repo shares a grant. A folder grant covers one
   project root instead, for a repo with no resolvable remote or a checkout the
   user wants scoped. Either key satisfies the check.
2. **Only a gesture in Dormouse's own chrome grants it** — a prompt in the
   tool's own pane naming the command, never one rendered as terminal output. The
   [naked-prompt test](#cli) signals human intent but is not a security
   boundary (rationale). Same shape as the local-approval ceremony in
   `docs/specs/remote-security-model.md`.
3. **Agents cannot grant trust.** `dor tool <name>` against an unapproved repo
   creates the Surface and reports `pending`, never minimized — a pane the user
   cannot see is a pane they cannot approve, so a requested `--minimize` is
   applied after approval instead. A pending Surface is not persisted: it
   restores as a plain terminal, since the grant it was asking for was never
   made. Approval re-resolves the entry, so the tool runs with the `render`,
   `port` and key its file declares. its pane shows what would run and
   waits. **Nothing from the repo executes until a human chooses** — no PTY is
   spawned, so not even a shell starts. **Declining closes the pane and records
   nothing** (rationale).
4. **Anything `prespawn_*` is behind the same gate**, since it executes — the
   natural implementation order, probe-then-prompt, is backwards.
5. **The phase-C glob table stays user-global and may only name user-global
   tools.** Implicit dispatch reaching repo-local entries is the
   `dor open README.md`-in-a-malicious-repo attack.
6. **Never content-hashed.** A `dormouse.yml` that changes under a granted key
   does not re-prompt (rationale).
7. **The upstream comes from the repo and is not verified.** `.git/config` is
   repo-controlled, so a directory shipping its own `.git` inherits whatever
   grant its claimed URL has. **Accepted risk** — cloning is unaffected, since
   there the user chose the URL (rationale).

Source of truth: `lib/src/host/tool-trust.ts` (the record and its two key
kinds), `lib/src/host/git-upstream.ts` + `lib/src/host/git-remote-url.ts` (how a
project resolves to an upstream key), and
`lib/src/components/wall/ToolApproval.tsx` (the only grant path).

## Serving

A tool's browser appears when Dormouse learns the tool is serving. Two triggers
feed one internal upgrade path; the atom does not care which fired.

- **The port scan is the primary trigger** and the only one correct under
  contention: it reports the port actually **bound**, where an announcement
  states intent (rationale). Already shipped for the Dev-Server Chip, scanning
  a Session's own process tree.
- **OSC 367 is the disambiguator, never the trigger.** It names *which* of a
  multi-port tool's ports to frame, plus ssh transparency, a name, and a
  runtime re-key. The hint names the port; the scan supplies the number.
- **`port: announced` frames nothing without OSC 367**; `port: auto` autobinds.
- **Autobind never chooses among ports.** Exactly one bound port is framed;
  **two or more frames nothing** and the pane shows the conflict where the
  browser would have gone (rationale).
- **Autobind waits for the port set to settle** — one unchanged tick — before it
  commits, since ports appear one at a time during boot and a framed leaf is
  never re-scanned (rationale). Accepted limit: a port opening long after settle
  is not noticed.
- **`dor tool -- <command>` autobinds**, having nowhere to declare otherwise;
  a declared tool opts in with one line.
- **Upgrade requires a tool-designated Session with its spawned command still
  in the foreground** (see [Security](#security)).

**Reserved:** a tool's URL is derived, never restored verbatim (see
[Persistence and hosts](#persistence-and-hosts)) — a precondition for
`prespawn_port` in the scope **dor-tools** [Later](#future), where Dormouse
picks a free port and exports
`DORMOUSE_TOOL_PORT`, so `storybook dev -p ${DORMOUSE_TOOL_PORT:-6006}` cannot
collide across worktrees. It supplements the scan rather than replacing it.

Source of truth: `lib/src/components/wall/use-tool-serving.ts` (the trigger,
the renderer split, and the agent-browser session binding),
`listenerUrlsByPort` in `lib/src/components/wall/port-url.ts`,
`lib/src/lib/tool-announce-store.ts`.

## Lifecycle

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
above the tool's dying words; re-running revives it on the same Surface. A port
conflict retires with it, so a re-run gets a fresh verdict.
**Kill** → universal, reaping the process and the browser's resources.

**`surfaceKindFromParams` must test for a tool before it tests for a browser**,
because a serving tool also carries a `renderMode`. The compiler cannot force
that edit — a boolean-derived return type-checks against a widened
`SurfaceKind` — so it is pinned by
`lib/src/components/wall/tool-surface.test.ts`.

Source of truth: `lib/src/components/wall/ToolPanel.tsx` (both halves mounted,
visibility flipped), `ToolPaneHeader.tsx` (the leading chip plus the delegated
header), `isToolParams` / `toolFace` in `browser-surface.ts`,
`toolLeafMeta` + `shouldParkOnMinimize` in `lath-wall-engine.ts`.

## CLI

- **`dor tool -- <command>`** — designate an arbitrary command as a tool. No
  key, always a fresh Surface; distinct from `dor split` because it arms the
  [serving](#serving) trigger.
- **`dor tool <name>`** — run a `dormouse.yml` entry with whatever
  `prespawn_dedupe` it declares.
- **Always splits focus-neutrally** and returns a handle. Taking over the
  calling pane when a human types the invocation alone at a prompt is designed
  but not built — see [Future](#future).
- **A keyed invocation that matches reveals and reports**, in both placements,
  so the calling pane never appears to do nothing.
- `dor list`: rows report `kind: tool` with `render_mode`; JSON carries command
  + cwd + url. The location column shows the cwd, pending the announce name.

Source of truth: `dor/src/commands/tool.ts` and its help snapshot
`dor/test/snapshots/help/tool.md`; `surface.tool` in `dor/src/protocol.ts`.

## OSC 367

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
  port to frame; `name` is **reserved**: parsed,
  sanitized, and recorded, but nothing consumes it yet — it will feed the title
  candidates of `docs/specs/terminal-state.md` (priority user pin > announce
  name > command), see [Future](#future); `key` re-keys under the host's namespace; `dehydrate` capability
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
- No replay filter: 367 elicits no response, and replaying the hint after a
  reconnect is what restores it.
- Before freezing: sweep xterm ctlseqs and the iTerm2/kitty/WezTerm/ConEmu
  private ranges. Runners-up: 3676 (`DORM`), 4242.

Source of truth: `lib/src/lib/tool-announce.ts`, `lib/src/lib/osc-sanitize.ts`
(shared with OSC 9/99/777), `lib/src/lib/tool-announce-store.ts`, and the `367`
arm of `lib/src/lib/terminal-protocol.ts`. The harness's own announcement is
pinned by `standalone/scripts/dev-agent-browser-announce.test.mjs`.

## Security

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

## Persistence and hosts

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
Handing a target to the host's editor is a separate additive verb.

Source of truth: `PersistedSurfaceType` in `lib/src/lib/session-types.ts`;
`toolControl` in `lib/src/lib/platform/types.ts` with its host implementations
(`vscode-ext/src/tool-host.ts`, and `tool_control` in
`standalone/src-tauri/src/lib.rs` bridging to `standalone/sidecar/main.js`).

## Future

**Scope: dor-tools** — what remains, staged, one phase per PR. The atom (both
`dor tool` forms, `dormouse.yml`, trust, the serving trigger, OSC 367, and
`ab-*` rendering) is implemented and described above.

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
  from the shipped `serve` payload. The Windows graceful-stop is needed here
  only.
- **Pane take-over.** `dor tool` typed alone at a prompt should run in that
  pane rather than splitting — typing a command at a prompt is how a terminal
  works. The gate is three conditions the host can already read (sole command on
  the OSC 633 line, pane at a prompt, pane not already a tool); what it needs is
  the handshake, since `dor` is itself the foreground process when it answers,
  so the command can only be typed once its own shell returns to a prompt.
- **The announced `name`.** Wire the reserved [OSC 367](#osc-367) `name` into
  the title-candidates channel and `dor list`'s location column.
- **Later** — `prespawn_*` beyond the dedupe literal: a computed key, and
  `prespawn_port`. Pocket/remote browser view (rides the browser-surface
  staging in `docs/specs/remote-api.md`; reserve the kind on the wire now). The
  VS Code pipeline. An in-pane terminal/browser strip (decide against the
  glossary's reserved multiple-Surfaces-per-Pane). A `boots: web` hint if the
  terminal flash grates. `--has terminal` / `--has browser` for `dor list`.

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

### Open questions

The [OSC 367](#osc-367) collision sweep before the contract is frozen (xterm
ctlseqs plus the iTerm2/kitty/WezTerm/ConEmu private ranges; runners-up 3676
and 4242); the Windows graceful-stop for D2; the dehydrate idle-threshold
default; whether `persist` belongs in the announce or the file (currently the
announce — self-knowledge, like a runtime re-key); the final marketing noun
("Dor Tools" carries the LLM-tool-use collision-avoidance; the spec says
"tool" throughout).
