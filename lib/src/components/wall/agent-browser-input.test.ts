import { describe, expect, it } from 'vitest';
import { modifiers, virtualKeyCode } from './agent-browser-input';

describe('virtualKeyCode', () => {
  it('maps printable OEM keys to their real VK, not the char code', () => {
    // The footgun: '.'.charCodeAt(0) === 46 === VK_DELETE. The physical-key
    // table must win so a period types a period.
    expect(virtualKeyCode('.', 'Period')).toBe(190);
    expect(virtualKeyCode('.', 'Period')).not.toBe(46);
    expect(virtualKeyCode(',', 'Comma')).toBe(188);
    expect(virtualKeyCode('/', 'Slash')).toBe(191);
    expect(virtualKeyCode(' ', 'Space')).toBe(32);
  });

  it('maps letters and digits structurally from the physical code', () => {
    expect(virtualKeyCode('a', 'KeyA')).toBe(65); // VK_A
    expect(virtualKeyCode('A', 'KeyA')).toBe(65); // shifted shares the code
    expect(virtualKeyCode('z', 'KeyZ')).toBe(90);
    expect(virtualKeyCode('1', 'Digit1')).toBe(49); // VK_1
    expect(virtualKeyCode('1', 'Numpad1')).toBe(97); // VK_NUMPAD1
  });

  it('maps function and special keys', () => {
    expect(virtualKeyCode('F1', 'F1')).toBe(112);
    expect(virtualKeyCode('F12', 'F12')).toBe(123);
    expect(virtualKeyCode('Enter', 'Enter')).toBe(13);
    expect(virtualKeyCode('ArrowLeft', 'ArrowLeft')).toBe(37);
    expect(virtualKeyCode('Escape', 'Escape')).toBe(27);
  });

  it('falls back to 0 for unknown keys', () => {
    expect(virtualKeyCode('Unidentified', 'Unidentified')).toBe(0);
  });
});

describe('modifiers', () => {
  it('packs alt/ctrl/meta/shift into the CDP bitmask', () => {
    expect(modifiers({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
    expect(modifiers({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(1);
    expect(modifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBe(2);
    expect(modifiers({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: false })).toBe(4);
    expect(modifiers({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: true })).toBe(8);
    expect(modifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});
