import { describe, expect, it } from 'vitest';
import { CODING_AGENTS, DEFAULT_WATCHED_COMMANDS } from './coding-agents';
import { AGENT_EXIT_FIXTURES } from './__fixtures__/coding-agents';
import { detectResumeCommand, normalizeResumeCommand } from './resume-patterns';
import { commandWatchKey, isWatchKey } from './terminal-state';

describe('coding agent integrations', () => {
  it('has unique executable names and valid default watch keys', () => {
    const commands = CODING_AGENTS.flatMap((agent) => agent.commands);
    expect(new Set(commands).size).toBe(commands.length);
    for (const command of commands) {
      expect(command).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(commandWatchKey(`${command} --help`)).toBe(command);
    }
    for (const command of DEFAULT_WATCHED_COMMANDS) expect(isWatchKey(command)).toBe(true);
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

  for (const agent of CODING_AGENTS) {
    for (const command of agent.commands) {
      const label = `${command} ${agent.resume}`;
      const id = '12345678-abcd-4123-8123-123456789abc';
      it(`normalizes the supported separators for ${command}`, () => {
        for (const separator of agent.resume.startsWith('--') ? [' ', '='] : [' ']) {
          const invocation = `${label}${separator}${id}`;
          expect(detectResumeCommand(`Resume with \`${invocation}\`.\r\n`)).toBe(`${label} ${id}`);
          expect(normalizeResumeCommand(invocation)).toBe(`${label} ${id}`);
        }
        expect(detectResumeCommand(`${label} \x1b[1m${id}\x1b[0m`)).toBe(`${label} ${id}`);
      });

      it(`rejects incomplete or extended executable commands for ${command}`, () => {
        for (const invocation of [label, `${label}=`, `${label} -bad`, `${label} $(whoami)`,
          `${label} ${id}; echo bad`, `${label} ${id} --extra`, `prefix-${label} ${id}`]) {
          expect(normalizeResumeCommand(invocation), invocation).toBeNull();
        }
        expect(detectResumeCommand(`prefix-${label} ${id}`)).toBeNull();
        expect(detectResumeCommand(`/tmp/${label} ${id}`)).toBeNull();
      });
    }
  }

  it('keeps Cursor executable aliases distinct and chooses the newest hint', () => {
    expect(detectResumeCommand('cursor-agent --resume=older\ragent --resume=newer'))
      .toBe('agent --resume newer');
    expect(detectResumeCommand('agent --resume=older\rcursor-agent --resume=newer'))
      .toBe('cursor-agent --resume newer');
  });
});
