/** Render stamped build metadata for the bundled `dor` CLI. */

import { buildCommand } from '@stricli/core';
import { DOR_VERSION_METADATA } from '../generated-version.js';
import type {
  Command,
  DorCommandContext,
  VersionMetadata,
} from './types.js';
import { renderJson, writeStdout } from './shared.js';

interface VersionFlags {
  readonly json?: boolean;
}

export const versionCommand: Command = {
  name: 'version',
  command: buildCommand<VersionFlags, [], DorCommandContext>({
    docs: {
      brief: 'Print the dor CLI version.',
      fullDescription: `Prints the latest released Dormouse version from CHANGELOG.md, the build commit, and a prerelease-style build suffix when the build contains commits after that version tag.

Text output:
  dor 0.11.0 [1a2b3c4d] (0.11.0+12)

JSON output:
  {
    "version": "0.11.0",
    "commit": "1a2b3c4d",
    "commits_since_version": 12,
    "build": "0.11.0+12"
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
      },
    },
    func: runVersionCommand,
  }),
};

function runVersionCommand(this: DorCommandContext, flags: VersionFlags): void {
  const metadata = this.options.versionMetadata ?? DOR_VERSION_METADATA;
  writeStdout(this, flags.json === true ? renderVersionJson(metadata) : renderVersion(metadata));
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

function renderVersionJson(metadata: VersionMetadata): string {
  return renderJson({
    version: metadata.version,
    commit: metadata.commit,
    commits_since_version: metadata.commitsSinceVersion,
    build: buildTag(metadata),
  });
}
