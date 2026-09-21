/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Door } from './Door';

/** Exact class tokens: `animate-alarm-pulse` is a prefix of the burst class. */
function classes(el: Element | null | undefined): string[] {
  return el?.className.split(/\s+/).filter(Boolean) ?? [];
}

const EPISODE = { id: 'episode-1', startedAt: Date.now() };

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

describe('Door alarm state', () => {
  it('rings with a static inset ring and no label until the speech sink acts', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" todo episode={EPISODE} />,
    ));

    const door = container.querySelector<HTMLElement>('[data-alert-ring-state="ringing"]');
    expect(door?.className).not.toContain('bg-alarm-vs-door');
    expect(door?.textContent).not.toContain('SPEAKING');
    expect(door?.getAttribute('aria-label')).toBe('build-server, needs attention');
    // The ring is the treatment, so it carries the bounded arrival burst.
    const ring = door?.querySelector<HTMLElement>('[data-alert-ring-inset="door"]');
    expect(classes(ring)).toContain('motion-safe:animate-alarm-pulse-burst');
  });

  /** The burst rides a keyed element, so a second summons on a Door that never
   *  unmounted has to replace it rather than let an expired animation stand. */
  it('remounts the inset for a fresh episode', () => {
    const render = (episode: { id: string; startedAt: number }) => act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" episode={episode} />,
    ));

    render(EPISODE);
    const first = container.querySelector('[data-alert-ring-inset="door"]');
    render(EPISODE);
    expect(container.querySelector('[data-alert-ring-inset="door"]')).toBe(first);

    render({ id: 'episode-2', startedAt: Date.now() });
    expect(container.querySelector('[data-alert-ring-inset="door"]')).not.toBe(first);
  });

  /** A Door that is not ringing has no alarm state, whatever the renderer last
   *  said about speech. */
  it('shows no alarm edge for a quiet Session', () => {
    act(() => root.render(
      <Door title="build-server" speechState="spoken" episode={null} />,
    ));

    expect(container.querySelector('[data-alert-ring-state]')).toBeNull();
    expect(container.querySelector('[data-alert-ring-inset]')).toBeNull();
  });

  it('inverts and animates the whole Door while its Session is speaking', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" todo speechState="speaking"
        episode={EPISODE} />,
    ));

    const door = container.querySelector<HTMLElement>('[data-alert-ring-state="speaking"]');
    expect(door?.className).toContain('bg-alarm-vs-door');
    expect(classes(door)).toContain('motion-safe:animate-alarm-pulse');
    expect(container.querySelector('[data-alert-ring-inset]')).toBeNull();
    expect(door?.textContent).toContain('SPEAKING');
    expect(door?.textContent).not.toContain('TODO');
    expect(door?.getAttribute('aria-label')).toBe('build-server, speaking');
  });

  it('marks SPOKEN with a static inset ring rather than motion', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" speechState="spoken"
        episode={EPISODE} />,
    ));

    const door = container.querySelector<HTMLElement>('[data-alert-ring-state="spoken"]');
    const ring = door?.querySelector<HTMLElement>('[data-alert-ring-inset="door"]');
    expect(ring).not.toBeNull();
    expect(classes(ring).some(c => c.includes('animate-'))).toBe(false);
    expect(door?.getAttribute('aria-label')).toBe('build-server, spoken');
  });

  /**
   * `spoken` is cleared only when the ring resolves, so a user who never attends
   * leaves it set indefinitely. It may not evict the speaker glyph and TODO pill
   * for that whole window — those are the baseboard's persistent status signals,
   * and a Door showing neither is indistinguishable from a quiet one.
   */
  it('keeps the speaker glyph and TODO pill visible while SPOKEN persists', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" todo speechState="spoken"
        episode={EPISODE} />,
    ));

    const door = container.querySelector<HTMLElement>('[data-alert-ring-state="spoken"]');
    expect(door?.querySelector('.todo-pill-shell')).not.toBeNull();
    // The speaker glyph alongside the pill, and no other icon with it.
    expect(door?.querySelectorAll('svg').length).toBe(1);
  });
});

describe('Door notepad button', () => {
  function renderDoor(props: Partial<Parameters<typeof Door>[0]> = {}) {
    const onClick = vi.fn();
    const onOpenNotepad = vi.fn();
    act(() => root.render(
      <Door
        doorId="pane-a"
        title="build-server"
        episode={null}
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


describe('Door unsaved changes', () => {
  it.each(['speaking', 'spoken'] as const)('keeps the dirty dot beside notes and %s state', speechState => {
    act(() => root.render(<Door doorId="dirty" title="Editor" toolDirty
      speechState={speechState} noteCount={2} todo status="ALERT_RINGING" episode={EPISODE} />));
    const door = container.querySelector('[data-door-id="dirty"]')!;
    expect(door.querySelector('[role="img"][aria-label="Unsaved changes"]')).not.toBeNull();
    expect(door.querySelector('[data-door-notepad-for="dirty"]')).not.toBeNull();
    expect(door.getAttribute('aria-label')).toBe(`Editor, ${speechState}, Unsaved changes`);
  });
});
