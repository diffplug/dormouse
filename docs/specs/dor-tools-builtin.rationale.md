# Built-in Tools — Rationale

> Informative evidence for `docs/specs/dor-tools-builtin.md`, keyed by its headings.

## Packaging

A separate runtime bundle keeps viewer code out of ordinary CLI invocations while reusing the existing POSIX and Windows launchers, Node configuration, and Tool process lifecycle. Keeping the editor assets beside their runtime avoids depending on the build workspace after staging.

## File viewer

Innerdogfood QC in Chromium (2026-09) showed the native PDF plugin failing inside the normal iframe sandbox. PDFs use configured user Tools; the built-in viewer carries no PDF renderer dependency.

A CSS source preview escapes its contents, so its URLs cannot load assets. Scanning those references adds unused authority and can reject a small source file at the asset limit. CSS loaded by HTML is active, so its dependencies still enter the bounded grant.

Keeping the built-in viewer in the Tool's process tree reuses port discovery, kill, restart, and Workspace transfer. An OSC path carries the per-run URL capability without saving that secret in the restart command. Holding the selected file descriptors bounds what the server can read after launch; it trades automatic replacement-file refresh for a grant whose contents cannot widen through path replacement.

Without a title, a viewer's header falls back to its running command, `dor __view-file <path>`, where an editor would show the file name. The title strips controls because a file name can carry an OSC terminator, C1 ST included, that would end the sequence early.

## Markdown editor

MDXEditor 4.3 parses `<!-- … -->` and discards it, and trims and re-serializes the whole document on export; without the comment node and style detection, saving a typical README after a one-word edit deleted its comments and rewrote every `-` bullet as `*` (measured 2026-10). Its `onChange` reports the first export after load as normalization, which is how a load stays clean.

Mermaid 12 loads elkjs for its `layout: elk` diagrams: a 1.4 MB chunk under EPL-2.0, the only copyleft code the page would ship. Its default layouts cover ordinary diagrams, so the build stubs elkjs out (2026-10).

The page keeps `'unsafe-inline'` scripts because the host injects its iframe shim inline (`docs/specs/theme.md` → Tool iframe themes), so the CSP alone does not stop inline event handlers. MDXEditor's stock `GenericHTMLNode` copies every document attribute onto a live element, and its image export builds an `<img>` with the document's attributes in the live document, where a `srcset` loads and fires `onerror`; both ran document script in Chromium (2026-10) with the page's save and paste routes in reach.

## Folder viewer

A names-only folder viewer leaves file contents behind the existing one-file grant. A content-serving folder grant cannot hold descriptors for a whole tree from launch, so it would need open-per-request containment and a rewrite of the Local-file viewer checks.

Each page POST is its own connection, so two can arrive out of order. In a live run (2026-09-28), when POSTs still became `dor open` calls, a double-click's activate reached the renderer before its select, so the file opened as an ordinary split beside the folder viewer instead of pinning the slot the select was creating. Selects stay concurrent because supersession needs a newer select to reach the renderer while an older one is still in flight.

## Editing files

Windows tests in 2026-10 (Node 22.22.3) showed an atomic Node rename failing with EPERM while the raw grant retained a descriptor. A protected owner-only document also acquired its parent directory's broader DACL after the ordinary rename path. Native replacement succeeded with the original grant still open and retained the document ACL. [Microsoft's ReplaceFileW contract](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew) records the metadata and ACL merge; ignoring merge errors would weaken the permission guarantee.

Microsoft documents ReplaceFile failures that have already moved the original or replacement file (1176/1177), as well as a native commit preceding a lost helper reply. Deleting the draft or backup after an unconfirmed replacement can therefore delete the only surviving bytes. Confirmed saves and failures before replacement still delete both.

The Windows draft inherits its directory's ACL, so a protected document in a more broadly readable directory exposes its unsaved draft to that directory's readers until replacement merges the document's ACL. An owner-only stage was tried and dropped (2026-10): creating it needed a PowerShell `Add-Type` P/Invoke to `CreateDirectoryW`, which compiled C# and spawned PowerShell a second time on every save, failed under Constrained Language Mode, and protected draft bytes only in that rare configuration.
