# Built-in Tools — Rationale

> Informative evidence for `docs/specs/dor-tools-builtin.md`, keyed by its headings.

## Packaging

A separate runtime bundle keeps viewer code out of ordinary CLI invocations while reusing the existing POSIX and Windows launchers, Node configuration, and Tool process lifecycle. Keeping the editor assets beside their runtime avoids depending on the build workspace after staging.

## File viewer

Innerdogfood QC in Chromium (2026-09) showed the native PDF plugin failing inside the normal iframe sandbox. PDFs use configured user Tools; the built-in viewer carries no PDF renderer dependency.

A CSS source preview escapes its contents, so its URLs cannot load assets. Scanning those references adds unused authority and can reject a small source file at the asset limit. CSS loaded by HTML is active, so its dependencies still enter the bounded grant.

Keeping the built-in viewer in the Tool's process tree reuses port discovery, kill, restart, and Workspace transfer. An OSC path carries the per-run URL capability without saving that secret in the restart command. Holding the selected file descriptors bounds what the server can read after launch; it trades automatic replacement-file refresh for a grant whose contents cannot widen through path replacement.

Without a title, a viewer's header falls back to its running command, `dor __view-file <path>`, where an editor would show the file name. The title strips controls because a file name can carry an OSC terminator, C1 ST included, that would end the sequence early.

## Folder viewer

A names-only folder viewer leaves file contents behind the existing one-file grant. A content-serving folder grant cannot hold descriptors for a whole tree from launch, so it would need open-per-request containment and a rewrite of the Local-file viewer checks.

Each page POST is its own connection, so two can arrive out of order. In a live run (2026-09-28), when POSTs still became `dor open` calls, a double-click's activate reached the renderer before its select, so the file opened as an ordinary split beside the folder viewer instead of pinning the slot the select was creating. Selects stay concurrent because supersession needs a newer select to reach the renderer while an older one is still in flight.

## Editing files

Windows tests in 2026-10 (Node 22.22.3) showed an atomic Node rename failing with EPERM while the raw grant retained a descriptor. A protected owner-only document also acquired its parent directory's broader DACL after the ordinary rename path. Native replacement succeeded with the original grant still open and retained the document ACL. Windows file creation receives its access control at creation, and its containing stage is created with a protected owner-only DACL. [Microsoft's ReplaceFileW contract](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew) records the metadata and ACL merge; ignoring merge errors would weaken the permission guarantee.

Microsoft documents ReplaceFile failures that have already moved the original or replacement file (1176/1177), as well as a native commit preceding a lost helper reply. Cleaning the stage after an unconfirmed replacement can therefore delete the only surviving bytes. The original backup and replacement are retained for recovery; confirmed saves and failures before replacement still clean their stage.

Windows traverse-bypass privilege makes an owner-only directory insufficient to protect a known child path whose file DACL grants another user access. The draft file therefore starts owner-only; ReplaceFile merges the original DACL at commit. The backup retains the original document permissions rather than claiming stronger privacy for bytes that were already readable under those permissions.

An unconfirmed native replacement may already have merged the document DACL into the replacement. The owner-only draft guarantee applies before writing; retained recovery files do not promise stronger confidentiality after uncertain native effects.
