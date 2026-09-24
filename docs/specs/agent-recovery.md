# Agent recovery

> See `docs/specs/glossary.md` for Surface, Session, Pane, resume, and restore vocabulary.
> Owns shared agent capture, recovery records, detection, and cold-restore execution. Host shutdown ordering and target selection belong to `docs/specs/vscode.md` and `docs/specs/standalone.md`; watching belongs to `docs/specs/alert.md`.

## Capture

- **Must use the shared `captureAgentRecovery` machine in both hosts**, supplying live ids, an acknowledged interrupt, a monotonic received count, output since a mark, and immediate record delivery.
- **Must capture before killing the target PTYs**, within the host's bounded teardown. Each host owns the target scope; interrupt every live PTY within it, regardless of recognized command, and exclude exited PTYs. (rationale)
- **Must write one `^C` into each target PTY per interrupt call, never signal it.** The shared machine alone decides the second press. Host interrupts must settle within their timeout. (rationale)
- **Never finish early on quiet or replace the retry gates with a blanket second press.** Poll until every target yields or the capture budget expires; retry timing and ask detection live in the module's comments. (rationale)
- **Must scan only bytes received after the mark taken before the first interrupt.** Never widen the scan into earlier output; buffer eviction may discard fresh bytes but must not promote stale bytes into the scan. (rationale)
- **Must report each detected command immediately**, retaining earlier detections if a later target times out.

Source of truth: `captureAgentRecovery` / `RecoveryHost` in `lib/src/host/recovery-capture.ts`; pinned by `lib/src/host/recovery-capture.test.ts`.

## Detection

**Must derive supported executable names and resume options from `CODING_AGENTS`.** The public inventory and contribution workflow live in `docs/compatible-agents.md`.

- **Must rebuild only a known invocation plus an opaque id.** The command is *rebuilt* as label, space, captured id, never sliced from the buffer, keeping the hint's executable alias; a long option's id may follow a space or `=`, and only Claude's legacy `claude --continue` omits it. The id must begin with an ASCII alphanumeric and contain only ASCII alphanumerics, hyphens, and underscores. The invocation must end on a word break but nothing stronger (rationale).
- **Must observe a separator after the newest invocation before capturing it.** Buffer end is insufficient, even at the capture deadline; never fall back to an older hint while the newest is unterminated. Pinned by `waits through every ID split` in `lib/src/host/recovery-capture.test.ts` (rationale).
- **Must strip the scan window as a whole, in one pass, with an unterminated control swallowing the rest of it** — the string controls (OSC, DCS, SOS, PM, APC) **in either introducer form, `ESC` or bare C1**, and equally a CSI the window was cut off *inside* (rationale). **Must match every escape by its full ECMA-48 shape**, never by the Fe range (rationale). **Must share one implementation**: `stripTerminalControls` removes string controls by running `TerminalControlStreamFilter`, so the batch and streaming readers cannot disagree.
- **Must strip in boundary mode**: *every complete* control becomes a newline rather than vanishing, except SGR and charset designators, the two classes that neither move the cursor nor erase. **Must discard incomplete trailing presentation controls without creating a boundary** (rationale).
- **Must select the rightmost match in the last 50 lines**, newest *by position* and never by pattern order (rationale).

Source of truth: `CODING_AGENTS` in `lib/src/lib/coding-agents.ts`; `detectResumeCommand` / `normalizeResumeCommand` in `lib/src/lib/resume-patterns.ts`; `stripTerminalControls` in `lib/src/lib/terminal-controls.ts`; pinned by `lib/src/lib/coding-agents.test.ts`, `lib/src/lib/resume-patterns.test.ts`, and `lib/src/lib/terminal-controls.test.ts`.

## Recovery record

- **Must keep one rebuilt invocation per Surface in a host-owned, single-use record outside the persisted Session.** The renderer save path never derives or writes it. (rationale)
- **Must call `beginCapture` before capture can return early.** The first call per host process clears the previous record; subsequent calls merge, preserving captures from other Windows. (rationale)
- **Must persist every detection synchronously through `createRecoveryStore`**, using `recovery.json` in the host-selected directory, an owner-only temporary file, and atomic rename. A failed write must not throw through teardown. Without a directory the store is memory-only and logs that limitation once.
- **Must read and unlink the durable record on the first claim**, including on parse failure; if unlink fails, ignore it. Discard records older than 7 days after unlinking. Within the process, each container claims only its saved pane ids, and each entry is handed out once. (rationale)
- **Must deliver claimed commands out of band on boot through `PlatformAdapter.getRecoveryCommands()`**; adapters whose hosts capture nothing may omit it. Only cold restore consumes these commands for execution; live resume never executes them.

Source of truth: `createRecoveryStore` in `lib/src/host/recovery-store.ts`; `PlatformAdapter` in `lib/src/lib/platform/types.ts`; pinned by `lib/src/host/recovery-store.test.ts`.

## Cold restore

- **Must automatically run a captured command on the next cold restore**, without a confirmation prompt, only while both detection validation and post-interrupt provenance hold. Weakening either requires restoring a confirmation gate. (rationale)
- **Must revalidate the complete stored invocation before typing it**, using `normalizeResumeCommand`; invalid entries must not execute.
- **Must poll for the fresh shell's prompt before typing, with a best-effort write after 15 seconds if no prompt is detected.** Stop without typing if the Session disappears or exits. Command-state seeding follows `docs/specs/terminal-state.md` → Command lifecycle; the passive notice follows `docs/specs/layout.md` → Agent resume on cold restore.

Source of truth: `restoreSession` in `lib/src/lib/session-restore.ts`; `restoreTerminal` / `typeCommandWhenPromptReady` in `lib/src/lib/terminal-lifecycle.ts`; pinned by `lib/src/lib/session-restore.test.ts` and `lib/src/lib/terminal-registry.alert.test.ts`.

## Future

If automatic agent startup becomes disruptive, expose an opt-out setting while retaining prompt-free recovery for users who enable it.
