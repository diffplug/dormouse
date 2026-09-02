import { describe, expect, it } from 'vitest';
import { readPersistedSession } from './session-types';

/**
 * The recovery command is host-owned and single-use, so it travels on the boot
 * payload (`PlatformAdapter.getRecoveryCommands`) rather than inside the persisted
 * session. These tests pin the half of that contract `session-types` owns: a
 * parsed Session never carries one, whatever the blob on disk says.
 *
 * The consuming half — that a captured command reaches `restoreTerminal` and that
 * a pane without one gets `null` — lives in `session-restore.test.ts`.
 */
describe('recovery commands never enter the persisted session', () => {
  const blob = (pane: Record<string, unknown>) => ({
    version: 3 as const,
    panes: [{ id: 'pane-a', cwd: null, title: 'A', untouched: false, ...pane }],
  });

  it('strips a resumeCommand written by a pre-upgrade build', () => {
    // The regression this guards: while the field lived on PersistedPane, a
    // periodic save carried it forward indefinitely, so a stale invocation could
    // outlive the destructive read of the recovery record and be re-run on a
    // later restore.
    const parsed = readPersistedSession(blob({ resumeCommand: 'claude --resume abc' }))!;

    expect('resumeCommand' in parsed.panes[0]).toBe(false);
  });

  it('still reads a legacy blob that carries one, rather than rejecting it', () => {
    const parsed = readPersistedSession(blob({ resumeCommand: 'codex resume 01JC', cwd: '/repo' }))!;

    expect(parsed.panes[0]).toMatchObject({ id: 'pane-a', cwd: '/repo' });
  });

  it('strips a legacy transcript for the same reason', () => {
    const parsed = readPersistedSession(blob({ scrollback: 'secret output\n' }))!;

    expect('scrollback' in parsed.panes[0]).toBe(false);
  });

  it('reads a JSON-stringified blob, which is how VS Code hands state back', () => {
    const parsed = readPersistedSession(JSON.stringify(blob({ resumeCommand: 'claude --continue' })))!;

    expect('resumeCommand' in parsed.panes[0]).toBe(false);
    expect(parsed.panes[0].id).toBe('pane-a');
  });
});
