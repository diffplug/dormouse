/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePaneElement } from './spatial-nav';

describe('resolvePaneElement', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('climbs to the enclosing [data-lath-leaf] (header + body)', () => {
    const leaf = document.createElement('div');
    leaf.setAttribute('data-lath-leaf', 't1');
    const body = document.createElement('div');
    leaf.appendChild(body);
    document.body.appendChild(leaf);

    expect(resolvePaneElement(body)).toBe(leaf);
  });

  it('returns the element itself when it is not inside a leaf', () => {
    const body = document.createElement('div');
    document.body.appendChild(body);
    expect(resolvePaneElement(body)).toBe(body);
  });

  it('returns null for a detached element', () => {
    const body = document.createElement('div'); // never attached → !isConnected
    expect(resolvePaneElement(body)).toBeNull();
  });

  it('returns null for null / undefined', () => {
    expect(resolvePaneElement(null)).toBeNull();
    expect(resolvePaneElement(undefined)).toBeNull();
  });
});
