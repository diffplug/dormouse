// Bundle the host-agnostic iframe proxy (lib/src/host/iframe-proxy.ts, shared
// with the VS Code extension host) into a CommonJS file the Node sidecar can
// require. Keeps the proxy as a single TypeScript source while the sidecar
// itself stays plain CJS. See docs/specs/dor-iframe.md → "The Transparent Proxy".
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../lib/src/host/iframe-proxy.ts');
const outfile = path.resolve(here, '../sidecar/iframe-proxy.cjs');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node', // node builtins (http/net) stay external automatically
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});

console.log(`[sidecar] built ${path.relative(process.cwd(), outfile)}`);
