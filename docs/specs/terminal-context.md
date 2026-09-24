# Terminal context

> See `docs/specs/glossary.md` for Surface / Session / Pane vocabulary.
> This spec owns the helper terminal lifecycle and global autorun preference.
> Layout owns context composition and input focus; terminal-state owns shell
> semantics; alert owns suppression; transport owns live recovery.

## Helper lifecycle

- **Must create at most one helper per source, lazily on first context opening.** Concurrent openings share the same pending creation. Closing the source during startup cancels creation, including while its registry entry remains for the exit animation. Helpers cannot have helpers.
- **Must start with the configured shell in the source's local directory**, using the ordinary split fallback when unavailable. Shell exports and virtual environments are not inherited. SSH integration is outside this feature.
- **Must inject autorun only after integrated shell readiness**, accepting prompt-start and prompt-end/editing states with no current command. User input before injection cancels it. After eight seconds without readiness, show an unsupported state and never write a timeout fallback.
- **Must treat typing, paste, accepted drops, and application mouse input as user work**, disarming automatic refresh until Reset or Promote. Selection, copying, resize, and terminal protocol replies do not count. Returning to idle does not rearm autorun.
- **Must refresh an untouched, completed or autorun-disabled helper on reopening only after a host idle check.** Recheck ownership and the touched flag after that asynchronous check; foreground commands, background descendants, and failed/unknown inspection preserve the helper.
- **Must hide a retained helper without terminating its PTY**, parking its xterm element in the document. Revealing or promoting reuses the same element; cleanup from an older mount cannot detach a newer mount. Renderer resource lifetime follows `docs/specs/layout.md` → "Renderer".
- **Must keep a preserved helper's directory independent of its source**, showing both locations prominently when they differ. Unknown directory state is not evidence of a match.
- **Must retain exited output**, offer Reset, and avoid automatic restart loops.
- **Must pause status and process-inspection polling while the context is hidden**, invalidating cached idle results. Reopening publishes current terminal status; source closure inspects work on demand.

**Must carry one status line per helper state**, offering Reset in place of Modify only after user input and after exit.

**Must make Reset an explicit discard**, confirming loss of scrollback, unfinished input, running programs, and unsaved edits. Cancellation changes nothing; confirmation disposes the old helper and launches a fresh one using the source's current directory and current global setting. Stale timers cannot write to the replacement.

Source of truth: `openHelper` / `helperHasWork` / `disposeHelper` / `closeHelperParent` in `lib/src/lib/helper-terminal.ts`; `markSessionTouched` / `parkElement` in `lib/src/lib/terminal-lifecycle.ts`; `HELPER_STATUS` — the state, its status line, and whether it offers Reset — in `lib/src/components/wall/TerminalContextView.tsx`. Tests: `lib/src/lib/helper-terminal.test.ts`.

Notepad sharing and pin restrictions follow `docs/specs/notepad.md` → "Helper terminals".

## Promotion and source closure

**Must promote the actual Session into a regular split beside its source**, preserving the PTY, xterm, scrollback, directory, partial input, and identity. Cancel pending autorun, close context, assign the public Surface ref, and focus the promoted terminal. Failed placement restores auxiliary host ownership. The source's next opening creates a new helper.

**Must reject Reset, source retirement, and duplicate Promote during ownership transfer**, including from a reopened context. A failed transfer or rollback reports its error and resumes inspection so promotion can be retried.

**Must close an idle helper with its source**, even when it has user input or scrollback. The idle shell itself is not running work. Existing source-work confirmation remains applicable.

**Must block source closure while its helper has running work**, warn, and reveal the helper. The user stops the work there and retries closure; no force-close-both or automatic promotion is offered. Failed process inspection keeps both terminals and reports the error. CLI attempts to close such a source return failure.

**Must include hidden helper work in shutdown checks.** The helper's host inspection also detects background descendants; unresolved inspection, including a process table missing the live PTY process, counts conservatively as work. Minimizing the source hides its context and retains the helper.

Source of truth: `beginPromotion` / `cancelPromotion` / `finishPromotion` / `helperHasWork` in `lib/src/lib/helper-terminal.ts`; `closeSurface` / `requestKill` / `contextActions` in `lib/src/components/Wall.tsx`; `countRunningSessions` in `lib/src/lib/terminal-state-store.ts`.

## Global autorun setting

**Must default to `git status`; an empty command disables autorun.** An explicit Modify edit applies to new and reset helpers, never a retained one. Its status describes the command captured at creation, even when the global default changes.

**Must accept only a single command line of at most 4096 characters**, excluding CR, LF, and NUL. The host persists only this preference in `~/.dormouse/helper-terminal.json`, using atomic replacement with private file permissions. All desktop renderers read that shared preference through the host; the fake adapter keeps a deterministic in-memory setting.

**Must enforce command validity at the host.** A rejected edit keeps the prior preference and displays the error in Modify.

Source of truth: `context` in `standalone/sidecar/pty-core.js`; `terminalContext` in `lib/src/lib/platform/fake-adapter.ts`; `TerminalContextRequest` in `lib/src/lib/terminal-context-types.ts`.

## Presentation coverage

**Must share the context presentation between the live menu and its state gallery.**

**Must fit every control inside the panel at its minimum width, label included.** The port launch actions, whose set grows with the host's browser providers, shrink and truncate their text, keeping the full label as the tooltip. The gallery's play check measures each button against the panel and against its own box.

Source of truth: `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`; `lib/src/stories/TerminalContext.stories.tsx` supplies sample output; `lib/src/stories/Wall.stories.tsx` exercises the live helper with the fake shell. `lib/src/stories/HelperPlacement.stories.tsx` checks rendered placement and real xterm input/focus retention; the context gallery checks narrow controls and always-visible details.

## Tool context

**Must show a Tool's primary Session in Terminal Context instead of creating an auxiliary helper.** Reuse the title, directory, port, alert, and notepad presentation, showing Tool command status without helper Modify, Reset, or Promote controls. Pending approval cannot open context.

**Must preflight a note source pin before opening Tool context, then mount and refit context before resolving its displayed selection.** Failed refit resolution follows `docs/specs/notepad.md` → Source links.

**Must focus the Tool terminal instance directly**, bypassing its browser Surface focus handle.

**Must mount only one terminal view for the Tool at a time**, moving its retained xterm between the full pane and context without disposing the Session. Context keystrokes, including terminal clipboard chords, belong to that terminal and never reach the browser underneath. Closing context preserves both processes and browser state.

Source of truth: `revealNoteSource` in `lib/src/lib/notepad/pin.ts`; the `dormouse:reveal-note-source` listener in `lib/src/components/Wall.tsx`; `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`; `ToolPanel` in `lib/src/components/wall/ToolPanel.tsx`. Tests: `lib/src/components/wall/TerminalContext.test.tsx`, `lib/src/components/Wall.test.tsx`.

## Future

Pocket context composition, remote helper creation, and SSH integration are unbuilt.
