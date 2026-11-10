/**
 * `dor tool --list` (`docs/specs/dor-tool.md` -> CLI): the Tools `dor tool
 * <name>` would resolve from a directory, each with the comment its author
 * wrote above it. Listing only reads configuration and executes no Tool, so a project needs no
 * grant to be listed; the answer reports whether it has one.
 */
import type { ResolvedToolListEntry, ToolListEntry, ToolListRequest, ToolListResponse } from 'dor/commands/types';
import type { ToolEntry } from './tool-registry';
import { loadProjectToolFile, projectGrant, type ToolTrustStore } from './tool-trust';
import { readUserToolFile, type UserToolFile } from './tool-user-config';

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
      ...(project ? [...project.file.tools.values()].map(entry => listEntry(entry, 'project')) : []),
      ...(user ? userEntries(user).map(entry => ({ ...entry, shadowed: projectNames.has(entry.name) })) : []),
    ],
    warnings: [...(project?.file.warnings ?? []), ...(user?.warnings ?? [])],
  };
}

function listEntry(entry: ToolEntry, scope: ToolListEntry['scope']): ResolvedToolListEntry {
  return {
    name: entry.name,
    scope,
    run: typeof entry.run === 'string' ? entry.run : [...entry.run],
    render: entry.render,
    port: entry.port,
    keyed: entry.dedupeTemplate !== null,
    description: entry.description,
    shadowed: false,
  };
}

/** In file order, an import marked with the file it read, a broken one with why. */
function userEntries(file: UserToolFile): ToolListEntry[] {
  return file.names.map(name => {
    const broken = file.broken.get(name);
    if (broken) return { name, scope: 'user', description: broken.description, shadowed: false, from: broken.path, broken: broken.reason };
    const entry = file.tools.get(name)!;
    return { ...listEntry(entry, 'user'), ...(entry.imported ? { from: entry.path } : {}) };
  });
}
