/** Render stamped build metadata for the bundled `dor` CLI. */

import { buildCommand } from '@stricli/core';
import { DOR_VERSION_METADATA } from '../generated-version.js';
import type {
  Command,
  DorCommandContext,
  VersionMetadata,
} from './types.js';
import { writeStdout } from './shared.js';

export const versionCommand: Command = {
  name: 'version',
  command: buildCommand<{}, [], DorCommandContext>({
    docs: {
      brief: 'Print the dor CLI version.',
      fullDescription: `Prints the latest released Dormouse version from CHANGELOG.md, the build commit, and a prerelease-style build suffix when the build contains commits after that version tag.

Text output:
  dor 0.11.0 [1a2b3c4d] (0.11.0+12)`,
    },
    parameters: {},
    func: runVersionCommand,
  }),
};

function runVersionCommand(this: DorCommandContext): void {
  writeStdout(this, renderVersion(this.options.versionMetadata ?? DOR_VERSION_METADATA));
}

export function renderVersion(metadata: VersionMetadata): string {
  const suffix = metadata.commitsSinceVersion > 0
    ? ` (${metadata.version}+${metadata.commitsSinceVersion})`
    : '';
  return `dor ${metadata.version} [${metadata.commit}]${suffix}\n`;
}
