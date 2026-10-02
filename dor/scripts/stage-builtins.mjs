import { cp, rm } from 'node:fs/promises';

// Keep the runtime and its browser assets together; dor loads it in-process.
const from = new URL('../node_modules/dor-tools-builtin/dist/', import.meta.url);
const to = new URL('../dist/builtin/', import.meta.url);
await cp(new URL('runtime.js', from), new URL('runtime.js', to));
await rm(new URL('viewer/', to), { recursive: true, force: true });
await cp(new URL('viewer/', from), new URL('viewer/', to), { recursive: true });
