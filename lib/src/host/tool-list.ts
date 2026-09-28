/**
 * `dor tool --list` (`docs/specs/dor-tool.md` -> CLI): the Tools `dor tool
 * <name>` would resolve from a directory, each with the comment its author
 * wrote above it. Listing reads and executes nothing, so a project needs no
 * grant to be listed; the answer reports whether it has one.
 */
import { dirname } from 'node:path';
import type { ToolListEntry, ToolListResponse } from 'dor/commands/types';
import { resolveUpstreamUrl } from './git-upstream';
import { parseToolFile, toolDescriptions, type ToolFile } from './tool-registry';
import { findToolFile, projectGrant, readToolFile, type ToolTrustStore } from './tool-trust';

export async function listTools(
  request: { cwd: string; global?: boolean },
  options: {
    trust: ToolTrustStore;
    userPath: string;
    /** Test seam. */
    resolveUpstream?: (dir: string) => Promise<string | null>;
  },
): Promise<ToolListResponse> {
  const { trust, userPath, resolveUpstream = resolveUpstreamUrl } = options;
  const tools: ToolListEntry[] = [];
  const warnings: string[] = [];

  let project: ToolListResponse['project'] = null;
  const found = request.global ? null : await findToolFile(request.cwd);
  if (found) {
    const file = parseToolFile(found.text, { path: found.path, dir: found.dir, scope: 'repo' });
    const grant = await projectGrant(found.dir, trust, resolveUpstream);
    project = { path: found.path, approved: grant.trusted };
    tools.push(...entries(file, found.text, 'project', new Set()));
    warnings.push(...file.warnings);
  }

  let userText: string | null = null;
  try {
    userText = await readToolFile(userPath, { followSymlink: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (userText !== null) {
    const file = parseToolFile(userText, { path: userPath, dir: dirname(userPath), scope: 'user' });
    tools.push(...entries(file, userText, 'user', new Set(tools.map(tool => tool.name))));
    warnings.push(...file.warnings);
  }

  return { project, user: { path: userPath, found: userText !== null }, tools, warnings };
}

function entries(file: ToolFile, text: string, scope: ToolListEntry['scope'], shadowing: ReadonlySet<string>): ToolListEntry[] {
  const descriptions = toolDescriptions(text);
  return [...file.tools.values()].map(entry => ({
    name: entry.name,
    scope,
    run: typeof entry.run === 'string' ? entry.run : [...entry.run],
    render: entry.render,
    port: entry.port,
    keyed: entry.dedupeTemplate !== null,
    description: descriptions.get(entry.name) ?? null,
    shadowed: shadowing.has(entry.name),
  }));
}
