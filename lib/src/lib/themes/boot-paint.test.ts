/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTheme } from './apply';
import { THEME_BOOT_SCRIPT, rememberThemePaint, themeBootAttributes, type ThemePaint } from './boot-paint';
import { getBundledThemes } from './store';

const FALLBACK: ThemePaint = { kind: 'dark', vars: { '--vscode-editor-background': '#1e1e1e' } };

/** Runs the boot tag as the parser would: a classic script, first in body. */
function boot(scope = 'docs', classes: string[] = []) {
  const tag = document.createElement('script');
  for (const [name, value] of Object.entries(themeBootAttributes(scope, FALLBACK, classes))) tag.setAttribute(name, value);
  document.body.prepend(tag);
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => tag });
  new Function(THEME_BOOT_SCRIPT)();
  return tag;
}

beforeEach(() => {
  localStorage.clear();
  document.body.removeAttribute('style');
  document.body.className = '';
  document.body.replaceChildren();
});
afterEach(() => {
  delete (document as { currentScript?: unknown }).currentScript;
});

describe('the boot tag', () => {
  it('paints the default on a first visit, with the page classes', () => {
    boot('docs', ['docs-themed']);
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#1e1e1e');
    expect([...document.body.classList]).toEqual(['vscode-dark', 'docs-themed']);
    expect(document.body.style.colorScheme).toBe('dark');
  });

  it('paints what its scope remembered instead', () => {
    localStorage.setItem('dormouse:theme-paint:docs', JSON.stringify({ kind: 'light', vars: { '--vscode-editor-background': '#ffffff' } }));
    localStorage.setItem('dormouse:theme-paint:app', JSON.stringify({ kind: 'dark', vars: { '--vscode-editor-background': '#123456' } }));
    boot('docs');
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#ffffff');
    expect(document.body.classList.contains('vscode-light')).toBe(true);
  });

  it('falls back on a remembered paint that is not only custom properties', () => {
    localStorage.setItem('dormouse:theme-paint:docs', JSON.stringify({ kind: 'light', vars: { background: 'url(https://example.com/x)' } }));
    boot('docs');
    expect(document.body.style.background).toBe('');
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#1e1e1e');
  });
});

describe('rememberThemePaint', () => {
  const theme = getBundledThemes().find((candidate) => candidate.type === 'light')!;

  it('remembers what applyTheme painted, for the tag the page carries', () => {
    boot('docs');
    applyTheme(theme);
    const remembered = JSON.parse(localStorage.getItem('dormouse:theme-paint:docs')!) as ThemePaint;
    expect(remembered.kind).toBe('light');
    expect(remembered.vars['--vscode-editor-background']).toBe(document.body.style.getPropertyValue('--vscode-editor-background'));
  });

  it('remembers nothing on a page without the tag', () => {
    rememberThemePaint();
    expect(localStorage.length).toBe(0);
  });
});
