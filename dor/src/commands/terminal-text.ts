// Browser-safe: the website playground's dor prints with these.
import type { ToolSurfaceResponse, VersionMetadata } from './types.js';

const TERMINAL_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
export const escapeControl = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Repo text relayed by the host, bound for a terminal: C0, DEL, and C1
 *  controls become `\u` escapes, so the text cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(TERMINAL_CONTROLS, escapeControl);
}

/** The same controls removed rather than escaped. */
export function stripControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS, '');
}

export function renderJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** What `dor tool` and `dor open` print for the host's answer. */
export function renderToolResponse(response: ToolSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      surface_id: response.surfaceId,
      surface_ref: response.surfaceRef,
      command: response.command,
      cwd: response.cwd,
      minimized: response.minimized,
      key: response.key,
    });
  }
  return `${response.status} ${response.surfaceRef}  ${JSON.stringify(response.command)}\n`;
}

// The prerelease-style build tag: `<version>+<N>` when the build carries commits
// past the version tag, else just `<version>`.
function buildTag(metadata: VersionMetadata): string {
  return metadata.commitsSinceVersion > 0
    ? `${metadata.version}+${metadata.commitsSinceVersion}`
    : metadata.version;
}

export function renderVersion(metadata: VersionMetadata): string {
  const suffix = metadata.commitsSinceVersion > 0 ? ` (${buildTag(metadata)})` : '';
  return `dor ${metadata.version} [${metadata.commit}]${suffix}\n`;
}

export function renderVersionJson(metadata: VersionMetadata): string {
  return renderJson({
    version: metadata.version,
    commit: metadata.commit,
    commits_since_version: metadata.commitsSinceVersion,
    build: buildTag(metadata),
  });
}
