// @vitest-environment jsdom
import { createElement, act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTeardownModalHost, WorkspaceTeardownModal } from "./WorkspaceTeardownModal";

import { openQuitConfirm, openQuitArchiveFailure, confirmQuit, getQuitConfirmChar, getQuitConfirmPhase, _resetQuitConfirmForTesting } from './quit-confirm-store';
import { createWorkspace, resetWorkspaces } from 'dormouse-lib/lib/workspace-store';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from 'dormouse-lib/lib/terminal-registry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Teardowns for every root still mounted; the afterEach runs what a test left. */
const mounted = new Set<() => void>();

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  _resetQuitConfirmForTesting();
  resetWorkspaces();
});

/**
 * Render `element` into `container` (a fresh div by default) attached to the
 * document, and return its idempotent teardown. No JSX: the standalone suite has
 * no React transform, and this needs none.
 */
function mount(element: ReactElement, container: HTMLElement = document.createElement("div")): () => void {
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => { root.unmount(); });
    container.remove();
  };
  mounted.add(unmount);
  return unmount;
}

/**
 * The dialog's copy, at the one place it depends on something other than the
 * running count (`docs/specs/standalone.md` → "Quit flow", Confirmation
 * dialog).
 */
function render(props: Parameters<typeof WorkspaceTeardownModal>[0]): string {
  const unmount = mount(createElement(WorkspaceTeardownModal, props));
  const text = document.body.textContent ?? "";
  unmount();
  return text;
}

describe("WorkspaceTeardownModal copy", () => {
  it("warns that closing discards the update this window is holding", () => {
    const text = render({
      confirming: false,
      intent: { kind: "close-window", discardsUpdate: true },
    });
    expect(text).toContain("Confirm kill workspace");
    expect(text).toContain("The downloaded update will be discarded.");
  });

  it("says on every quit that agent sessions come back, and never on a window close", () => {
    expect(render({ confirming: false, intent: { kind: "quit" } }))
      .toContain("Supported agent sessions resume when Dormouse reopens.");
    expect(render({ confirming: false, intent: { kind: "quit", requester: "pane-1" } }))
      .toContain("Supported agent sessions resume when Dormouse reopens.");
    expect(render({ confirming: false, intent: { kind: "close-window" } }))
      .not.toContain("resume");
    expect(render({ confirming: true, intent: { kind: "quit", requester: "pane-1" } }))
      .toContain("Waiting for all windows, then closing…");
  });

  it("does not count the restart's requester as running work", () => {
    for (const id of ["requester", "other"]) {
      applyTerminalSemanticEvents(id, [{ type: "commandStart", source: "osc633_boundaries" }]);
    }
    try {
      expect(render({ confirming: false, intent: { kind: "quit", requester: "requester" } }))
        .toContain("1 running command will be stopped.");
      expect(render({ confirming: false, intent: { kind: "quit" } }))
        .toContain("2 running commands will be stopped.");
    } finally {
      removeTerminalPaneState("requester");
      removeTerminalPaneState("other");
    }
  });

  it("says nothing about an update otherwise", () => {
    expect(render({ confirming: false, intent: { kind: "close-window" } }))
      .not.toContain("downloaded update");
    // A quit installs it rather than discarding it, so the line never applies.
    expect(render({ confirming: false, intent: { kind: "quit" } }))
      .not.toContain("downloaded update");
  });
});

describe('WorkspaceTeardownModal host decisions', () => {
  it('retains the letter across host remount and names hidden workspaces', () => {
    createWorkspace({ id: 'hidden', name: 'Background build', activate: false });
    const ctx = { confirm: vi.fn(), cancel: vi.fn() };
    openQuitConfirm(ctx);
    const letter = getQuitConfirmChar();
    const unmountFirst = mount(createElement(WorkspaceTeardownModalHost));
    expect(document.body.textContent).toContain('Background build');
    expect(document.body.textContent).toContain('Confirm kill workspace');
    expect(document.body.textContent).not.toMatch(/Quit Dormouse|Close this window/);
    unmountFirst();
    mount(createElement(WorkspaceTeardownModalHost));
    expect(getQuitConfirmChar()).toBe(letter);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: letter, cancelable: true })); });
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(ctx.cancel).not.toHaveBeenCalled();
    expect(getQuitConfirmPhase()).toBe('quitting');
    expect(document.body.textContent).toContain('Waiting for all windows, then closing…');
  });

  it.each(['Cancel', 'Discard notes and continue'])('requires an independent archive-loss decision: %s', (choice) => {
    const kill = { confirm: vi.fn(), cancel: vi.fn() };
    const archive = { confirm: vi.fn(), cancel: vi.fn() };
    openQuitConfirm(kill);
    const letter = getQuitConfirmChar();
    confirmQuit();
    openQuitArchiveFailure('disk is full', archive);
    mount(createElement(WorkspaceTeardownModalHost));
    expect(document.body.textContent).toContain('Notes could not be archived');
    expect(document.body.textContent).toContain('disk is full');
    expect(document.body.textContent).not.toContain('Confirm kill workspace');
    expect(document.activeElement?.textContent).toBe('Cancel');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: letter, cancelable: true })); });
    expect(archive.confirm).not.toHaveBeenCalled();
    expect(archive.cancel).not.toHaveBeenCalled();
    const button = [...document.querySelectorAll('button')].find((button) => button.textContent === choice)!;
    act(() => button.click());
    expect(choice === 'Cancel' ? archive.cancel : archive.confirm).toHaveBeenCalledOnce();
    expect(kill.confirm).toHaveBeenCalledOnce();
  });

  it('blocks the entire window during confirmation and while waiting for other votes', () => {
    const ctx = { confirm: vi.fn(), cancel: vi.fn() };
    const content = document.createElement('div');
    content.dataset.workspaceContent = '';
    content.getBoundingClientRect = () => ({ x: 0, y: 30, top: 30, left: 0, bottom: 430, right: 600, width: 600, height: 400, toJSON() {} });
    openQuitConfirm(ctx);
    mount(createElement(WorkspaceTeardownModalHost), content);
    const overlay = () => document.querySelector('[role="dialog"]')!.parentElement!;
    expect(overlay().classList.contains('fixed')).toBe(true);
    expect(overlay().classList.contains('inset-0')).toBe(true);
    expect(overlay().style.top).toBe('');
    expect(overlay().style.zIndex).toBe('9999');
    act(() => confirmQuit());
    expect(overlay().classList.contains('fixed')).toBe(true);
    expect(overlay().classList.contains('inset-0')).toBe(true);
    expect(document.querySelectorAll('[role="dialog"] button')).toHaveLength(0);
    expect(document.activeElement?.getAttribute('role')).toBe('status');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); });
    expect(getQuitConfirmPhase()).toBe('quitting');
    expect(ctx.cancel).not.toHaveBeenCalled();
    expect(ctx.confirm).toHaveBeenCalledOnce();
  });
});
