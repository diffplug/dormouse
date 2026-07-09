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

// The stub stays near fact-free — the real, always-current instructions live in
// `dor skill` — but a purely-pointer stub proved too soft: agents skipped it and
// fell back to native subprocesses and browser tools. So it carries exactly two
// load-bearing directives (use `dor ensure`, use `dor ab`), stated loudly, because
// those two behaviors must be redirected *before* an agent would think to run
// `dor skill`. Both are foundational command names, the least likely `dor` facts
// to ever drift.
const BOOTSTRAP_STUB = `<!-- dor-skill:begin — managed by \`dor skill --install\`; edits inside are overwritten -->
## Running inside Dormouse

If the \`DORMOUSE_SURFACE_ID\` environment variable is set, this terminal is
hosted by [Dormouse](https://dormouse.sh) and the \`dor\` CLI is on your \`PATH\`.
**Run \`dor skill\` first and do what it says** — it teaches you to use the
terminal fully (visible panes, browser surfaces, sub-agents). Two rules are
mandatory whether or not you have read it:

- **NEVER start a long-running process — a dev server, a \`--watch\`, any daemon
  — as a background subprocess.** It would be invisible to the user and die with
  your shell. ALWAYS run it with \`dor ensure -- <command>\` (e.g.
  \`dor ensure -- npm run dev\`), which puts it in a visible pane that outlives
  you and is reused instead of duplicated on re-runs.
- **NEVER use a built-in, native, or bundled browser tool to open, view, or
  drive a web page.** ALWAYS use \`dor ab\` (agent-browser) — \`dor ab open
  <url>\`, \`dor ab click @e3\`, and so on — so the page renders in a Dormouse
  pane the user can watch.

If \`DORMOUSE_SURFACE_ID\` is not set, ignore this section — \`dor\` is not here.
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

--install instead writes a marker-delimited bootstrap stub into the project's agent instructions file. The stub is the detection rule — if DORMOUSE_SURFACE_ID is set, run \`dor skill\` and follow it — plus two loud, mandatory directives (use \`dor ensure\` for long-running processes, \`dor ab\` for browsers) that must land before an agent would think to run \`dor skill\`. It stays otherwise fact-free, so a committed stub does not go stale.

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

  // Read both instruction files once up front; the adopt pass and the append
  // pass below share the contents. `content: null` means the file is absent.
  const candidates = CANDIDATES.map((name) => {
    const path = resolvePath(projectDir, name);
    return { name, path, content: existsSync(path) ? readFileSync(path, 'utf8') : null };
  });

  // First adopt an existing block wherever it already lives, rewriting it in
  // place so hand edits outside the markers survive.
  for (const { name, path, content } of candidates) {
    if (content === null || !content.includes(BEGIN_MARKER)) continue;
    const rewritten = rewriteStub(content, name);
    if (rewritten instanceof Error) return rewritten;
    writeFileSync(path, rewritten);
    return renderInstall(context, 'updated', name, json);
  }

  // No block yet: append to AGENTS.md when it exists, else CLAUDE.md unless it
  // already imports AGENTS.md, else create AGENTS.md.
  const [agents, claude] = candidates;
  const target =
    agents.content === null && claude.content !== null && !claude.content.includes('@AGENTS.md')
      ? claude
      : agents;
  writeFileSync(target.path, appendStub(target.content ?? ''));
  return renderInstall(context, target.content === null ? 'created' : 'updated', target.name, json);
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
