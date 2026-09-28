// Shared by both Burrow builds (`standalone/scripts/build-sidecar-proxy.mjs`,
// `vscode-ext/scripts/esbuild.mjs`), which bundle `native-direct-peer.ts`.

import path from 'node:path';

/**
 * Fail the build if esbuild inlined a package the bundle must load at runtime.
 *
 * `native-direct-peer.ts` calls `require('<specifier>')` by literal, so an
 * external specifier stays a `require-call` edge out of the bundle while a
 * bundled one becomes an input of it. That difference is the whole check: an
 * inlined addon produces a bundle that loads and then cannot find the addon's
 * `.node` file, which nothing before the first `direct-offer` on a real
 * machine would notice.
 */
export function assertNothingInlined(metafile, outfile, names, label) {
  // esbuild keys `metafile.outputs` by path relative to the process cwd, with
  // `/` separators on every platform.
  const outputKey = path.relative(process.cwd(), outfile).split(path.sep).join('/');
  const output = metafile.outputs[outputKey];
  if (!output) {
    throw new Error(`${label}: esbuild metafile has no output for "${outputKey}" — cannot check what it bundled.`);
  }
  for (const name of names) {
    // Every layout a package manager resolves through ends in this segment,
    // pnpm's content-addressed store included.
    const inlined = Object.keys(output.inputs).find((input) => input.includes(`node_modules/${name}/`));
    if (!inlined) continue;
    throw new Error(
      `${label}: ${outputKey} inlined "${inlined}" — "${name}" is loaded at runtime, and the addon would ` +
        'look for its platform package beside the bundle instead of inside the installed package.',
    );
  }
}
