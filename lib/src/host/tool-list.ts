/**
 * `dor tool --list` (`docs/specs/dor-tool.md` -> CLI): the Tools `dor tool
 * <name>` would resolve from a directory, each with the comment its author
 * wrote above it. Listing only reads configuration and executes no Tool, so a project needs no
 * grant to be listed; the answer reports whether it has one.
 */
import type { ToolListEntry, ToolListRequest, ToolListResponse } from 'dor/commands/types';
import type { ToolFile } from './tool-registry';
import { loadProjectToolFile, projectGrant, type ToolTrustStore } from './tool-trust';
import { readUserToolFile } from './tool-user-config';

export async function listTools(
  request: ToolListRequest,
  options: { trust: ToolTrustStore; userPath: string },
): Promise<ToolListResponse> {
  const project = request.global ? null : await loadProjectToolFile(request.cwd);
  const user = await readUserToolFile(options.userPath);
  const projectNames = new Set(project?.file.tools.keys());
  return {
    project: project && { path: project.path, approved: (await projectGrant(project.dir, options.trust)).trusted },
    user: { path: options.userPath, found: user !== null },
    tools: [
      ...(project ? entries(project.file, 'project') : []),
      ...(user ? entries(user, 'user').map(entry => ({ ...entry, shadowed: projectNames.has(entry.name) })) : []),
    ],
    warnings: [...(project?.file.warnings ?? []), ...(user?.warnings ?? [])],
  };
}

function entries(file: ToolFile, scope: ToolListEntry['scope']): ToolListEntry[] {
  return [...file.tools.values()].map(entry => ({
    name: entry.name,
    scope,
    run: typeof entry.run === 'string' ? entry.run : [...entry.run],
    render: entry.render,
    port: entry.port,
    keyed: entry.dedupeTemplate !== null,
    description: entry.description,
    shadowed: false,
  }));
}
