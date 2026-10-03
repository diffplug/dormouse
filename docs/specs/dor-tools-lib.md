# Dor Tools Library

> See `docs/specs/glossary.md` for Session / Pane vocabulary.
> Owns `dor-tools-lib`, the MIT package that Tools and their hosts share for the Tool integration protocol: its license and dependency boundary, entry points, and consumers. The wire rules it implements belong to `docs/specs/dor-tool.md` → OSC 367, Unsaved changes, and Closing unsaved Tools.

## Package

**Must stay MIT with no runtime dependencies, importing only its own modules**, so a Tool or a third-party host can embed it without FSL code or a transitive install. `dor-tools-lib/test/boundary.test.mjs` fails on a declared dependency, a license change, or an import leaving `src`.

**Must remain `private` until the protocol reaches 1.0.** New host capabilities land here, in the host, and in `docs/specs/dor-tool.md` together, one per change, before the first publish; see [Future](#future).

| Entry point | Tool side | Host side |
|---|---|---|
| `osc` | `serveSequence`, `stateSequence`, `openSequence`: throw on a value the host would ignore | `parseToolAnnounce`, `parseToolState`, `parseToolOpen`, `validToolServePath` |
| `protocol` | `readHostMessage` | `readFrameMessage` (sanitizes and bounds a save error) |
| `frame` | `connectToolFrame` | — |

- **The host (`lib`) must reach the package through source aliases**, beside every `dor-tools-builtin/*` alias (tsconfig `paths`, Vite, Storybook, esbuild, vitest), since no host build compiles the package first.
- **`dor-tools-builtin` consumes the built package**: its prebuild builds `dor-tools-lib`, the viewer process imports `osc`, and the editor pages bundle `frame`.

Source of truth: `dor-tools-lib/src/` (a module per entry point); `dor-tools-lib/package.json`; `dor-tools-builtin/package.json`.

## Future

**Scope: dor-tools-lib** — what remains before publishing 1.0, in order.

- **New host capabilities**, each carrying its wire, library, and host halves: Tool preferences the host stores, Pane header buttons, and the like.
- **Save coordination for third-party Tools.** Extend the save channel beyond `builtin:file` frames, auditing the frame boundary in `docs/specs/security-local.md`.
- **Theme through the library.** A `frame` subscription to the host's iframe theme (`docs/specs/theme.md` → Tool iframe themes), which today reaches Tools only through the proxy shim.
- **Publish.** A host-neutral protocol reference inside the package, the OSC 367 collision sweep (`docs/specs/dor-tool.md` → Open questions), and npm trusted publishing.
