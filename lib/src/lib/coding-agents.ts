/** Built-in CLI integrations. See docs/compatible-agents.md for adding one.
 * Keep this module platform-independent, import-free, and erasable TypeScript:
 * the documentation tests also read it directly with Node's type stripping. */
export interface CodingAgent {
  name: string;
  commands: readonly string[];
  /** A positional subcommand (codex) or long option; the ID is always required. */
  resume: string;
  /** The shape of the conversation ID the agent prints. `uuid` rejects any other
   *  token after the resume invocation (Codex 0.160 also prints `codex resume and
   *  select <thread>`; Copilot hard-wraps its id below ~74 columns). Omitted, any
   *  opaque id is accepted. */
  id?: 'uuid';
  watchByDefault: boolean;
}

export const CODING_AGENTS: readonly CodingAgent[] = [
  { name: 'Claude Code', commands: ['claude'], resume: '--resume', id: 'uuid', watchByDefault: true },
  { name: 'Codex', commands: ['codex'], resume: 'resume', id: 'uuid', watchByDefault: true },
  { name: 'Pi', commands: ['pi'], resume: '--session', id: 'uuid', watchByDefault: false },
  { name: 'GitHub Copilot', commands: ['copilot'], resume: '--resume', id: 'uuid', watchByDefault: true },
  { name: 'Antigravity', commands: ['agy'], resume: '--conversation', id: 'uuid', watchByDefault: true },
  { name: 'Warp', commands: ['warp'], resume: '--resume', id: 'uuid', watchByDefault: true },
  { name: 'Cursor', commands: ['agent', 'cursor-agent'], resume: '--resume', id: 'uuid', watchByDefault: true },
];

export const DEFAULT_WATCHED_COMMANDS: readonly string[] = CODING_AGENTS
  .filter((agent) => agent.watchByDefault)
  .flatMap((agent) => agent.commands)
  .sort();
