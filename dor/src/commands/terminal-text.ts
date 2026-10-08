// Browser-safe: the website playground's dor prints with these.
import { FORMAT_CHARACTERS } from './shell-quote.js';
import type { ToolSurfaceResponse, VersionMetadata } from './types.js';

const TERMINAL_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
const CONTROL_OR_FORMAT = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${FORMAT_CHARACTERS}]`, 'g');
/** What `JSON.stringify` leaves unescaped of the set above. */
const JSON_UNESCAPED = new RegExp(`[\\x7f-\\x9f${FORMAT_CHARACTERS}]`, 'g');
export const escapeControl = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** The one spelling of a `dor` error line, shared by every path that prints one. */
export function errorLine(message: string): string {
  return `Error: ${message}`;
}

/** Repo text relayed by the host, bound for a terminal: C0, DEL, and C1
 *  controls become `\u` escapes, so the text cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(TERMINAL_CONTROLS, escapeControl);
}

/** `printable` for text a person reads to decide whether to run something —
 *  Tool configuration and the consent dialogs: format characters that reorder
 *  or hide text become `\u` escapes too, so what shows is what is there. */
export function printableExact(text: string): string {
  return text.replace(CONTROL_OR_FORMAT, escapeControl);
}

/** The same controls removed rather than escaped. */
export function stripControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS, '');
}

export function renderJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** `renderJson` for repo text: `JSON.stringify` escapes only C0, so DEL, C1,
 *  and format characters are escaped too, which leaves the parsed value
 *  unchanged. */
export function renderPrintableJson(payload: unknown): string {
  return renderJson(payload).replace(JSON_UNESCAPED, escapeControl);
}

/** What `dor tool` and `dor open` print for the host's answer. Its command and
 *  cwd come from repo config, so every output escapes controls and format
 *  characters. */
export function renderToolResponse(response: ToolSurfaceResponse, json: boolean): string {
  if (json) {
    return renderPrintableJson({
      status: response.status,
      surface_id: response.surfaceId,
      surface_ref: response.surfaceRef,
      command: response.command,
      cwd: response.cwd,
      minimized: response.minimized,
      key: response.key,
    });
  }
  return `${printableExact(`${response.status} ${response.surfaceRef}  ${JSON.stringify(response.command)}`)}\n`;
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
