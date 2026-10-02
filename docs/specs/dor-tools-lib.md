# Dor Tools Library

> See `docs/specs/glossary.md` for Session / Pane vocabulary.
> Owns `dor-tools-lib`, the MIT package that Tools and their hosts share for the Tool integration protocol: its license and dependency boundary, entry points, and consumers. The wire rules it implements belong to `docs/specs/dor-tool.md` → OSC 367, Unsaved changes, and Closing unsaved Tools.

## Files

- `dor-tools-lib/src/osc.ts` — OSC 367: the Tool's `serve` / `state` / `open` encoders and the host's parsers.
- `dor-tools-lib/src/protocol.ts` — the iframe save channel's messages in both directions, versioned by `dorTool`.
- `dor-tools-lib/src/frame.ts` — the Tool side of the save channel for a framed page.
- `dor-tools-lib/src/sanitize.ts` — the package's own guards for untrusted input.

## Package

**Must stay MIT with no runtime dependencies, importing only its own modules**, so a Tool or a third-party host can embed it without FSL code or a transitive install. `dor-tools-lib/test/boundary.test.mjs` fails on a declared dependency, a license change, or an import leaving `src`.

**Must remain `private` until the protocol reaches 1.0.** New host capabilities land here, in the host, and in `docs/specs/dor-tool.md` together, one per change, before the first publish; see [Future](#future).

| Entry point | Tool side | Host side |
|---|---|---|
| `osc` | `serveSequence`, `stateSequence`, `openSequence`: throw on a value the host would ignore | `parseToolAnnounce`, `parseToolState`, `parseToolOpen`, `validToolServePath` |
| `protocol` | `readHostMessage` | `readFrameMessage` (sanitizes and bounds a save error) |
| `frame` | `connectToolFrame` | — |

- **The host (`lib`) must reach the package through source aliases**, beside every `dor-tools-builtin/*` alias (tsconfig `paths`, Vite, Storybook, esbuild, vitest), since no host build compiles the package first.
- **`dor-tools-builtin` consumes the built package**: its prebuild builds `dor-tools-lib`, the viewer process imports `osc`, and the Monaco page bundles `frame`.

Source of truth: `dor-tools-lib/package.json`; `dor-tools-builtin/package.json`. Tests: `dor-tools-lib/test/boundary.test.mjs`, `dor-tools-lib/test/osc.test.mjs`, `dor-tools-lib/test/protocol.test.mjs`, `dor-tools-lib/test/frame.test.mjs`.

## Future

**Scope: dor-tools-lib** — what remains before publishing 1.0, in order.

- **New host capabilities**, each carrying its wire, library, and host halves: Tool preferences the host stores, Pane header buttons, and the like.
- **Save coordination for third-party Tools.** Extend the save channel beyond `builtin:file` frames, auditing the frame boundary in `docs/specs/security-local.md`.
- **Theme through the library.** A `frame` subscription to the host's iframe theme (`docs/specs/theme.md` → Tool iframe themes), which today reaches Tools only through the proxy shim.
- **Publish.** A host-neutral protocol reference inside the package, the OSC 367 collision sweep (`docs/specs/dor-tool.md` → Open questions), and npm trusted publishing.
