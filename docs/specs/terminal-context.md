# Terminal context

> - See `docs/specs/glossary.md` for Surface / Session / Pane vocabulary.
> - Owns aux terminal lifecycle.
> - Layout owns context composition and input focus; terminal-state owns shell semantics; alert owns suppression; transport owns live recovery; dor-cli owns aux-origin `dor` commands.

## Aux terminal lifecycle

- **Must create at most one aux terminal per source, lazily on its first showing.** Closing the source during startup cancels creation. Aux terminals cannot have aux terminals.
- **Must start with the configured shell in the source PTY's process directory, as the host reads it (`getCwd`), never the directory the source reports**, using the ordinary split fallback when unavailable. **Where the host cannot read it** (Windows, which has no such read, or a failed read), **must start in the local directory the source reports**; a source reporting none starts in the host default. Shell exports and virtual environments are not inherited. SSH integration is outside this feature.
- **Never write to an aux terminal's PTY on its own**: an aux terminal starts its shell and runs nothing.
- **Must keep an aux terminal as the user left it across reopening**, its shell, scrollback, and directory, whether or not it has been used; only Reset replaces it.
- **Must hide a retained aux terminal without terminating its PTY**; revealing or promoting reuses the same xterm element. Renderer resource lifetime follows `docs/specs/layout.md` → "Renderer".
- **Must keep an aux terminal's directory independent of its source**, showing both locations prominently when they differ. Unknown directory state is not evidence of a match.
- **Must retain exited output**, offer Reset, and avoid automatic restart loops.
- **Must pause exit and process-inspection polling while the aux terminal is not shown**, its Workspace out of view included. Reopening publishes an aux terminal's exit; source closure inspects work on demand.

**Must make Reset an explicit discard**, confirmed first; under Labs it asks nothing and the old aux terminal becomes a pending kill (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill"), which the host stops counting as the source's one aux terminal until a restore re-owns it. Cancellation changes nothing; confirmation disposes the old aux terminal and launches a fresh one in the source's current directory.

Source of truth: `openAux` / `closeAuxParent` in `lib/src/lib/aux-terminal.ts`. Tests: `lib/src/lib/aux-terminal.test.ts`.

## Promotion and source closure

Workspace movement: `docs/specs/standalone.md` → Transfer.

**Must promote the actual Session into a regular split beside its source**, preserving the PTY, xterm, scrollback, directory, partial input, and identity. Close context, make its Surface id targetable, and focus the promoted terminal. Failed placement restores auxiliary host ownership. The source's next opening creates a new aux terminal.

**Must reject Reset, source retirement, and duplicate Promote during ownership transfer**, including from a reopened context. A failed transfer or rollback reports its error and resumes inspection so promotion can be retried.

**Must close an idle aux terminal with its source**, even when it has user input or scrollback. The idle shell itself is not running work. Existing source-work confirmation remains applicable.

**Must block source closure while its aux terminal has running work**, warn, and show the aux terminal. The user stops the work there and retries closure; no force-close-both or automatic promotion is offered. Failed process inspection keeps both terminals and reports the error. CLI attempts to close such a source return failure.

**Must include hidden aux terminal work in shutdown checks**, including aux terminals whose source Surface or Workspace is pending kill. The aux terminal's host inspection also detects background descendants; unresolved inspection, including a process table missing the live PTY process, counts conservatively as work. An idle answer stands until the aux terminal next receives input. **Never count a Windows shell's own processes as work**: Git Bash's MSYS bash beneath its launcher, `wsl.exe`'s relay, host and console. Inspection cannot see work inside WSL or past an MSYS exec; a foreground command there still counts through shell integration. Minimizing the source hides its context and retains the aux terminal.

Source of truth: `beginPromotion` / `cancelPromotion` / `finishPromotion` / `auxHasWork` in `lib/src/lib/aux-terminal.ts`; `closeSurface` / `requestKill` / `contextActions` in `lib/src/components/Wall.tsx`; `countRunningSessions` in `lib/src/lib/terminal-state-store.ts`.

## Presentation coverage

**Must make diagnostic text drag-selectable**, including detail-dialog errors, without focusing the aux terminal. Copy routing follows `docs/specs/mouse-and-clipboard.md` → "Terminal context input".

Port action overflow follows `docs/specs/layout.md` → "Header context menu".

The Window-host workspace picker follows `docs/specs/layout.md` → Moving Surfaces between Workspaces.

Source of truth: `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`.

## Tool context

**Must show a Tool's primary Session in Terminal Context instead of creating an aux terminal**; one whose run ended is a plain terminal with an aux terminal (`docs/specs/dor-tool.md` → Run end). Reuse the title explanation, directory, port, and alert presentation, showing Tool command status without aux terminal Reset or Promote controls; a preview slot's adds Keep open (`docs/specs/layout.md` → Pane header). Pending approval cannot open context.

**Must mount only one terminal view for the Tool at a time**, moving its retained xterm between the full pane and context without disposing the Session. Context keystrokes, including terminal clipboard chords, belong to that terminal and never reach the browser underneath. Closing context preserves both processes and browser state.

Source of truth: `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`; `ToolPanel` in `lib/src/components/wall/ToolPanel.tsx`. Tests: `lib/src/components/wall/TerminalContext.test.tsx`, `lib/src/components/Wall.test.tsx`.

## Future

**Scope: remote-context** — Pocket context composition, remote aux terminal creation, and SSH integration.
