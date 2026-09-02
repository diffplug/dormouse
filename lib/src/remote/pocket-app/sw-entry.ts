/**
 * The bundler entry for Pocket's service worker: the only file that names the
 * real worker globals (`lib/vite.sw.config.ts` builds it into
 * `dist-pocket/sw.js`).
 *
 * Separate from `sw.ts` so importing the worker's logic — as `sw.test.ts` does
 * — installs no listeners, structurally rather than by sniffing `globalThis`.
 */

import { indexedDbKnownHostStore } from '../client/pocket-db';
import { installPocketWorker, type WorkerScope } from './sw';

installPocketWorker(self as unknown as WorkerScope, indexedDbKnownHostStore());
