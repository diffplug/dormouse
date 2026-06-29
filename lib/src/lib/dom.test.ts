/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { isEditableTarget } from './dom';

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
