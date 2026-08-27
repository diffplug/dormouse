# Dor Tools

> Status: design — nothing here is implemented yet. The whole design lives under
> [Future](#future) per the spec lifecycle; it is written ahead of the code
> because its vocabulary (faces, OSC 367, the announce contract) constrains
> adjacent specs as they evolve.

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane
> vocabulary. Builds on `docs/specs/dor-cli.md` (surface handles, the `ensure`
> spawn path) and `docs/specs/dor-browser.md` (render modes, the iframe proxy);
> this design subsumes the "plugin/backend target axis" staged in that spec's
> Future.

**Pitch**: a Dor Tool is a console app that opens a web port. Dormouse frames
it in a pane where the human and the agent both see it and both drive it — the
human clicks, the agent sees the click; the agent types, the human sees the
typing. No SDK, no protocol: print one escape sequence, read one env var.

## Future

**Scope: dor-tools** — the whole feature, staged. Each phase is one PR, and
each PR's job includes promoting its slice above the fold. The only hard
ordering edge is A before C0; B may land before A.

- **A — faces refactor.** Face predicates (`hasConsoleFace` / `hasWebFace`)
  replace kind switches; CLI gating and error wording recast in the Liskov
  "face-gated" vocabulary; any `--json` contract churn lands here so scripts
  adapt before tools exist. Pure refactor, no user-visible feature.
- **B — `dor open`.** User-level table + dispatch only: entries resolve to a
  terminal command (the `ensure`/`split` machinery) or an existing **browser
  surface** pointing at a host-served viewer page (the iframe-proxy path). No
  OSC, no atom, **nothing new persisted** — viewers are plain browser
  surfaces, so C1 requires zero snapshot migration. VS Code routes `dor open`
  to the native editor and reports which route it took (complete here,
  permanently for v1).
- **C0 — OSC 367 + header chip.** Parse/strip/register/sanitize for the serve
  verb, plus the inert header-chip affordance in ordinary terminals
  (announcement lights a chip; clicking connects via the existing port-connect
  flow). Ships standalone value — any announcing tool gets a clickable chip
  before the atom exists — and exercises the entire security gate with minimal
  UI surface.
- **C1 — the tool atom.** `dor tool`, announce-minted upgrade-in-place,
  identity dedupe, the console toggle, `surfaceType: 'tool'`, kill/teardown
  (forcing the general per-surface teardown hook `docs/specs/dor-browser.md`
  already stages), args-only cold restore. Standalone runs the pipeline behind
  a `dormouse.flags.tools` flag; `dor open` is re-plumbed onto the real path.
- **D1 — reaping without cooperation.** Idle-threshold reap +
  rehydrate-from-args + `persist: "never"`. Covers every stateless tool with
  no new API and no Windows question (a stateless tool can just be killed).
- **D2 — dehydrate/rehydrate.** The `367;dehydrate` verb +
  `DORMOUSE_DEHYDRATE` per the contract below (designed day 1; the `dehydrate`
  flag is reserved in the serve payload from C0). The Windows graceful-stop
  answer is needed here only.
- **Later** — `ab-*` web faces: agent GUI-driving via the agent-browser render
  modes, which requires `dor ab` surface-handle addressing (`dor ab --surface
  surface:N <verb>`), the one genuinely new CLI mechanism the face union
  demands. Pocket/remote web face (rides the browser-surface staging in
  `docs/specs/remote-api.md`; reserve the kind on the wire now). The VS Code
  full pipeline. An in-pane face strip (decide against the glossary's reserved
  multiple-Surfaces-per-Pane). A `boots: web` table hint if the console flash
  grates. `--face` capability filters for `dor list`. A pre-spawn dedupe fast
  path.

### Faces (glossary changes)

The primitive is the **face**, not the kind. A Surface has a **console face**
(PTY + xterm), a **web face** (`BrowserPanel` + `renderMode`), or both. Kinds
become derived names for face-sets: `terminal` = console-only, `browser` =
web-only, `tool` = both. Verbs are **face-gated** — a new Liskov category
beside Process-/View-gated: `read` / `send` / `await` / `--port` require a
console face; nav/render/ab verbs require a web face and stay renderMode-gated
exactly as for browser Surfaces (an iframe-rendered tool cannot be
agent-driven). `kill` / `rename` stay universal. Kinds remain **disjoint** for
`dor list --kind`.

- **Identity**: a tool Surface's id is its SessionId (I1 extends to tools).
  Faces and render modes change over its life without changing identity — the
  tool counterpart of I10, and stronger than browsers have today.
- **Axes**: the tool column of the six-axis table reads "terminal column for
  the console face, browser column for the web face."
- **Activity**: full machine via the PTY; WATCHING defaults off for
  tool-spawned commands (`lib/src/lib/watched-commands.ts` rules).
- **Untouched**: input to **either** face touches — the first web-face
  interaction arms kill-confirm, so an unsaved scratch tool gets the
  confirmation letter while an idle just-opened viewer dies silently.

### OSC 367

`DOR` on a phone keypad. Verb-multiplexed (the OSC 633 pattern): one registry
entry, extensible without burning numbers. Tools emit ST; the parser accepts
BEL. Registered in `docs/specs/terminal-escapes.md`, parsed and stripped at the
PTY data boundary (`lib/src/lib/terminal-protocol.ts`), replay-filtered like
the other reports, payload sanitized and size-capped under the same rules
`docs/specs/alert.md` applies to OSC 9/99/777.

```
ESC ] 367 ; serve ; {"port":4242,"name":"…","identity":"…","dehydrate":true,"persist":"respawn","v":1} ESC \
ESC ] 367 ; dehydrate ; {"v":1, …} ESC \
```

- `serve` — the announcement. `port` (host derives
  `http://localhost:<port>/`), optional `name` (feeds the existing
  title-candidates channel of `docs/specs/terminal-state.md`; priority stays
  user pin > announce name > command), optional `identity` (dedupe key, below),
  `dehydrate` capability flag, `persist` restart policy (`respawn` default |
  `never`), contract version. **Re-emittable, last-write-wins** — a scratch
  tool that saves re-announces with its file as identity.
- `dehydrate` — emitted on the graceful-stop signal; captured, size-capped,
  stored in the pane's persisted params.
- **No third verb, ever.** Titles are OSC 0/2, progress is OSC 9;4: the
  existing escape registry is the rest of the API. The moment a `progress` or
  `title` verb exists, tools have grown a protocol and the pitch is false.
- Transport: ssh-transparent (the reason this is an OSC, not a control-socket
  call — the socket does not exist over ssh); tmux swallows unknown OSCs
  without `allow-passthrough` (tool-author docs, one line). Safe to emit
  unconditionally — well-behaved terminals drop unknown OSCs, so no capability
  sniffing is needed; checking `DORMOUSE_SURFACE_ID` is an optimization only.
- Before freezing: sweep xterm ctlseqs and the iTerm2/kitty/WezTerm/ConEmu
  private ranges to confirm 367 is clean. Runners-up: 3676 (`DORM`), 4242.

### Lifecycle

**Spawn**: shell-hosted PTY through the `ensure` spawn path
(`dor/src/commands/ensure.ts` semantics: prompt-wait typing, per-shell quoting
via `dor/src/commands/shell-quote.ts`, command-exit tracking). Console face
front from spawn — startup logs beat any spinner, and a command that never
announces is simply a terminal running a TUI: a complete outcome, not a
degraded one. A "TUI tool" is a registry entry whose command never announces.

**Announce** → the same Surface **grows a web face** in place: no replacement,
no ref transfer, no new id — params gain the web face and `surfaceType` flips
by derivation. The pane flips to the GUI face; the console face sits behind a
toggle on the header's far-left chip. Accepted: a fast tool flashes its console
for ~100ms; the flip animation makes it read as teaching the two-face model.

**Command exit** → the web face is retired and the pane flips to the console —
a shell prompt above the tool's dying words, the correct debugging posture.
Re-running the command re-announces and revives the web face on the same
Surface.

**Kill** → universal; reaps the process and the web face's backing resources.

### Identity and dedupe

Identity is computed by the party that understands it — the tool. The host
cannot know that `README.md`, `./readme.md`, and a symlink are one document, or
that a diagram editor is ephemeral until saved and *becomes* its save-file
afterward.

- **Scope**: dedupe matches on *(tool name as the host knows it from the
  spawn)* × *(identity string from the OSC)*. The payload cannot claim to be a
  different tool. Identityless tools are never deduped — scratch semantics.
- **On match**: the new spawn is redundant — graceful-stop it, tear the pane
  down through the existing untouched-kill path (no confirmation; untouched by
  construction), reveal the survivor, and report the survivor's handle with an
  `ensure`-style reuse note.
- **Races**: concurrent spawns serialize at announce; first wins.
- **Containment**: an identity match only ever *reveals* a surface — it never
  transfers state, grants, or input. Worst case for a spoofed identity is a
  wrong pane getting focus.
- **Blessed pattern**: announce-and-let-Dormouse-dedupe. A tool doing VS
  Code-style internal forwarding (second invocation hands off and exits) looks
  to Dormouse like a failed tool; warn against it.

### Dehydrate and rehydrate

For tools announcing `dehydrate: true`. Reap on an idle threshold while
`Doored` / `Hidden` (never on the minimize itself — reattach must not cost a
boot every time), or under memory pressure:

1. Host sends the graceful-stop signal (grace window).
2. Tool emits `367;dehydrate;{json}` on the way out; host captures and
   persists it.
3. Rehydrate = respawn the command with `DORMOUSE_DEHYDRATE` in the env,
   rendered per-shell by the shell-quote module.

Degradation tiers, Lath-restore-token style: dehydrated state → bare args →
error. **Args-only restart is the mandatory floor; the dehydrate payload is
fidelity, never correctness.** The payload is small, versioned JSON — never a
document (the standalone session blob has bloated storage before). A hung tool
cannot block anything: request, grace, kill anyway, fall back to args. Open
question: the Windows graceful-stop (no SIGTERM to console apps; candidates:
an opt-in input sequence, or dehydrate-on-every-announce as the Windows
fallback).

### CLI

- `dor tool <name> [args]` — launch a registered tool by name. **Fresh
  instance every time**; there is no `--key` — identity lives in the OSC.
- `dor open <target>` — sugar over `dor tool`: glob table → tool name → render
  the template with the resolved absolute target → same launch path. Reuse
  arrives via the standard identity convention: target-dispatched tools
  announce `realpath(target)`.
- **cwd**: the caller's PWD resolves the argument (existing `--cwd`
  machinery); the session's cwd is `dirname(target)` (or the target directory),
  falling back to caller PWD only when the tool has no path target. Templates
  render absolute paths, so the rendered command and cwd are deterministic
  functions of the target — reuse and cold restore both become
  caller-independent, and relative assets (a markdown image whose src is
  `diagram.png`) resolve for the tool itself.
- `dor list`: rows report `kind: tool` with the web face's `render_mode`; the
  location column shows the **target**, else the announce name (cwd and
  localhost URLs are plumbing); JSON carries target + cwd + url.

### The table

User-level config **only** — a project-local table is arbitrary code execution
via `dor open README.md` in a malicious repo. Host-resolved, not CLI-resolved:
one source of truth, reachable by GUI gestures (file drop) as well as the CLI.
Two sections: named tools (name → command template) and glob rules (pattern →
tool name). Entries may dispatch to plain terminal commands (`*.*` → a pager) —
the atom is minted by the announcement, not by the table.

Hosts: standalone runs the real pipeline behind the flag; VS Code v1 routes
`dor open` to the native editor (an in-pane md/code viewer competes with the
editor, which the native-first principle forbids) and reports which route it
took — an agent in VS Code loses sight of what it opened, which is accepted for
v1 and is the eventual argument for the full pipeline there.

### Security

Auto-upgrade on announce is honored **only in tool-pipeline sessions and only
while the spawned command is the foreground process** (command-exit tracking
knows). Everywhere else — ordinary terminals, post-exit — the announcement
lights an inert affordance: a chip in the pane header, the Dev-Server Chip
pattern (the declared upgrade of the port scan), and clicking it is the user
gesture that connects. Output alone never creates surfaces.

### Persistence and hosts

`PersistedPane` gains `surfaceType: 'tool'`; params
`{command, args, cwd, renderMode, url?, identity?, persist?, dehydrated?}`
(`docs/specs/transport.md` owns the persisted shapes; `lib/src/lib/session-types.ts`).
Cold restore: `persist: "never"` rows are dropped silently (a clock, a
calculator); the default respawns command + dehydrated state. Remote: the console face is
a Session and rides protocol-v1 as-is; the web face inherits the staged
browser-surface gap.

### Open questions

The OSC-367 collision sweep before freezing; the dehydrate idle-threshold
default; whether `persist` belongs in the announce or the table (currently the
announce — self-knowledge, like identity); the final marketing noun ("Dor
Tools" carries the LLM-tool-use collision-avoidance; the spec says "tool"
throughout).
