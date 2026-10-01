# Built-in Tools

> See `docs/specs/glossary.md` for Surface / Session / Pane vocabulary.
> Owns the built-in Tools — `builtin:file` (the local-file viewer and its text editor) and `builtin:folder` — and the package that ships them inside `dor`. `dor open` dispatch, the Preview slot, OSC 367, and close consent belong to `docs/specs/dor-tool.md`; the listeners' audited rules to `docs/specs/security-local.md` → Local-file viewer.

## Files

- `dor-tools-builtin/src/file-viewer.ts` — `builtin:file`: grant construction and the listener's routes.
- `dor-tools-builtin/src/editable-file.ts` — text reads and revision-checked saves.
- `dor-tools-builtin/viewer/editor.ts` — the Monaco page, bundled by `dor-tools-builtin/scripts/build-viewer.mjs`.
- `dor-tools-builtin/src/folder-viewer.ts` — `builtin:folder`: listings, select, and activate.
- `dor-tools-builtin/src/viewer-server.ts` — the capability listener and announcement both viewers share.
- `dor-tools-builtin/src/file-viewer-format.ts` — the pure format registry, handler names, and title.
- `dor/src/cli.ts` — the private `__view-file` / `__view-folder` entries and the folder viewer's control-socket callback.

## Packaging

`dor-tools-builtin` is a private workspace package `dor` depends on; the built-in Tools run inside `dor`'s bundle.

- **`dor`'s prebuild must build `dor-tools-builtin` first**: `dor` imports it through the package's `exports`, which point at its built `dist`, and esbuild inlines it into `dist/dor.js`.
- **Must stage the editor assets beside the bundle**, since `viewerAsset` reads them relative to the running module: `dor-tools-builtin/scripts/build-viewer.mjs` bundles Monaco into the package's `dist/viewer`, and `dor/scripts/stage-builtin-viewer.mjs` copies it to `dor/dist/viewer`.
- **Must keep `file-viewer-format` free of Node runtime dependencies**: lib's renderer and host modules import it, and every build of lib source maps `dor-tools-builtin/*` to this package's `src`, as it maps `dor/*`. `dor-tools-builtin/test/browser-shared.test.mjs` bundles it for a browser.
- `dor/src/cli.ts` dispatches the private argv verbs (`VIEW_FILE_ARGV` / `VIEW_FOLDER_ARGV`) and supplies the folder viewer's `FolderOpenRequest`.
- **Must speak the Tool protocol through `dor-tools-lib`** (`docs/specs/dor-tools-lib.md`): the viewers announce and report with its `osc` encoders, and the editor answers the save channel with its `frame` client.

Source of truth: `dor/package.json`, `dor-tools-builtin/package.json`; `viewerAsset` in `dor-tools-builtin/src/viewer-assets.ts`; `runCli` / `openThroughControl` in `dor/src/cli.ts`. Tests: `dor/test/builtin-viewers.test.mjs`, `dor-tools-builtin/test/browser-shared.test.mjs`.

## File viewer

**Must prefer known extensions over filename-based text fallbacks; source extensions open as inert text in the editor.**

**Must run the built-in viewer as a Tool-owned `dor` process.** Text/source previews grant only their opened file and skip dependency inspection. (rationale) Oversized HTML and referenced CSS still stream without dependency inspection. **The grant contains at most 256 files** — the opened document and statically referenced relative HTML/CSS assets within its directory tree — and exceeding that bound fails the open without serving a partial grant. **Never expand the grant through root-relative, external, or dynamic references**; requests can read only granted paths.

**Must title the built-in viewers' Session with the canonical target's basename via `OSC 2`**, controls stripped. (rationale)

**Must require a user Tool for PDFs**, including files named `README.pdf`. (rationale)

**Must retain media/HTML grant descriptors until the Tool exits.** Refresh reads those files again; replacements and dependency-graph changes require restarting. Text editing follows [Editing files](#editing-files). Cold restore creates a fresh URL capability; Workspace movement keeps the live binding. The listener's authority is `docs/specs/security-local.md` → Local-file viewer.

Source of truth: `fileViewerFormat` / `viewerTitle` in `dor-tools-builtin/src/file-viewer-format.ts`; `startFileViewer` / `runFileViewer` in `dor-tools-builtin/src/file-viewer.ts`; `announceViewer` in `dor-tools-builtin/src/viewer-server.ts`. Tests: `dor-tools-builtin/test/file-viewer.test.mjs`, `dor/test/builtin-viewers.test.mjs`.

## Editing files

**Must render supported UTF-8 text in bundled Monaco**, with line numbers, find/replace, undo, selection, and optional wrapping. Use the workbench's editor colors and fonts with Monaco's light/dark syntax defaults; iframe theme delivery belongs to `docs/specs/theme.md` → Tool iframe themes. Never execute source text or load its referenced assets.

**Must save only on Save or Cmd/Ctrl+S, to the opened canonical file.** Preserve UTF-8 BOM, the dominant line ending (mixed endings are normalized), and permissions. Bound text to 8 MiB; reject invalid UTF-8. Atomically replace only after comparing the submitted revision with current disk bytes and file identity; a conflict or write failure keeps the edit dirty. New edits during a save remain dirty after that save succeeds. Reload asks before discarding edits and reads the current file at the authorized path, including atomic replacements.

**Must report dirty state immediately to the containing iframe and in order through OSC 367** (`docs/specs/dor-tool.md` → Unsaved changes), and answer the host's iframe save channel (`docs/specs/dor-tool.md` → Closing unsaved Tools) with `connectToolFrame`.

Source of truth: `readEditableFile` / `saveEditableFile` in `dor-tools-builtin/src/editable-file.ts`; `editorPage` in `dor-tools-builtin/src/editor-page.ts`; `dor-tools-builtin/viewer/editor.ts`; `runFileViewer` in `dor-tools-builtin/src/file-viewer.ts`. Tests: `dor-tools-builtin/test/editable-file.test.mjs`, `dor-tools-builtin/test/file-viewer.test.mjs`.

## Folder viewer

`builtin:folder`, the default folder viewer (`docs/specs/dor-tool.md` → Folders), is a Tool-owned `dor` process, titled as in [File viewer](#file-viewer):

- **Must list names and entry types only, lazily loading expanded directories and probing compactable chains, and never serve file contents** (rationale). The listener's audited rules are `docs/specs/security-local.md` → Local-file viewer.
- **Must list dotfiles.** Git-ignored entries are dimmed and shown by default, with a show/hide toggle.
- **Must compact a directory containing exactly one child directory and nothing else into a slash-separated row**, continuing up to 32 levels per listing; hidden/ignored entries still count as siblings. Never compact through a symlink child. Refresh and Collapse all preserve the ordinary select/activate contract.
- **Must cut a listing to its first 5,000 entries in display order**, directories first, from at most 100,000 names read.
- **Must route the page's select and activate through its own process**: a same-origin POST to its capability listener, which invokes `dor open --preview` or `dor open` over the control socket.
- **Must hold an activate until every select in flight settles**, keeping selects concurrent. (rationale)

Source of truth: `startFolderViewer` / `runFolderViewer` in `dor-tools-builtin/src/folder-viewer.ts`; `folderViewerPage` in `dor-tools-builtin/src/folder-viewer-page.ts`; `openThroughControl` in `dor/src/cli.ts`. Tests: `dor-tools-builtin/test/folder-viewer.test.mjs`, `the folder entry opens through the control socket as dor open --preview` in `dor/test/builtin-viewers.test.mjs`.
