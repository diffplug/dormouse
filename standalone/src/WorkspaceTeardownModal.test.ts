// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTeardownModalHost, WorkspaceTeardownModal } from "./WorkspaceTeardownModal";

import { openQuitConfirm, openQuitArchiveFailure, confirmQuit, getQuitConfirmChar, getQuitConfirmPhase, _resetQuitConfirmForTesting } from './quit-confirm-store';
import { createWorkspace, resetWorkspaces } from 'dormouse-lib/lib/workspace-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { _resetQuitConfirmForTesting(); resetWorkspaces(); });

/**
 * The dialog's copy, at the one place it depends on something other than the
 * running count (`docs/specs/standalone.md` → "Quit flow", Confirmation
 * dialog). No JSX: the standalone suite has no React transform, and this needs
 * none.
 */
function render(props: Parameters<typeof WorkspaceTeardownModal>[0]): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(WorkspaceTeardownModal, props)); });
  const text = document.body.textContent ?? "";
  act(() => { root.unmount(); });
  host.remove();
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
    const host = document.createElement('div');
    document.body.append(host);
    let root = createRoot(host);
    try {
      act(() => root.render(createElement(WorkspaceTeardownModalHost)));
      expect(document.body.textContent).toContain('Background build');
      expect(document.body.textContent).toContain('Confirm kill workspace');
      expect(document.body.textContent).not.toMatch(/Quit Dormouse|Close this window/);
      act(() => root.unmount());
      root = createRoot(host);
      act(() => root.render(createElement(WorkspaceTeardownModalHost)));
      expect(getQuitConfirmChar()).toBe(letter);
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: letter, cancelable: true })); });
      expect(ctx.confirm).toHaveBeenCalledOnce();
      expect(ctx.cancel).not.toHaveBeenCalled();
      expect(getQuitConfirmPhase()).toBe('quitting');
      expect(document.body.textContent).toContain('Waiting for all windows, then closing…');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each(['Cancel', 'Discard notes and continue'])('requires an independent archive-loss decision: %s', (choice) => {
    const kill = { confirm: vi.fn(), cancel: vi.fn() };
    const archive = { confirm: vi.fn(), cancel: vi.fn() };
    openQuitConfirm(kill);
    const letter = getQuitConfirmChar();
    confirmQuit();
    openQuitArchiveFailure('disk is full', archive);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(WorkspaceTeardownModalHost)));
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
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});


it('blocks the entire window during confirmation and while waiting for other votes', () => {
  const ctx = { confirm: vi.fn(), cancel: vi.fn() };
  const content = document.createElement('div');
  content.dataset.workspaceContent = '';
  content.getBoundingClientRect = () => ({ x: 0, y: 30, top: 30, left: 0, bottom: 430, right: 600, width: 600, height: 400, toJSON() {} });
  document.body.append(content);
  const root = createRoot(content);
  try {
    openQuitConfirm(ctx);
    act(() => root.render(createElement(WorkspaceTeardownModalHost)));
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
  } finally {
    act(() => root.unmount());
    content.remove();
  }
});
