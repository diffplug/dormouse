/** Production entrypoint: fixed-port validation and deployment defaults. */
import { ConfigError, readConfig } from './config.js';
import { startRelay } from './start.js';

try {
  await startRelay(readConfig());
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
