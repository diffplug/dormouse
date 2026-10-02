# Built-in Tools

> See `docs/specs/glossary.md` for Surface / Session / Pane vocabulary.
> Owns the built-in Tools — `builtin:file` (the local-file viewer and its text editor) and `builtin:folder` — and their runtime package launched through `dor`. `dor open` dispatch, the Preview slot, OSC 367, and close consent belong to `docs/specs/dor-tool.md`; the listeners' audited rules to `docs/specs/security-local.md` → Local-file viewer.

## Files

- `dor-tools-builtin/src/file-viewer.ts` — `builtin:file`: grant construction and the listener's routes.
- `dor-tools-builtin/src/editable-file.ts` — text reads and revision-checked saves.
- `dor-tools-builtin/viewer/editor.ts` — the Monaco page, bundled by `dor-tools-builtin/scripts/build.mjs`.
- `dor-tools-builtin/src/folder-viewer.ts` — `builtin:folder`: listings, select, and activate.
- `dor-tools-builtin/src/error-viewer.ts` — the page a failed OSC 367 `open` shows in the preview slot.
- `dor-tools-builtin/src/viewer-server.ts` — the capability listener and announcement both viewers share.
- `dor-tools-builtin/src/file-viewer-format.ts` — the pure format registry, handler names, and title.
- `dor/src/cli.ts` — the private `__view-file` / `__view-folder` / `__view-error` entries.

## Packaging

- **Must bundle the viewers and their runtime dependencies into `dist/runtime.js` in `dor-tools-builtin`**, without workspace or installed-package resolution at runtime. `dor`'s prebuild builds this package first.
- **Must stage the runtime and its adjacent `viewer` assets together under `dor/dist/builtin`**. Both hosts copy that tree with the CLI; `viewerAsset` resolves assets relative to the runtime module.
- **Must keep `file-viewer-format` free of Node runtime dependencies**: lib's renderer and host modules import it, and every build of lib source maps `dor-tools-builtin/*` to this package's `src`, as it maps `dor/*`. `dor-tools-builtin/test/browser-shared.test.mjs` bundles it for a browser.
- **Must load the runtime only for valid `__view-*` invocations, in the launcher's process**, through a URL relative to `dor.js`. Other CLI commands never load the viewer implementation; `./runtime` exports only types, so a value import fails `dor`'s build.
- **Must speak the Tool protocol through `dor-tools-lib`** (`docs/specs/dor-tools-lib.md`): the viewers announce and report with its `osc` encoders, and the editor answers the save channel with its `frame` client.

Source of truth: `dor/package.json`, `dor-tools-builtin/package.json`; `dor-tools-builtin/scripts/build.mjs`; `dor/scripts/stage-builtins.mjs`; `viewerAsset` in `dor-tools-builtin/src/viewer-assets.ts`; `runCli` / `loadBuiltinViewers` in `dor/src/cli.ts`. Tests: `dor/test/builtin-viewers.test.mjs`, `dor-tools-builtin/test/browser-shared.test.mjs`.

## File viewer

**Must prefer known extensions over filename-based text fallbacks; source extensions open as inert text in the editor.**

**Must run the built-in viewer as a Tool-owned `dor` process.** Text/source previews grant only their opened file and skip dependency inspection. (rationale) Oversized HTML and referenced CSS still stream without dependency inspection. **The grant contains at most 256 files** — the opened document and statically referenced relative HTML/CSS assets within its directory tree — and exceeding that bound fails the open without serving a partial grant. **Never expand the grant through root-relative, external, or dynamic references**; requests can read only granted paths.

**Must title the built-in viewers' Session with the canonical target's basename via `OSC 2`**, controls stripped. (rationale)

**Must require a user Tool for PDFs**, including files named `README.pdf`. (rationale)

**Must retain media/HTML grant descriptors until the Tool exits.** Refresh reads those files again; replacements and dependency-graph changes require restarting. Text editing follows [Editing files](#editing-files). Cold restore creates a fresh URL capability; Workspace movement keeps the live binding.

Source of truth: `fileViewerFormat` / `viewerTitle` in `dor-tools-builtin/src/file-viewer-format.ts`; `startFileViewer` / `runFileViewer` in `dor-tools-builtin/src/file-viewer.ts`; `announceViewer` in `dor-tools-builtin/src/viewer-server.ts`. Tests: `dor-tools-builtin/test/file-viewer.test.mjs`, `dor/test/builtin-viewers.test.mjs`.

## Editing files

**Must render supported UTF-8 text in bundled Monaco**. Use the workbench's editor colors and fonts with Monaco's light/dark syntax defaults; iframe theme delivery belongs to `docs/specs/theme.md` → Tool iframe themes. Never execute source text or load its referenced assets.

**Must save only on Save or Cmd/Ctrl+S, to the opened canonical file.** Preserve UTF-8 BOM and the dominant line ending (mixed endings are normalized). Bound text to 8 MiB; reject invalid UTF-8. Atomically replace only after comparing the submitted revision with current disk bytes and file identity; a conflict or write failure keeps the edit dirty. New edits during a save remain dirty after that save succeeds. Reload asks before discarding edits and reads the current file at the authorized path, including atomic replacements.

**Must preserve document permissions on replacement.** Drafts sit beside the document (POSIX `0600`, then the document's mode; Windows inherits the directory ACL). Windows replaces via one PowerShell `[IO.File]::Replace`, which backs up the original beside it. **Must keep the draft and backup when replacement is unconfirmed** and report their location: failure can mean partial replacement or a commit before its reply. (rationale)

**Must report dirty state immediately to the containing iframe and in order through OSC 367** (`docs/specs/dor-tool.md` → Unsaved changes), and answer the host's iframe save channel (`docs/specs/dor-tool.md` → Closing unsaved Tools) with `connectToolFrame`.

Source of truth: `readEditableFile` / `saveEditableFile` in `dor-tools-builtin/src/editable-file.ts`; `saveFileOperations` in `dor-tools-builtin/src/atomic-save.ts`; `editorPage` in `dor-tools-builtin/src/editor-page.ts`; `dor-tools-builtin/viewer/editor.ts`; `runFileViewer` in `dor-tools-builtin/src/file-viewer.ts`. Tests: `dor-tools-builtin/test/atomic-save.test.mjs`, `dor-tools-builtin/test/editable-file.test.mjs`, `dor-tools-builtin/test/file-viewer.test.mjs`.

## Folder viewer

`builtin:folder`, the default folder viewer (`docs/specs/dor-tool.md` → Folders), is a Tool-owned `dor` process, titled as in [File viewer](#file-viewer):

- **Must list names and entry types only, lazily loading expanded directories and probing compactable chains, and never serve file contents** (rationale).
- **Must list dotfiles.** Git-ignored entries are dimmed and shown by default, with a show/hide toggle.
- **Must compact a directory containing exactly one child directory and nothing else into a slash-separated row**, continuing up to 32 levels per listing; hidden/ignored entries still count as siblings. Never compact through a symlink child. Refresh and Collapse all preserve the ordinary select/activate contract.
- **Must read at most 100,000 names and retain at most 5,000 entries before following symlinks**, selected by raw directory kind and name; return the retained entries in display order by resolved kind, directories first.
- **Must route the page's select and activate through its own process**: a same-origin POST to its capability listener, which writes it to the Tool's terminal as an OSC 367 `open` (`docs/specs/dor-tool.md` → OSC 367), `preview` for a select, in arrival order. The page learns only that it was sent, or, for a path or serialized payload the OSC encoder refuses, an error instead of a write.
- **Must hold an activate until every select in flight settles**, keeping selects concurrent. (rationale)

Source of truth: `startFolderViewer` / `runFolderViewer` / `oscOpen` in `dor-tools-builtin/src/folder-viewer.ts`; `folderViewerPage` in `dor-tools-builtin/src/folder-viewer-page.ts`. Tests: `dor-tools-builtin/test/folder-viewer.test.mjs`, `the folder entry selects and activates with OSC 367 open, in the order the page sends them` in `dor/test/builtin-viewers.test.mjs`.

## Error viewer

**Must show why an OSC 367 `open` failed** when the host runs `dor __view-error <target> <message>` in the preview slot (`docs/specs/dor-tool.md` → OSC 367): one page naming the target's basename and the message, both escaped, with no script, served by the shared capability listener and titled as in [File viewer](#file-viewer). No handler name selects it.

Source of truth: `startErrorViewer` / `errorViewerPage` / `runErrorViewer` in `dor-tools-builtin/src/error-viewer.ts`; `VIEW_ERROR_ARGV` in `dor-tools-builtin/src/file-viewer-format.ts`. Tests: `dor-tools-builtin/test/error-viewer.test.mjs`, `the error entry titles itself after its target and serves the escaped message` in `dor/test/builtin-viewers.test.mjs`.
