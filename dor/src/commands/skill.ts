/** Print the bundled Dormouse agent skill, or install its bootstrap stub. */

import { buildCommand } from '@stricli/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { DOR_SKILL_MARKDOWN as skillMarkdown } from '../generated-skill.js';
import type { Command, DorCommandContext } from './types.js';
import { callerWorkingDirectory, renderJson, writeStdout } from './shared.js';

interface SkillFlags {
  readonly install?: boolean;
  readonly json?: boolean;
}

// The stub is deliberately fact-free: its whole content is the detection rule, so
// a committed copy carries no `dor` specifics that could drift out of date — the
// agent runs `dor skill` for the real, always-current instructions.
const BOOTSTRAP_STUB = `<!-- dor-skill:begin — managed by \`dor skill --install\`; edits inside are overwritten -->
If the \`DORMOUSE_SURFACE_ID\` environment variable is set, this terminal is
hosted by [Dormouse](https://dormouse.sh) and its \`dor\` CLI is on \`PATH\`: run
\`dor skill\` and follow what it prints to make full use of the terminal
(background processes in visible panes, browser surfaces, sub-agents). If the
variable is not set, ignore this section — \`dor\` is not available.
<!-- dor-skill:end -->`;

// Prefix of the opening marker line — enough to detect an existing block.
const BEGIN_MARKER = '<!-- dor-skill:begin';
// The closing marker; the rewrite region runs through its `-->`.
const END_MARKER = 'dor-skill:end -->';

// Instruction files an agent reads, in the order we adopt/prefer them.
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

export const skillCommand: Command = {
  name: 'skill',
  command: buildCommand<SkillFlags, [], DorCommandContext>({
    docs: {
      brief: 'Print the Dormouse agent skill, or install its bootstrap stub.',
      fullDescription: `Prints the Dormouse agent skill — instructions that teach a coding agent to drive Dormouse through the dor CLI: run background processes in visible panes, open browser surfaces, and launch and coordinate sub-agents. The text ships inside the CLI, so it always matches the Dormouse that staged it.

--install instead writes a marker-delimited bootstrap stub into the project's agent instructions file. The stub's whole content is the detection rule — if DORMOUSE_SURFACE_ID is set, run \`dor skill\` and follow it — so a committed stub carries no CLI facts of its own and never goes stale.

If AGENTS.md or CLAUDE.md already contains the block, it is rewritten in place. Otherwise the stub goes to AGENTS.md when it exists, else to CLAUDE.md when it exists and does not already import AGENTS.md (via \`@AGENTS.md\`), else to a newly created AGENTS.md. Everything outside the markers is left untouched, so re-running is idempotent.

Text output:
  created AGENTS.md
  updated CLAUDE.md

JSON output:
  {
    "status": "created",
    "file": "AGENTS.md"
  }`,
    },
    parameters: {
      flags: {
        install: { kind: 'boolean', brief: 'Install the bootstrap stub into the project\'s agent instructions file.', optional: true, withNegated: false },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
      },
    },
    func: runSkillCommand,
  }),
};

function runSkillCommand(this: DorCommandContext, flags: SkillFlags): void | Error {
  if (flags.install === true) return installStub(this, flags.json === true);
  writeStdout(this, flags.json === true ? renderJson({ markdown: skillMarkdown }) : skillMarkdown);
  return undefined;
}

function installStub(context: DorCommandContext, json: boolean): void | Error {
  const projectDir = callerWorkingDirectory(undefined, context.options.env);

  // First adopt an existing block wherever it already lives, rewriting it in
  // place so hand edits outside the markers survive.
  for (const name of CANDIDATES) {
    const path = resolvePath(projectDir, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    if (!content.includes(BEGIN_MARKER)) continue;
    const rewritten = rewriteStub(content, name);
    if (rewritten instanceof Error) return rewritten;
    writeFileSync(path, rewritten);
    return renderInstall(context, 'updated', name, json);
  }

  // No block yet: append to AGENTS.md when it exists, else CLAUDE.md unless it
  // already imports AGENTS.md, else create AGENTS.md.
  const agentsPath = resolvePath(projectDir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    writeFileSync(agentsPath, appendStub(readFileSync(agentsPath, 'utf8')));
    return renderInstall(context, 'updated', 'AGENTS.md', json);
  }

  const claudePath = resolvePath(projectDir, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    const content = readFileSync(claudePath, 'utf8');
    if (!content.includes('@AGENTS.md')) {
      writeFileSync(claudePath, appendStub(content));
      return renderInstall(context, 'updated', 'CLAUDE.md', json);
    }
  }

  writeFileSync(agentsPath, `${BOOTSTRAP_STUB}\n`);
  return renderInstall(context, 'created', 'AGENTS.md', json);
}

// Replace the whole marked region with the current stub; a begin without a
// well-ordered end means someone mangled the block, so refuse rather than guess.
function rewriteStub(content: string, name: string): string | Error {
  const begin = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  if (end === -1 || end < begin) {
    return new Error(`${name} has a malformed dor-skill block`);
  }
  return content.slice(0, begin) + BOOTSTRAP_STUB + content.slice(end + END_MARKER.length);
}

function appendStub(content: string): string {
  if (content.trim() === '') return `${BOOTSTRAP_STUB}\n`;
  return `${content.trimEnd()}\n\n${BOOTSTRAP_STUB}\n`;
}

// Report the bare file name only — never the absolute path — so output stays
// machine-independent.
function renderInstall(context: DorCommandContext, status: 'created' | 'updated', file: string, json: boolean): void {
  writeStdout(context, json ? renderJson({ status, file }) : `${status} ${file}\n`);
}
