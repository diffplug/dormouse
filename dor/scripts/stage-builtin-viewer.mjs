import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The built-in viewers run inside the bundled `dist/dor.js`, which reads their
// browser assets next to itself (`viewerAsset` in dor-tools-builtin).
const from = fileURLToPath(new URL('../node_modules/dor-tools-builtin/dist/viewer/', import.meta.url));
const to = fileURLToPath(new URL('../dist/viewer/', import.meta.url));
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
