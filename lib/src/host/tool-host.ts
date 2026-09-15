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
import { resolveUpstreamUrl } from './git-upstream';
import { resolveToolInput } from './tool-input';
import { readUserToolFile, userToolConfigPath } from './tool-user-config';
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
        const args = request.args ?? [];
        const lookup = request.global ? { status: 'no-file' as const } : await lookupTool(request.name, request.cwd, trust);
        if (lookup.status === 'no-file' || lookup.status === 'unknown-tool') {
          const path = options.userConfigPath ?? userToolConfigPath();
          const file = await readUserToolFile(path);
          const entry = file?.tools.get(request.name);
          if (file && entry) {
            const input = await resolveToolInput(entry, { projectRoot: null, cwd: request.cwd, args });
            return { status: 'ok', projectRoot: file.dir, path, name: entry.name,
              ...input, scope: 'user', render: entry.render, port: entry.port, warnings: [...file.warnings] };
          }
          if (request.global && file) return { status: 'unknown-tool', projectRoot: file.dir, path, names: [...file.tools.keys()].sort() };
          return lookup;
        }
        if (lookup.status === 'untrusted') {
          const input = await resolveToolInput({ name: lookup.name, run: lookup.run, dedupeTemplate: null },
            { projectRoot: lookup.projectRoot, cwd: request.cwd, args });
          return { ...lookup, run: input.run };
        }
        if (lookup.status !== 'ok') return lookup;
        const { entry } = lookup;
        const input = await resolveToolInput(entry, { projectRoot: lookup.projectRoot, cwd: request.cwd, args });
        return {
          status: 'ok',
          projectRoot: lookup.projectRoot,
          path: lookup.path,
          name: entry.name,
          ...input,
          render: entry.render,
          port: entry.port,
          warnings: [...lookup.file.warnings],
        };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
