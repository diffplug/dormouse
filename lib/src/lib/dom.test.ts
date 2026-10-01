/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { anchoredTarget, isComposingKey, isEditableTarget, setPortalAnchor } from './dom';

describe('isEditableTarget', () => {
  it('is true for input, textarea, and contentEditable elements', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    const editable = document.createElement('div');
    // jsdom doesn't compute isContentEditable from the attribute, so set it.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isEditableTarget(editable)).toBe(true);
  });

  it('is false for non-text elements and null', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(document.createElement('select'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('counts the xterm helper textarea — callers exclude it themselves', () => {
    const helper = document.createElement('textarea');
    helper.classList.add('xterm-helper-textarea');
    expect(isEditableTarget(helper)).toBe(true);
  });
});

describe('isComposingKey', () => {
  it('counts WebKit\'s composition-ending key, which reports keyCode 229 without isComposing', () => {
    const ending = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(ending, 'keyCode', { value: 229 });
    expect(isComposingKey(ending)).toBe(true);
    expect(isComposingKey(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }))).toBe(true);
    expect(isComposingKey(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false);
  });
});

describe('anchoredTarget', () => {
  it('stands a mapped portal root\'s anchor in for every target inside it, until unmapped', () => {
    const anchor = document.createElement('span');
    const root = document.createElement('div');
    const button = document.createElement('button');
    root.append(button);
    document.body.append(anchor, root);
    expect(anchoredTarget(button)).toBe(button);
    const unmap = setPortalAnchor(root, anchor);
    expect(root.hasAttribute('data-portal-anchored')).toBe(true);
    expect(anchoredTarget(button)).toBe(anchor);
    expect(anchoredTarget(root)).toBe(anchor);
    unmap();
    expect(root.hasAttribute('data-portal-anchored')).toBe(false);
    expect(anchoredTarget(button)).toBe(button);
    root.remove();
    anchor.remove();
  });

  it('passes other elements through, and no element as null', () => {
    const plain = document.createElement('div');
    expect(anchoredTarget(plain)).toBe(plain);
    expect(anchoredTarget(window)).toBeNull();
    expect(anchoredTarget(null)).toBeNull();
  });
});
