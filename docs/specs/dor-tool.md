# Dor Tools

> See `docs/specs/glossary.md` for Surface / Session / Pane / Door vocabulary.
> Owns tool designation, configuration, trust workflow, serving, and command lifecycle. Browser chrome belongs to `docs/specs/dor-browser.md`; notes and closure belong to `docs/specs/notepad.md`; helpers belong to `docs/specs/terminal-context.md`.
> Status: implemented behind `dormouse.flags.tools`, off by default. Unbuilt design is under [Future](#future).

## Files

- `dor/src/commands/tool.ts` — CLI entry and generated help.
- `lib/src/host/tool-host.ts` — shared host lookup and trust entry.
- `lib/src/components/wall/use-dor-control.ts` — launch, approval placement, dedupe, and response orchestration.
- `lib/src/components/wall/use-tool-serving.ts` — port discovery and browser lifetime.
- `lib/src/components/wall/ToolPanel.tsx` — terminal/browser composition.

## Capability gating

**Must gate tool creation on `isToolsEnabled`.** The flag disables new designation; existing Tools retain serving and exit cleanup. Inert announcement parsing and capability predicates remain active. Capability semantics belong to `docs/specs/glossary.md` → Panes and Surfaces; CLI reporting belongs to `docs/specs/dor-cli.md` → `dor list`.

Source of truth: `isToolsEnabled` in `lib/src/lib/feature-flags.ts`; `surface.tool` in `lib/src/components/wall/use-dor-control.ts`; `useToolServing` in `lib/src/components/wall/use-tool-serving.ts`.

## The tool capability set

**Must designate the Surface as `tool` before its command starts serving.** A Tool has terminal and browser capabilities, including while booting, awaiting approval, showing a port conflict, or resting at a prompt after command exit. Browser operations still require the renderer/session they operate on.

- **Must retain the Session id, public Surface ref, terminal and notes across serving and renderer changes.** These are changes within one Surface.
- **Must bypass browser `replaceSurface` for Tool renderer swaps**, mutating the Tool's params and releasing the retired browser resources.
- **Must run the terminal Activity model for a Tool**, including when its browser is visible. Watched-command defaults belong to `docs/specs/alert.md`.
- **Never apply the untouched-shell kill or shell-replacement shortcut to a Tool**, which spawns touched.
- **Must classify Tool params before browser params**, since a serving Tool carries `renderMode` too.

Source of truth: `surfaceKindFromParams` / `isToolParams` in `lib/src/components/wall/browser-surface.ts`; `onSwapRenderMode` / `requestKill` / `isUntouchedShell` in `lib/src/components/Wall.tsx`; `lib/src/components/wall/tool-surface.test.ts`.

## Declaring tools

**Must resolve a named Tool from the nearest ancestor `dormouse.yml`, then fall back to user Tools when that name is absent.** `--global` skips project discovery. A malformed project file fails lookup rather than falling back. The host owns discovery, bounded reads, YAML parsing, and substitutions; the renderer receives the resolved result. Canonical field shapes are `ToolEntry` in `lib/src/host/tool-registry.ts`.

**Must read user Tools from `$XDG_CONFIG_HOME/dormouse/dormouse.yml` when that environment value is absolute, otherwise `~/.config/dormouse/dormouse.yml`.** Both local hosts use this location. User Tools require no project grant; malformed or unreadable user configuration fails lookup. Project and user Tools occupy separate reuse scopes.

| Field | Behavior |
| --- | --- |
| `run` | Required shell command string or argument list, typed into the configured shell after integration readiness |
| `render` | `iframe` by default, or `ab-screencast` |
| `port` | `announced` by default, or `auto`; [Serving](#serving) owns selection |
| `prespawn_dedupe` | Optional scalar or list of literal key elements with substitutions |

- **Must reject unknown `prespawn_*` fields and unknown substitutions**; unknown ordinary fields produce warnings. `$PROJECT_ROOT` is the declaring directory, `$CWD` the caller's resolved directory, and `$TARGET` the canonical local file input. (rationale)
- **Must preserve scalar `prespawn_dedupe` as a one-element literal list**, never interpret it as a command to execute. Reserve separate fields for future computed keys. (rationale)
- **Must warn when a repo-local key omits `$PROJECT_ROOT`**, while allowing intentional cross-checkout dedupe.
- **Must reject `$PROJECT_ROOT` in user configuration**, which has no project root.

**Must pass named-tool inputs as argument values, never substitute them into a shell-command string.** String `run` accepts no arguments and remains literal shell syntax. List `run` expands `$TARGET`, `$CWD`, and `$PROJECT_ROOT` within elements; a whole `$ARGS` element expands all input arguments. Without `$ARGS` or `$TARGET` in the list, append the inputs. **Must quote argv for the destination Session's shell**, using the current default only for new Sessions; takeover stores that quoted command for reruns.

**Must require exactly one existing regular local file when `$TARGET` appears in the run list or dedupe key.** Resolve relative paths against the invocation CWD and follow symlinks to a canonical absolute path before substitution and reuse. Reject URLs, directories, and missing files. Validate run and key inputs before showing approval. Pending approval distinguishes the original arguments and invocation CWD; [Trust](#trust) owns re-resolution and recovery. Input control-character restrictions belong to `docs/specs/security-local.md` → Dor Tool configuration.

Source of truth: `lookupTool` in `lib/src/host/tool-trust.ts`; `parseToolFile` / `resolveDedupeKey` in `lib/src/host/tool-registry.ts`; `resolveToolInput` in `lib/src/host/tool-input.ts`; `readUserToolFile` in `lib/src/host/tool-user-config.ts`; `toolRunCommand` in `lib/src/components/wall/use-dor-control.ts`; `lib/src/host/tool-host.test.ts`, `lib/src/components/Wall.test.tsx`.

## Identity and dedupe

**Must dedupe only when an explicit key exists and `--fresh` is absent.** Neither a command nor its CWD implicitly creates identity; anonymous `dor tool -- <command>` invocations create fresh Surfaces. (rationale)

- **Must namespace keys by the host-resolved Tool name**; runtime output supplies scope elements, never another Tool's namespace.
- **Must dedupe within the answering Workspace.** `--workspace` uses the routing in `docs/specs/dor-cli.md` → Handle Model.

- **Must serialize Tool launch requests and approval completion in the renderer**, covering lookup, matching, creation, and startup. The current lock serializes all Tool requests, not only matching keys.
- **Must retain the queue after integration until the new Tool command starts or completes**, or startup times out or is cancelled. A matching completion before waiting counts; integration alone does not prove injection occurred.
- **Must reveal a live matching Tool and report `existing` without sending input.** An idle match restarts its stored command in its own directory and reports `adopted`; a failed restart reports an error.
- **Must reuse and reveal a matching pending approval Surface unless `--fresh` is set**, matching Tool name, project root, CWD, arguments, and fresh intent; preserve its approval state and report `pending`.
- **Must accept a short-lived keyed restart after observing its new completed command id**, matching the stored command and directory. A completion predating injection or belonging to another command does not prove restart.
- **Must apply runtime re-keys only to the announcing Tool**, without merging Surfaces, transferring state, or killing either side of a collision. (rationale)

Source of truth: `queueToolSpawn` / the `surface.tool` handler in `lib/src/components/wall/use-dor-control.ts`; `namespacedToolKey` / `toolKeysEqual` in `lib/src/components/wall/browser-surface.ts`; `lib/src/components/Wall.test.tsx`.

## Trust

**Must obtain a recorded grant before executing a repo-local named Tool.** Anonymous command invocations carry the caller's explicit command and require no repo-config grant. The local authority boundary belongs to `docs/specs/security-local.md` → Dor Tool configuration.

1. **Must derive grant keys host-side from the canonical upstream remote URL or project-root folder.** Either recorded key satisfies lookup; upstream trust spans clones and worktrees. (rationale)
2. **Must present unapproved named invocations in a visible pending Tool pane**, returning `pending` without spawning a PTY. Defer requested minimization until approval. Pending approval is never persisted as a runnable Tool.
3. **Must grant only through the approval controls in Dormouse chrome**, never through a `dor` verb or terminal output. The prompt names the proposed command; it is not itself executable terminal content. (rationale)
4. **Must require the host's `trust-recorded` result before re-resolving the named entry**, then stage the command, renderer, port strategy, and key before exposing its terminal. Failed grants retain approval choices and display errors. Closed Surfaces must not start later.
5. **Must recheck the resolved key before launching an approved Tool**, honoring its original `--fresh` intent. Close a redundant approval through the ordinary close coordinator before revealing or restarting the match; a failed closure retains the approval and sends no command.
6. **Must close a declined approval through the ordinary close coordinator and record no denial.** Archive failure may retain the pane. (rationale)
7. **Must record each grant as its own atomically written file**, so hosts sharing one state directory never lock or merge.
8. **Never content-hash grants or re-prompt solely because the config changed.** (rationale)

**Must offer Retry and Close after post-grant lookup failure**, preserving the error with no PTY. Retry repeats only lookup; Close retains permission; the footer states both. **Never restore pending approval once launch clears its marker**, including after PTY/minimization failure.

**Must validate a bounded regular, non-symlink grant receipt for the requested key.** Missing, corrupt, or mismatched records grant nothing; a filename alone is never approval.

Reserved: **Must keep future implicit glob dispatch user-global and limited to user-global Tools**, and gate any future repo `prespawn_*` execution on the same approval; see scope **dor-tools** under [Future](#future).

Source of truth: `createToolHost` in `lib/src/host/tool-host.ts`; `FileToolTrustStore` / `lookupTool` in `lib/src/host/tool-trust.ts`; `resolveUpstreamUrl` in `lib/src/host/git-upstream.ts`; `ToolApproval` in `lib/src/components/wall/ToolApproval.tsx`; `resolveToolApproval` in `lib/src/components/Wall.tsx`. Tests: `lib/src/host/tool-trust.test.ts`, `lib/src/components/Wall.test.tsx`.

## Serving

**Must frame only a port returned by the Tool Session's process-tree scan while its designated command is current.** An OSC announcement selects a discovered port; it cannot supply an arbitrary listening service or designate an ordinary terminal as a Tool. Recheck the command run after asynchronous discovery and browser startup.

| Policy | Selection |
| --- | --- |
| Announced port present | Match that exact port in the scan; absent match frames nothing |
| `port: announced`, no announced port | Frame nothing |
| `port: auto`, no announced port | Wait for one unchanged scan tick; one port frames, several show a conflict, zero keeps waiting |
| Anonymous command | Uses `auto` |

- **Must poll unbound Tools every 1.5 seconds while their command runs.** Reset settle memory and retire browser resources when the observed command-run id changes, even when the command text is unchanged; an initial observation preserves an imported live binding. (rationale)
- **Must let a changed announced port override a committed conflict or browser**, but only after a matching scan. An unchanged announcement never undoes URL-bar navigation. (rationale)
- **Must stop ordinary port scans once a browser or conflict is committed.** An unannounced additional port appearing after settle is not detected.
- **Must display the browser destination before awaiting agent-browser startup**, clearing the existing session/stream binding during a reopen as well. Keep the session-less renderer inert and block Workspace transfer until the binding arrives. Close any browser session whose Tool disappeared or changed command during startup.
- **Must reuse an existing browser session and its binary path when an announcement changes its destination.**
- **Must retain a runtime re-key within the Tool's namespace**, following [Identity and dedupe](#identity-and-dedupe).

Reserved: **Must derive a Tool's URL again on cold restore**, compatible with future `prespawn_port` and `DORMOUSE_TOOL_PORT` in scope **dor-tools**; [Persistence and hosts](#persistence-and-hosts) owns the saved projection.

Source of truth: `useToolServing` in `lib/src/components/wall/use-tool-serving.ts`; `attachAgentBrowserSession` in `lib/src/components/wall/tool-browser-session.ts`; `listenerUrlsByPort` in `lib/src/components/wall/port-url.ts`. Tests: `lib/src/components/wall/use-tool-serving.test.tsx`.

## Lifecycle

**Must return keyboard focus directly to the primary terminal when it becomes the selected passthrough face**, even while the retiring browser still owns a Surface focus handle.

**Must create a shell-hosted PTY and type the command only after integration readiness.** An unsupported shell fails before launch; integration timeout or cancellation closes the temporary Surface through the notepad close coordinator, retaining it if closure fails.

| Transition | Result |
| --- | --- |
| Spawn | Terminal visible; Tool identity already established |
| Serving | Browser becomes visible in the same Surface |
| Port conflict | Explanation occupies the browser half; terminal remains available |
| Command exit or different command | Browser resources retire and terminal becomes visible |
| Re-run stored command | Same Surface may serve again |
| Kill | Notes archive and helper guards settle before PTY/browser teardown |

**Must show the full terminal before serving and after command exit.** A serving Tool shows its browser, and Terminal Context reveals the same primary terminal (`docs/specs/terminal-context.md` → Tool context). Keep the browser mounted behind context, and keep the hidden terminal sized with `visibility` and `inert`, never `display: none`. Pending approval mounts neither capability.

Notepad follows `docs/specs/notepad.md` → Notepad UI. Tool context follows `docs/specs/terminal-context.md` → Tool context.

Source of truth: `TerminalPane` in `lib/src/components/TerminalPane.tsx`; `focusSession` in `lib/src/lib/terminal-lifecycle.ts`; `ToolPanel` in `lib/src/components/wall/ToolPanel.tsx`; `ToolPaneHeader` in `lib/src/components/wall/ToolPaneHeader.tsx`; `toolLeafMeta` / `shouldParkOnMinimize` in `lib/src/components/wall/lath-wall-engine.ts`; `closeSurface` in `lib/src/components/Wall.tsx`. Tests: `lib/src/components/wall/ToolPanel.test.tsx`, `lib/src/components/Wall.test.tsx`, `lib/src/components/TerminalPane.test.tsx`, `lib/src/lib/terminal-registry.alert.test.ts`.

## CLI

**Must return the Tool Surface handle.** A new Tool follows [Take-over](#take-over), otherwise splitting focus-neutrally. A matching Tool follows [Identity and dedupe](#identity-and-dedupe).

**Must retain `dor tool` as a Surface-producing command on every supported host**, never route it to a native editor. Generated help owns syntax and response types own shape.

Source of truth: `toolCommand` in `dor/src/commands/tool.ts`; `dor/test/snapshots/help/tool.md`; `ToolSurfaceResponse` in `dor/src/commands/types.ts`.

## Take-over

**Must run a standalone `dor tool` invocation in its calling pane when every takeover condition holds.** Otherwise use the ordinary split path. Trust approval and keyed reuse take precedence. (rationale)

| Condition | Required state |
| --- | --- |
| Caller | Visible, integrated plain terminal; not closing or dying |
| Command line | OSC 633 reports `dor tool` alone; compound shell syntax rejects takeover |
| Directory | Resolved Tool CWD equals the caller's reported CWD |
| Placement | Neither `--surface` nor `--minimize` supplied |
| Helper | No existing auxiliary helper; preserve it by splitting |

**Must answer `takeover` before waiting for the calling shell's prompt**, then transform and type the command. The answer promises placement, not successful command startup.

- **Must leave the caller unchanged on prompt timeout or cancellation**, and recheck transfer/closing state, pane membership, CWD, kind, and helper presence after the wait. A helper opened during the handshake prevents transformation. **Must complete an accepted takeover after switching Workspaces** without changing the active Workspace. (rationale)
- **Must change components and params in one metadata commit**, retaining the Session id, Surface ref, scrollback, notes, source pins, and any user rename.
- **Must clear previous OSC 367 hints before typing the new command.**
- **Must retain the spawn lock until the typed command is observed running or a new completed run is observed**, or the wait ends. A command that starts and exits between samples releases the lock too.
- **Must rerun a keyed match in the caller through the same answer/prompt handshake**, reporting `adopted`, when its line is standalone and integrated. Never interrupt the waiting `dor` process. Placement flags do not relocate an existing match; run in its current directory.
- **Must report an error when the caller is the keyed match but its command line cannot be typed behind**, instead of reporting a misleading `existing` result.
- **May interleave user keystrokes arriving between the prompt and command injection.**
- **Must include already-owned background listeners in the usual process-tree scan.** [Serving](#serving) owns selection.

Source of truth: `toolTakesOverCaller` / `toolRerunsInCaller` / `callerStillPlaceable` / `callerStillRunnable` in `lib/src/components/wall/tool-takeover.ts`; `runToolInCallerPane` in `lib/src/components/wall/use-dor-control.ts`; `setMeta` in `lib/src/components/wall/lath-wall-store.ts`. Tests: `lib/src/components/wall/tool-takeover.test.ts`, `lib/src/components/Wall.test.tsx`.

## OSC 367

**Must consume OSC 367 at the PTY owner's parser**, including malformed and unknown verbs, and emit no reply. `serve` is the only implemented verb. The escape registry is `docs/specs/terminal-escapes.md`.

- **Must sanitize and bound the payload before retaining it.** `ToolAnnounce` and `parseToolAnnounce` own the field shapes and validation limits.
- **Must forward parsed announcements and command-start resets in stream order to the owning renderer.** A start clears the previous command's announcement; a later serve in the same chunk survives. Standalone uses `terminal:protocolEvents`; VS Code uses nullable `terminal:toolAnnounce` scoped to the owning webview, with null clearing the hint. The fake adapter applies locally.
- **Must reconstruct announcements and resets from raw replay without emitting replies**, preserving transferred announcements when since-mark replay has no command start, and clear the renderer record on Session disposal. Ordinary terminal announcements stay inert.
- Reserved: **Must retain `name`, `dehydrate`, and `persist` as inert parsed fields**, serving the announced-name and D1/D2 items under [Future](#future). Neither `persist: never` nor a `dehydrate` verb changes current persistence.
- Reserved: **Never assign a third OSC 367 verb**; `dehydrate` belongs to D2 under [Future](#future), while existing title/progress protocols keep those roles.

Source of truth: `TerminalProtocolParser` / `collectTerminalProtocolAlerts` in `lib/src/lib/terminal-protocol.ts`; `parseToolAnnounce` in `lib/src/lib/tool-announce.ts`; `recordToolAnnounce` in `lib/src/lib/tool-announce-store.ts`; `createOwnerPtyStream` in `vscode-ext/src/message-router.ts`; `ownerStream` in `lib/src/host/remote/sidecar-entry.ts`. Tests: `lib/src/lib/tool-announce.test.ts`, `standalone/scripts/dev-agent-browser-announce.test.mjs`.

## Security

The Tool-specific local boundaries are `docs/specs/security-local.md` → Dor Tool configuration. Browser content follows `docs/specs/security-local.md` → Browser panes. Serving authority follows [Serving](#serving); approval workflow follows [Trust](#trust).

## Persistence and hosts

**Must persist the command and stable Tool metadata with `surfaceType: 'tool'`**, retaining the ordinary CWD field. Never persist a derived URL, browser session binding, conflict, or pending approval as runnable Tool state. Live notes follow `docs/specs/notepad.md` → Live resume.

**Must retain resolved argv for argument-list Tools and re-quote it for the shell selected at cold restore.** Update the restored command in terminal options and Tool pane/door metadata. Literal shell-string commands retain their saved text. Reject persisted argv containing terminal controls before restoring any PTY.

**Must cold-restore an approved Tool by starting its saved command through integration-gated shell readiness**, then rediscover its port. Agent-resume commands do not override the saved Tool command. Pending approvals restore as ordinary terminals and execute nothing. **Must rebuild visible Tool metadata from its pane row when layout geometry is unusable**, rather than starting the command in a plain terminal with no serving behavior.

**Must retain live Tool browser params and OSC announcements in volatile Workspace-transfer content**, applying them to the destination plan without mutating the durable record. A serving iframe Tool participates in the ordinary iframe move confirmation. **Must refuse transfer while a Tool awaits approval or its browser startup has no session binding.**

**Must pause serving updates during Workspace closure or transfer**, and recheck that a Workspace remains available after asynchronous launch lookup. Approval completion must not launch into a closing or transferring Workspace.

Source of truth: `captureToolParams` / `restoreToolParams` in `lib/src/components/wall/tool-transfer.ts`; `captureTransferContent` in `lib/src/components/wall/workspace-transfer.ts`; `planArrival` in `standalone/src/workspace-move.ts`. Tests: `lib/src/components/wall/tool-transfer.test.ts`, `lib/src/components/WorkspaceWindow.test.tsx`, `lib/src/components/wall/use-tool-serving.test.tsx`.

**Must provide Tool host operations in standalone and VS Code.** Remote terminal transport remains protocol-v1; remote browser presentation is staged in `docs/specs/remote-api.md`.

Source of truth: `PersistedToolMetadata` in `lib/src/lib/session-types.ts`; `saveSession` in `lib/src/lib/session-save.ts`; `restoreSession` in `lib/src/lib/session-restore.ts`; `restoreTerminal` in `lib/src/lib/terminal-lifecycle.ts`; `toolControl` in `lib/src/lib/platform/types.ts`. Tests: `lib/src/lib/session-save.test.ts`, `lib/src/lib/session-restore.test.ts`.

## Future

**Scope: dor-tools** — remaining design, in implementation order.

- **C — glob table + `dor open`.** User-global glob rules
  (pattern → tool name), `dor open <local-file>` as sugar over `dor tool`,
  and the loopback file/viewer endpoint a local *file* needs (the
  iframe proxy instruments only `http://` upstreams).
- **D1 — reaping without cooperation.** Idle-threshold reap +
  rehydrate-from-args + `persist: "never"`: every stateless tool, no new API,
  no Windows question.
- **D2 — dehydrate/rehydrate.** The `367;dehydrate` verb +
  `DORMOUSE_DEHYDRATE`; the `dehydrate` flag is reserved in the serve payload
  from the shipped `serve` payload. The Windows graceful-stop is needed here
  only.
- **The announced `name`.** Wire the reserved [OSC 367](#osc-367) `name` into
  the title-candidates channel and `dor list`'s location column.
- **Later** — `prespawn_*` beyond the dedupe literal: a computed key, and
  `prespawn_port`. Pocket/remote browser view (rides the browser-surface
  staging in `docs/specs/remote-api.md`; reserve the kind on the wire now). An in-pane terminal/browser strip (decide against the
  glossary's reserved multiple-Surfaces-per-Pane). A `boots: web` hint if the
  terminal flash grates. `--has terminal` / `--has browser` for `dor list`.

### Dehydrate and rehydrate

**Reap a tool announcing `dehydrate: true` on an idle threshold while
`Doored` / `Hidden`** — Surfaces of an inactive Workspace included — **never on
the minimize itself** (reattach must not cost a boot every time) **or under
memory pressure**. The headline case is Workspaces, not shutdown: an inactive
Workspace of dehydratable tools drops to zero processes, relieving the
parked-surface pressure hidden Workspaces carry (`docs/specs/layout.md`
→ Workspaces; `docs/specs/tiling-engine.md` → Parked leaves).

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
