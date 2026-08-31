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
import type { ToolControlResult, ToolHostRequest } from '../lib/platform/tool-types';
import { resolveDedupeKey } from './tool-registry';
import {
  FileToolTrustStore,
  MemoryToolTrustStore,
  folderGrantKey,
  lookupTool,
  upstreamGrantKey,
  type ToolTrustStore,
} from './tool-trust';

export interface ToolHost {
  handle(request: ToolHostRequest): Promise<ToolControlResult>;
}

/**
 * `stateDir` is where the trust record lives. Without one the decision is
 * in-memory and dies with the host: a host with no durable state re-asks each
 * run, which is annoying but never wrong, where inventing a location could put
 * a security decision somewhere the user cannot find to revoke it.
 */
export function createToolHost(options: { stateDir?: string } = {}): ToolHost {
  const trust: ToolTrustStore = options.stateDir
    ? new FileToolTrustStore(options.stateDir)
    : new MemoryToolTrustStore();

  return {
    async handle(request) {
      if (request.op === 'trust') {
        // The key is derived here, not taken from the request: the webview says
        // *which kind* the human picked, and the host owns the mapping from a
        // project to its keys.
        const key = request.kind === 'upstream' && request.upstreamUrl
          ? upstreamGrantKey(request.upstreamUrl)
          : folderGrantKey(request.projectRoot);
        const kind = request.kind === 'upstream' && request.upstreamUrl ? 'upstream' : 'folder';
        await trust.grant(key, kind);
        return { status: 'trust-recorded' };
      }

      const lookup = await lookupTool(request.name, request.cwd, trust);
      if (lookup.status !== 'ok') {
        // Every non-ok arm is already wire-shaped.
        return lookup;
      }
      const { entry } = lookup;
      try {
        return {
          status: 'ok',
          projectRoot: lookup.projectRoot,
          path: lookup.path,
          name: entry.name,
          run: entry.run,
          render: entry.render,
          port: entry.port,
          key: resolveDedupeKey(entry, { projectRoot: lookup.projectRoot, cwd: request.cwd }),
          warnings: [...lookup.file.warnings],
        };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
