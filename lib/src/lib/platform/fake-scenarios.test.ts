import { describe, it, expect } from 'vitest';
import {
  flattenScenario,
  makeAlertScenario,
  SCENARIO_SHELL_PROMPT,
  SCENARIO_LS_OUTPUT,
  SCENARIO_ANSI_COLORS,
  SCENARIO_LONG_RUNNING,
  SCENARIO_FAST_OUTPUT,
} from './fake-scenarios';
import type { FakeScenario } from './fake-adapter';

function validateScenario(scenario: FakeScenario) {
  expect(typeof scenario.name).toBe('string');
  expect(scenario.name.length).toBeGreaterThan(0);
  expect(Array.isArray(scenario.chunks)).toBe(true);
  expect(scenario.chunks.length).toBeGreaterThan(0);
  for (const chunk of scenario.chunks) {
    expect(typeof chunk.delay).toBe('number');
    expect(chunk.delay).toBeGreaterThanOrEqual(0);
    expect(typeof chunk.data).toBe('string');
    expect(chunk.data.length).toBeGreaterThan(0);
  }
}

describe('Fake Scenarios', () => {
  it('SCENARIO_SHELL_PROMPT has valid structure', () => {
    validateScenario(SCENARIO_SHELL_PROMPT);
    expect(SCENARIO_SHELL_PROMPT.name).toBe('shell-prompt');
    expect(SCENARIO_SHELL_PROMPT.exitCode).toBeUndefined();
  });

  it('SCENARIO_LS_OUTPUT has valid structure', () => {
    validateScenario(SCENARIO_LS_OUTPUT);
    expect(SCENARIO_LS_OUTPUT.name).toBe('ls-output');
  });

  it('SCENARIO_ANSI_COLORS has valid structure and includes color codes', () => {
    validateScenario(SCENARIO_ANSI_COLORS);
    expect(SCENARIO_ANSI_COLORS.name).toBe('ansi-colors');
    const allData = SCENARIO_ANSI_COLORS.chunks.map((c) => c.data).join('');
    expect(allData).toContain('\x1b[31m'); // red
    expect(allData).toContain('\x1b[32m'); // green
    expect(allData).toContain('\x1b[91m'); // bright red
  });

  it('SCENARIO_LONG_RUNNING has valid structure', () => {
    validateScenario(SCENARIO_LONG_RUNNING);
    expect(SCENARIO_LONG_RUNNING.name).toBe('long-running');
  });

  it('SCENARIO_FAST_OUTPUT has valid structure with substantial data', () => {
    validateScenario(SCENARIO_FAST_OUTPUT);
    expect(SCENARIO_FAST_OUTPUT.name).toBe('fast-output');
    const totalChars = SCENARIO_FAST_OUTPUT.chunks.reduce((sum, c) => sum + c.data.length, 0);
    expect(totalChars).toBeGreaterThan(500);
  });

  describe('flattenScenario', () => {
    it('concatenates all chunk data into a single delay-0 chunk', () => {
      const scenario: FakeScenario = {
        name: 'test',
        chunks: [
          { delay: 100, data: 'hello ' },
          { delay: 200, data: 'world' },
        ],
      };
      const flat = flattenScenario(scenario);
      expect(flat.name).toBe('test');
      expect(flat.chunks).toHaveLength(1);
      expect(flat.chunks[0].delay).toBe(0);
      expect(flat.chunks[0].data).toBe('hello world');
    });

    it('preserves exitCode', () => {
      const scenario: FakeScenario = {
        name: 'exit',
        chunks: [{ delay: 50, data: 'done' }],
        exitCode: 1,
      };
      const flat = flattenScenario(scenario);
      expect(flat.exitCode).toBe(1);
    });

    it('omits exitCode when original has none', () => {
      const flat = flattenScenario(SCENARIO_SHELL_PROMPT);
      expect(flat.exitCode).toBeUndefined();
    });

    it('preserves endsWithPrompt', () => {
      const flat = flattenScenario(SCENARIO_SHELL_PROMPT);
      expect(flat.endsWithPrompt).toBe(true);
    });

    it('omits endsWithPrompt when original has none', () => {
      const scenario: FakeScenario = {
        name: 'no-prompt',
        chunks: [{ delay: 50, data: 'done' }],
      };
      const flat = flattenScenario(scenario);
      expect(flat.endsWithPrompt).toBeUndefined();
    });

    it('produces valid structure from real scenarios', () => {
      const flat = flattenScenario(SCENARIO_LS_OUTPUT);
      validateScenario(flat);
      expect(flat.chunks).toHaveLength(1);
      expect(flat.chunks[0].data).toContain('ls -la');
    });
  });

  describe('makeAlertScenario', () => {
    it('converts absolute output times into relative delays', () => {
      expect(
        makeAlertScenario([
          { at: 0, data: 'prompt> ' },
          { at: 1_200, data: 'still working...' },
          { at: 2_400, data: 'done' },
        ]),
      ).toEqual({
        name: 'alert-scenario',
        chunks: [
          { delay: 0, data: 'prompt> ' },
          { delay: 1_200, data: 'still working...' },
          { delay: 1_200, data: 'done' },
        ],
        exitCode: undefined,
      });
    });

    it('preserves name and exitCode options', () => {
      expect(
        makeAlertScenario(
          [{ at: 250, data: 'done' }],
          { name: 'custom', exitCode: 7 },
        ),
      ).toEqual({
        name: 'custom',
        chunks: [{ delay: 250, data: 'done' }],
        exitCode: 7,
      });
    });

    it('rejects empty chunk lists', () => {
      expect(() => makeAlertScenario([])).toThrow('makeAlertScenario requires at least one chunk');
    });

    it('rejects chunks that go backwards in time', () => {
      expect(() =>
        makeAlertScenario([
          { at: 500, data: 'first' },
          { at: 400, data: 'second' },
        ]),
      ).toThrow('Chunk 1 is earlier than the previous chunk');
    });
  });
});
