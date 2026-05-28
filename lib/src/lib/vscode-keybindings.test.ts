/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { vscodeWorkbenchCommandForKeydown } from './vscode-keybindings';

function keydown(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe('vscodeWorkbenchCommandForKeydown', () => {
  it('maps Windows/Linux VS Code workbench chords', () => {
    const opts = { isMac: false };

    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'p', code: 'KeyP', ctrlKey: true }), opts)).toBe('workbench.action.quickOpen');
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), opts)).toBe('workbench.action.showCommands');
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'b', code: 'KeyB', ctrlKey: true }), opts)).toBe('workbench.action.toggleSidebarVisibility');
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'F1', code: 'F1' }), opts)).toBe('workbench.action.showCommands');
  });

  it('uses Cmd as the platform modifier on macOS', () => {
    const opts = { isMac: true };

    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'p', code: 'KeyP', metaKey: true }), opts)).toBe('workbench.action.quickOpen');
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }), opts)).toBe('workbench.action.showCommands');
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'b', code: 'KeyB', metaKey: true }), opts)).toBe('workbench.action.toggleSidebarVisibility');
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'p', code: 'KeyP', ctrlKey: true }), opts)).toBe(null);
  });

  it('keeps unrelated terminal control chords in xterm only', () => {
    const opts = { isMac: false };

    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'r', code: 'KeyR', ctrlKey: true }), opts)).toBe(null);
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'c', code: 'KeyC', ctrlKey: true }), opts)).toBe(null);
    expect(vscodeWorkbenchCommandForKeydown(keydown({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true }), opts)).toBe(null);
  });

  it('only maps keydown events', () => {
    const event = new KeyboardEvent('keyup', { key: 'p', code: 'KeyP', ctrlKey: true });
    expect(vscodeWorkbenchCommandForKeydown(event, { isMac: false })).toBe(null);
  });
});
