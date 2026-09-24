/** Built-in CLI integrations. See docs/compatible-agents.md for adding one.
 * Keep this module platform-independent, import-free, and erasable TypeScript:
 * the documentation tests also read it directly with Node's type stripping. */
export interface CodingAgent {
  name: string;
  commands: readonly string[];
  /** A positional subcommand (codex) or long option; the ID is always required. */
  resume: string;
  watchByDefault: boolean;
}

export const CODING_AGENTS: readonly CodingAgent[] = [
  { name: 'Claude Code', commands: ['claude'], resume: '--resume', watchByDefault: true },
  { name: 'Codex', commands: ['codex'], resume: 'resume', watchByDefault: true },
  { name: 'GitHub Copilot', commands: ['copilot'], resume: '--resume', watchByDefault: true },
  { name: 'Antigravity', commands: ['agy'], resume: '--conversation', watchByDefault: true },
  { name: 'Warp', commands: ['warp'], resume: '--resume', watchByDefault: true },
  { name: 'Cursor', commands: ['agent', 'cursor-agent'], resume: '--resume', watchByDefault: true },
];

export const DEFAULT_WATCHED_COMMANDS: readonly string[] = CODING_AGENTS
  .filter((agent) => agent.watchByDefault)
  .flatMap((agent) => agent.commands)
  .sort();
