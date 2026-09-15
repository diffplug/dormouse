/** Production entrypoint: fixed-port validation and deployment defaults. */
import { loadConfig } from './config.js';
import { startRelay } from './start.js';

await startRelay(loadConfig());
