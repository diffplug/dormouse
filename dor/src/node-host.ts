import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AGENT_BROWSER } from './commands/agent-browser.js';
import { runBrowserCli } from './commands/browser-cli.js';
import { listFiles } from './commands/file-list.js';
import { PLAYWRIGHT } from './commands/playwright.js';
import type { CliHost } from './commands/types.js';
import { SocketControlClient } from './control-client.js';
import { DOR_SKILL_MARKDOWN } from './generated-skill.js';
import { DOR_VERSION_METADATA } from './generated-version.js';

/** The machine `dor` runs on: everything `cli-core.ts` and the commands need
 * from Node, so they stay loadable in a browser (`docs/specs/dor-cli.md`). */
export const NODE_HOST: CliHost = {
  platform: process.platform,
  cwd: () => process.cwd(),
  homedir,
  resolvePath: (base, path) => resolve(base, path),
  connect: (endpoint) => new SocketControlClient(endpoint),
  listFiles,
  readTextFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  writeTextFile: (path, text) => { writeFileSync(path, text); },
  runBrowserCli: (provider, args, options) => runBrowserCli(provider === 'playwright' ? PLAYWRIGHT : AGENT_BROWSER, args, options),
  // Resolve from the running CLI, never a workspace package or the caller's
  // cwd. The URL import leaves the builtins outside dor.js and in this process.
  loadBuiltinViewers: () => import(new URL('./builtin/runtime.js', import.meta.url).href),
  versionMetadata: DOR_VERSION_METADATA,
  skillMarkdown: DOR_SKILL_MARKDOWN,
};
