/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Door } from './Door';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { setPlatform } from '../lib/platform';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Door spoken-alarm state', () => {
  it('inverts and animates the whole Door while its Session is speaking', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" ringSeq={1} todo speechState="speaking" />,
    ));

    const door = container.querySelector<HTMLButtonElement>('[data-alert-speech-state="speaking"]');
    expect(door?.className).toContain('bg-alarm-vs-door');
    expect(door?.className).toContain('animate-speech-alarm-pulse');
    expect(door?.textContent).toContain('SPEAKING');
    expect(door?.textContent).not.toContain('TODO');
    expect(door?.getAttribute('aria-label')).toBe('build-server, speaking');
  });

  it('marks SPOKEN with a static inset ring rather than motion', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" ringSeq={1} speechState="spoken" />,
    ));

    const door = container.querySelector<HTMLButtonElement>('[data-alert-speech-state="spoken"]');
    expect(door?.className).toContain('inset_0_0_0_2px');
    expect(door?.className).not.toContain('animate-speech-alarm-pulse');
    expect(door?.getAttribute('aria-label')).toBe('build-server, spoken');
  });

  /**
   * `spoken` is cleared only when the ring resolves, so a user who never attends
   * leaves it set indefinitely. It may not evict the bell and TODO pill for that
   * whole window — those are the baseboard's persistent status signals, and a
   * Door showing neither is indistinguishable from a quiet one.
   */
  it('keeps the bell and TODO pill visible while SPOKEN persists', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" ringSeq={1} todo speechState="spoken" />,
    ));

    const door = container.querySelector<HTMLButtonElement>('[data-alert-speech-state="spoken"]');
    expect(door?.querySelector('.todo-pill-shell')).not.toBeNull();
    // Speaker icon + bell icon, both alongside the pill.
    expect(door?.querySelectorAll('svg').length).toBe(2);
  });
});

describe('Door notepad button', () => {
  beforeEach(() => {
    setPlatform(new FakePtyAdapter());
  });

  function renderDoor(props: Partial<Parameters<typeof Door>[0]> = {}) {
    const onClick = vi.fn();
    const onOpenNotepad = vi.fn();
    act(() => root.render(
      <Door
        doorId="pane-a"
        title="build-server"
        ringSeq={0}
        onClick={onClick}
        onOpenNotepad={onOpenNotepad}
        {...props}
      />,
    ));
    return { onClick, onOpenNotepad };
  }

  it('keeps the Door identity on the wrapper the baseboard measures', () => {
    renderDoor({ noteCount: 2 });

    const door = container.querySelector<HTMLElement>('[data-door-id="pane-a"]');
    expect(door).not.toBeNull();
    // The wrapper, not either button: the fitting pass and the selection ring
    // both measure this element.
    expect(door!.tagName).toBe('DIV');
    expect(door!.querySelectorAll('button')).toHaveLength(2);
  });

  it('appears only for a Door with notes, and names the count', () => {
    renderDoor({ noteCount: 0 });
    expect(container.querySelector('[data-door-notepad-for]')).toBeNull();

    renderDoor({ noteCount: 3 });
    expect(container.querySelector('[data-door-notepad-for]')?.getAttribute('aria-label'))
      .toBe('Notepad · 3 notes');
  });

  it('opens the notepad without reattaching the Surface', () => {
    const { onClick, onOpenNotepad } = renderDoor({ noteCount: 1 });

    const notepad = container.querySelector<HTMLButtonElement>('[data-door-notepad-for="pane-a"]')!;
    act(() => { notepad.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onOpenNotepad).toHaveBeenCalledTimes(1);
    // Anchored on the whole Door, not on the button inside it.
    expect(onOpenNotepad.mock.calls[0][0]).toBe(container.querySelector('[data-door-id="pane-a"]'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('never starts a drag from the notepad button', () => {
    const onDragPress = vi.fn();
    renderDoor({ noteCount: 1, onDragPress });

    const notepad = container.querySelector<HTMLButtonElement>('[data-door-notepad-for="pane-a"]')!;
    act(() => {
      notepad.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(onDragPress).not.toHaveBeenCalled();

    const title = container.querySelector<HTMLButtonElement>('[data-door-id="pane-a"] button')!;
    act(() => {
      title.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(onDragPress).toHaveBeenCalledTimes(1);
  });
});
