/**
 * The bundler entry for a frame origin's service worker: the only file that
 * names the real worker globals. Separate from `worker.ts`, as Pocket's own
 * worker is from its logic, so importing that installs no listeners.
 */

import { installFrameWorker, type FrameWorkerScope } from './worker';

installFrameWorker(self as unknown as FrameWorkerScope);
