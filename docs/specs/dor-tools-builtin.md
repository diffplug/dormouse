# Built-in Tools

> - See `docs/specs/glossary.md` for Surface / Session / Pane vocabulary.
> - Owns the built-in Tools — `builtin:file` (the local-file viewer and its text, Markdown, and image editors), `builtin:code` (the source editor), and `builtin:folder` — and their runtime package launched through `dor`. `dor open` dispatch, the Preview slot, OSC 367, and close consent belong to `docs/specs/dor-tool.md`; the listeners' audited rules to `docs/specs/security-local.md` → Local-file viewer.

## Packaging

- **Must bundle the viewers and their runtime dependencies into `dist/runtime.js` in `dor-tools-builtin`**, without workspace or installed-package resolution at runtime.
- **Must stage the runtime and its adjacent `viewer` assets together under `dor/dist/builtin`**. Both hosts copy that tree with the CLI.
- **Must keep `file-viewer-format`, the page builders (`editor-page`, `folder-viewer-page`, `error-viewer-page`) with their CSPs, and `editor-routes` with its imports free of Node runtime dependencies**: lib's renderer and host modules import the first, the website playground serves the pages and answers the editor routes (`docs/specs/tutorial.md` → Playground filesystem), and every build of lib source maps `dor-tools-builtin/*` to this package's `src`, as it maps `dor/*`. `dor-tools-builtin/test/browser-shared.test.mjs` bundles them for a browser.
- **Must load the runtime only for valid `__view-*` invocations, in the launcher's process**; other CLI commands never load the viewer implementation.
- **Must speak the Tool protocol through `dor-tools-lib`** (`docs/specs/dor-tools-lib.md`).

Source of truth: `dor-tools-builtin/scripts/build.mjs`; `dor/scripts/stage-builtins.mjs`; `loadBuiltinViewers` in `dor/src/node-host.ts`. Tests: `dor/test/builtin-viewers.test.mjs`.

## File viewer

**Must prefer known extensions over filename-based text fallbacks; source extensions open as inert text in the editor.**

**Must run the built-in viewer as a Tool-owned `dor` process.** Text/source previews grant only their opened file, apart from [Markdown images](#markdown-editor), and skip dependency inspection. (rationale) Oversized HTML and referenced CSS still stream without dependency inspection. **The grant contains at most 256 files** — the opened document and statically referenced relative HTML/CSS assets within its directory tree — and exceeding that bound fails the open without serving a partial grant. **Never expand the grant through root-relative, external, or dynamic references**; requests can read only granted paths.

**Must title the built-in viewers' Session with the canonical target's basename via `OSC 2`**, controls stripped. (rationale)

**Must require a user Tool for PDFs**, including files named `README.pdf`. (rationale)

**Must retain media/HTML grant descriptors until the Tool exits.** Refresh reads those files again; replacements and dependency-graph changes require restarting. Editing follows [Editing files](#editing-files) and [Image editor](#image-editor). **Must report a view it cannot edit clean as it starts**, so closing it asks nothing (`docs/specs/reopen.md` → "Reopenable kinds"). Cold restore creates a fresh URL capability; Workspace movement keeps the live binding.

Source of truth: `runFileViewer` in `dor-tools-builtin/src/file-viewer.ts`; `fileViewerFormat` in `dor-tools-builtin/src/file-viewer-format.ts`. Tests: `dor-tools-builtin/test/file-viewer.test.mjs`.

## Editing files

**Must render supported UTF-8 text other than Markdown in bundled Monaco**. Never execute source text or load its referenced assets.

**Must save only on Save or Cmd/Ctrl+S, to the opened canonical file.** Preserve UTF-8 BOM and the dominant line ending (mixed endings are normalized). Bound text to 8 MiB; reject invalid UTF-8. Atomically replace only after comparing the submitted revision with current disk bytes and file identity; a conflict or write failure keeps the edit dirty. New edits during a save remain dirty after that save succeeds. Reload asks before discarding edits and reads the current file at the authorized path, including atomic replacements.

**Must preserve document permissions on replacement.** Drafts sit beside the document (POSIX `0600`, then the document's mode; Windows inherits the directory ACL), and on Windows the replaced original is backed up there too. **Must keep the draft and backup when replacement is unconfirmed** and report their location: failure can mean partial replacement or a commit before its reply. (rationale)

**Must report dirty state immediately to the containing iframe and in order through OSC 367** (`docs/specs/dor-tool.md` → Unsaved changes), and answer the host's iframe save channel (`docs/specs/dor-tool.md` → Closing unsaved Tools).

Source of truth: `saveText` / `StorePath` in `dor-tools-builtin/src/editor-routes.ts`; `replaceEditable` in `dor-tools-builtin/src/editable-file.ts`; `dor-tools-builtin/viewer/editor.ts`. Tests: `dor-tools-builtin/test/atomic-save.test.mjs`.

## Markdown editor

`.md` and `.markdown` open in the bundled MDXEditor page; `.mdx` and other text stay in Monaco. Saving, reloading, and dirty reports follow [Editing files](#editing-files).

- **Must resolve the viewer's direct `lexical` and `@lexical/link` imports to the same installed modules MDXEditor uses** (rationale).
- **Must support GFM tables, task lists, frontmatter, code blocks, fenced `mermaid` diagrams, and a whole-document source mode**, which opens with the error when the rich editor cannot parse a file. **Must let source edits remain dirty and saveable after a parse error, and allow repaired source back into rich text.** Mermaid stays on 11 (rationale).
- **Must keep HTML comments verbatim and save with one final newline, the file's majority bullet and thematic-break marker, and unpadded tables**. **Must retain simple standalone bracket labels, encode literal angle brackets in text as entities, and preserve recognized headings' existing blank-line choice**, with new or renamed headings following the majority style; ambiguous Markdown keeps the serializer's escapes. The rest follows MDXEditor's serialization. Its normalization of loaded text is not an edit (rationale).
- **Never let document HTML reach the live DOM outside an allowlist** of tags and attributes, `href` limited to `http(s):`, `mailto:`, fragments, and scheme-less paths; saving keeps every original attribute, escaped, and HTML images serialize in an inert document. Mermaid diagrams are the one other path, under mermaid's own sanitizer (`docs/specs/security-local.md` → "Local-file viewer"; rationale).
- **Must serve images on request from regular image-format files at or under the document's canonical directory**, by realpath, under a `sandbox` CSP. Nothing else loads, external URLs included.
- **Never show an image at a size the document does not state**: unsized, it shows pixel for pixel, within the column. A pasted or dropped PNG or JPEG with a recorded scale goes in at its pixel width over that scale (rationale).
- **Must write a pasted or dropped PNG, JPEG, GIF, or WebP beside the document as a new file**, signature-checked, at most 32 MiB, never replacing a file; its reference is an unsaved edit.
- **Must rename a listed image on disk at once**, to an image name in its own directory not starting with `.`, never replacing another file (case-only renames allowed); rewritten references are an unsaved edit.
- **Must show an image's current pixels after Reload**, including a file changed outside the page (rationale).
- **Never rewrite a Markdown image's stated dimensions when its file is edited.**

Source of truth: `dor-tools-builtin/viewer/markdown.tsx`; `safeCreateDOM` in `dor-tools-builtin/viewer/markdown-safety.ts`; `editorRoutes` in `dor-tools-builtin/src/editor-routes.ts`; `dor-tools-builtin/src/markdown-images.ts`. Tests: `dor-tools-builtin/test/markdown-editor.test.mjs`.

### Relative links

- **Must follow a relative link on plain click**, and offer Open in another surface and Edit link on its context menu. Cmd/Ctrl-click chooses another Surface. Dispatch, and any confirmation the host asks first, follows `docs/specs/dor-tool.md` → Document navigation. (rationale)
- **Must open a local PNG or JPEG image's file the same way on Edit or double-click**, with a link's context menu whose edit item opens it.
- **Must let an enclosing link own double-click and context-menu behavior.**
- **Must treat only a scheme-less relative reference as a document link**, resolved from the opened canonical file's directory with parent references allowed and its query ignored; HTTP(S)/mail links keep their existing handling.
- **Must send document opens to the Tool process**, which emits OSC 367 (`docs/specs/security-local.md` → Local-file viewer); **never navigate relative to the capability URL**. The page receives only sent/error, with host failures shown by the Surface.
- **Must resolve a fragment to the rendered heading whose case-folded, punctuation-stripped, duplicate-suffixed id it names**, never writing ids into saved Markdown. Same-document fragments scroll without reloading or prompting; a missing heading reports an error while retaining the document. Back/Forward reading-state semantics belong to `docs/specs/dor-tool.md` → Document navigation.

Source of truth: `dor-tools-builtin/viewer/markdown.tsx`; `markdownLink` in `dor-tools-builtin/src/markdown-links.ts`; `runFileViewer` in `dor-tools-builtin/src/file-viewer.ts`.

## Image editor

`builtin:file` edits PNG and JPEG.

- **Must leave a PNG or JPEG past 32 MiB or 2²⁶ pixels, or an animated, HDR, or narrow-range PNG, view-only**, judged from its header before decoding.
- **Must save the submitted bytes unchanged, within 32 MiB**, under the revision, identity, permission, and replacement rules of [Editing files](#editing-files).
- **Must re-encode untouched PNG pixels exactly**, at 8 bits per channel, keeping the recorded resolution and the source's color metadata except a non-RGB ICC profile: verbatim in its own format, across formats only an RGB profile, converted. EXIF is dropped, pixels written upright.

Source of truth: `editorRoutes` in `dor-tools-builtin/src/editor-routes.ts`; `imageEditability` in `dor-tools-builtin/src/image-editability.ts`; `decodeImage` / `encodeImage` in `dor-tools-builtin/viewer/image/io.ts`. Tests: `dor-tools-builtin/test/image-codec.test.mjs`.

## Code editor

`builtin:code` runs as `dor __view-code`, opening any textual format — Markdown, HTML, and SVG included — as source in the [Editing files](#editing-files) Monaco page, granting only that file.

- **Must refuse binary formats and folders**, and key apart from `builtin:file` (`name: code`).

Source of truth: `BUILTIN_HANDLERS` in `dor-tools-builtin/src/file-viewer-format.ts`.

## Folder viewer

`builtin:folder`, the default folder viewer (`docs/specs/dor-tool.md` → Folders), is a Tool-owned `dor` process, titled as in [File viewer](#file-viewer):

- **Must list names and entry types only, lazily loading expanded directories, and never serve file contents** (rationale).
- **Must compact a directory containing exactly one child directory and nothing else into a slash-separated row**, continuing up to 32 levels per listing; hidden/ignored entries still count as siblings. Never compact through a symlink child. Refresh and Collapse all preserve the ordinary select/activate contract.
- **Must read at most 100,000 names and retain at most 5,000 entries before following symlinks.**
- **Must route the page's select and activate through its own process**: a same-origin POST to its capability listener, which writes it to the Tool's terminal as an OSC 367 `open` (`docs/specs/dor-tool.md` → OSC 367), `preview` for a select, in arrival order. The page learns only that it was sent, or, for a path or serialized payload the OSC encoder refuses, an error instead of a write.
- **Must hold an activate until every select in flight settles**, keeping selects concurrent. (rationale)
- **Must be safe to stop** (`docs/specs/dor-tool.md` → Reaping): the process writes the view its page reports — expanded folders, selection, ignored toggle, as root-relative paths — as its `dehydrate` payload and reopens it, skipping vanished paths, with no preview.

Source of truth: `runFolderViewer` in `dor-tools-builtin/src/folder-viewer.ts`; `folderViewerPage` in `dor-tools-builtin/src/folder-viewer-page.ts`. Tests: `dor-tools-builtin/test/folder-viewer.test.mjs`.

## Error viewer

**Must show why an OSC 367 `open` failed** when the host runs `dor __view-error <target> <message>` in the preview slot (`docs/specs/dor-tool.md` → OSC 367): one page naming the target's basename and the message, both escaped, with no script, served by the shared capability listener and titled as in [File viewer](#file-viewer). No handler name selects it.

Source of truth: `runErrorViewer` in `dor-tools-builtin/src/error-viewer.ts`; `VIEW_ERROR_ARGV` in `dor-tools-builtin/src/file-viewer-format.ts`.
