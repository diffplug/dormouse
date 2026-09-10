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

| State | Status and action |
|---|---|
| Starting | Waiting for shell…; Modify |
| Autorun executing | Running the captured command; Modify |
| Untouched completion | Captured command autoran; Modify |
| User input | Skipping autorun to preserve user keystrokes; Reset |
| Empty default | Autorun off; Modify |
| No readiness | Autorun skipped: shell readiness unavailable; Modify |
| Exited | Helper exited; Reset |

**Must make Reset an explicit discard**, confirming loss of scrollback, unfinished input, running programs, and unsaved edits. Cancellation changes nothing; confirmation disposes the old helper and launches a fresh one using the source's current directory and current global setting. Stale timers cannot write to the replacement.

Source of truth: `openHelper` / `helperHasWork` / `disposeHelper` / `closeHelperParent` in `lib/src/lib/helper-terminal.ts`; `markSessionTouched` / `parkElement` in `lib/src/lib/terminal-lifecycle.ts`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`. Tests: `lib/src/lib/helper-terminal.test.ts`.

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

Source of truth: `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`; `lib/src/stories/TerminalContext.stories.tsx` supplies sample output; `lib/src/stories/Wall.stories.tsx` exercises the live helper with the fake shell.

## Future

Pocket context composition, remote helper creation, and SSH integration are unbuilt.
