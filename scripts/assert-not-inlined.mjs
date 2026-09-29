// Shared by both Burrow builds (`standalone/scripts/build-sidecar-proxy.mjs`,
// `vscode-ext/scripts/esbuild.mjs`), which bundle `native-direct-peer.ts`.

/**
 * Fail the build if esbuild inlined a package the bundle must `require` at
 * runtime (`requireNative` in `lib/src/host/remote/native-direct-peer.ts` says
 * why). An external specifier stays a `require` edge out of the bundle; an
 * inlined one shows up among the metafile's inputs. Each caller builds one
 * entry point per metafile, so every input belongs to the bundle checked.
 */
export function assertNothingInlined(metafile, names, label) {
  for (const name of names) {
    // Every layout a package manager resolves through ends in this segment,
    // pnpm's content-addressed store included.
    const inlined = Object.keys(metafile.inputs).find((input) => input.includes(`node_modules/${name}/`));
    if (inlined) throw new Error(`${label}: inlined "${inlined}" — "${name}" must stay a runtime require.`);
  }
}
