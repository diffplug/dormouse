/**
 * The Node-side entry both hosts install for Dor Tools
 * (`docs/specs/dor-tool.md`). Bundled into the standalone sidecar as
 * `tool-host.cjs` and imported directly by the VS Code extension host.
 *
 * Two operations, one method: resolve a tool name against the nearest
 * `dormouse.yml`, and record a trust decision a human made in Dormouse's own
 * chrome. Everything crossing back to the webview is plain JSON — the
 * standalone path goes through Rust.
 */
import { dirname } from 'node:path';
import type { ToolControlResult, ToolHostRequest } from '../lib/platform/tool-types';
import { resolveUpstreamUrl } from './git-upstream';
import { resolveOpenTool } from './tool-open';
import type { ToolInput } from './tool-input';
import { parseBrowserSection, type ToolEntry } from './tool-registry';
import { mergeBrowserConfig, toolViewport } from './browser-config';
import type { BrowserViewportConfig } from 'dor-lib-common/browser-viewports';
import { readUserBrowserConfig, readUserToolFile, resolveUserTool, userToolConfigPath } from './tool-user-config';
import {
  FileToolTrustStore,
  MemoryToolTrustStore,
  folderGrantKey,
  findToolFile,
  lookupTool,
  upstreamGrantKey,
  type ToolTrustStore,
} from './tool-trust';

export interface ToolHost {
  handle(request: ToolHostRequest): Promise<ToolControlResult>;
}

/** The `ok` result for a project Tool after its trust gate. */
function okResult(
  entry: ToolEntry,
  input: ToolInput,
  source: { projectRoot: string; path: string; warnings: readonly string[] },
  browserConfig: BrowserViewportConfig,
): ToolControlResult {
  return {
    status: 'ok',
    projectRoot: source.projectRoot,
    path: source.path,
    name: entry.name,
    ...input,
    render: entry.render,
    viewport: toolViewport(entry.render, entry.viewport, browserConfig),
    port: entry.port,
    warnings: [...source.warnings],
  };
}

/**
 * `stateDir` is where the trust record lives. Without one the decision is
 * in-memory and dies with the host: a host with no durable state re-asks each
 * run, which is annoying but never wrong, where inventing a location could put
 * a security decision somewhere the user cannot find to revoke it.
 */
export function createToolHost(options: { stateDir?: string; userConfigPath?: string } = {}): ToolHost {
  const trust: ToolTrustStore = options.stateDir
    ? new FileToolTrustStore(options.stateDir)
    : new MemoryToolTrustStore();

  return {
    async handle(request) {
      if (request.op === 'trust') {
        // The key is derived here, not taken from the request: the webview says
        // *which kind* the human picked, and the host owns the mapping from a
        // project to its keys. An `upstream` pick with no URL falls back to the
        // folder rather than minting a key on an empty string.
        const upstream = request.kind === 'upstream'
          ? await resolveUpstreamUrl(request.projectRoot)
          : null;
        await trust.grant(
          upstream ? upstreamGrantKey(upstream) : folderGrantKey(request.projectRoot),
          upstream ? 'upstream' : 'folder',
        );
        return { status: 'trust-recorded' };
      }

      try {
        const userPath = options.userConfigPath ?? userToolConfigPath();
        if (request.op === 'browser-config') {
          return { status: 'browser-config', config: await readBrowserConfig(request.cwd, userPath) };
        }
        if (request.op === 'open') return await resolveOpenTool(request, userPath);
        const args = request.args ?? [];
        const project = request.global ? null : await lookupTool(request.name, request.cwd, trust, { args });
        if (project?.status === 'ok') {
          const userFile = await readUserToolFile(userPath);
          return okResult(project.entry, project.input, { projectRoot: project.projectRoot, path: project.path, warnings: project.file.warnings }, mergeBrowserConfig(userFile?.browser, project.file.browser));
        }
        if (project && project.status !== 'no-file' && project.status !== 'unknown-tool') return project;

        // A project miss falls through to the user's own Tools, which need no grant.
        const file = await readUserToolFile(userPath);
        const entry = file?.tools.get(request.name);
        if (file && entry) return await resolveUserTool(file, userPath, entry, request.cwd, args,
          request.global ? mergeBrowserConfig(file.browser) : await readBrowserConfig(request.cwd, userPath));
        if (project && (project.status !== 'no-file' || !file)) return project;
        return { status: 'unknown-tool', projectRoot: dirname(userPath), path: userPath, names: [...(file?.tools.keys() ?? [])].sort() };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Same bounded discovery and parsing as Tools, without their execution gate. */
async function readBrowserConfig(cwd: string, userPath: string): Promise<BrowserViewportConfig> {
  const user = await readUserBrowserConfig(userPath);
  const found = await findToolFile(cwd);
  const project = found ? parseBrowserSection(found.text, found.path) : undefined;
  return mergeBrowserConfig(user, project);
}
