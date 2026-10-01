import { describe, expect, it } from 'vitest';
import { CODING_AGENTS } from './coding-agents';
import { AGENT_EXIT_FIXTURES } from './__fixtures__/coding-agents';
import { detectResumeCommand, normalizeResumeCommand } from './resume-patterns';
import { commandWatchKey } from './terminal-state';

const RESUME_FORMS = CODING_AGENTS.flatMap((agent) => agent.commands.map((command) => ({
  label: `${command} ${agent.resume}`,
  separators: agent.resume.startsWith('--') ? [' ', '='] : [' '],
})));
const ID = '12345678-abcd-4123-8123-123456789abc';

describe('coding agent integrations', () => {
  it('has unique executable names that are their own watch keys', () => {
    const commands = CODING_AGENTS.flatMap((agent) => agent.commands);
    expect(new Set(commands).size).toBe(commands.length);
    for (const command of commands) {
      expect(command).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(commandWatchKey(`${command} --help`)).toBe(command);
    }
  });

  it('requires an exit fixture for every registered agent', () => {
    expect([...new Set(AGENT_EXIT_FIXTURES.map((fixture) => fixture.agent))].sort())
      .toEqual(CODING_AGENTS.map((agent) => agent.name).sort());
  });

  it.each(AGENT_EXIT_FIXTURES)('captures $agent $version on $os', ({ output, command }) => {
    expect(detectResumeCommand(output)).toBe(command);
    expect(normalizeResumeCommand(command)).toBe(command);
    expect(normalizeResumeCommand(output)).toBeNull();
  });

  it.each(RESUME_FORMS)('rebuilds `$label <id>` exactly and rejects anything more', ({ label, separators }) => {
    for (const separator of separators) {
      const invocation = `${label}${separator}${ID}`;
      expect(detectResumeCommand(`${invocation}\n`)).toBe(`${label} ${ID}`);
      expect(normalizeResumeCommand(invocation)).toBe(`${label} ${ID}`);
    }
    for (const invocation of [label, `${label}=`, `${label} -bad`, `${label} $(whoami)`,
      `${label} ${ID}; echo bad`, `${label} ${ID} --extra`, `prefix-${label} ${ID}`]) {
      expect(normalizeResumeCommand(invocation), invocation).toBeNull();
    }
    expect(detectResumeCommand(`prefix-${label} ${ID}`)).toBeNull();
    expect(detectResumeCommand(`/tmp/${label} ${ID}`)).toBeNull();
  });

  it('keeps Cursor executable aliases distinct and chooses the newest hint', () => {
    expect(detectResumeCommand('cursor-agent --resume=older\ragent --resume=newer\n'))
      .toBe('agent --resume newer');
    expect(detectResumeCommand('agent --resume=older\rcursor-agent --resume=newer\n'))
      .toBe('cursor-agent --resume newer');
  });
});
