/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, themeBootPaint } from './apply';
import { setThemePaintProfile, themeBootScript, type ThemePaint } from './boot-paint';
import { getBundledThemes } from './store';

const FALLBACK: ThemePaint = { themeId: 'fallback', kind: 'dark', vars: { '--vscode-editor-background': '#1e1e1e' } };
const remember = (paint: ThemePaint) => localStorage.setItem('dormouse:theme-paint', JSON.stringify(paint));
const background = () => document.body.style.getPropertyValue('--vscode-editor-background');

/** Runs the boot tag as the parser would, first in an empty body. */
function boot(classes: string[] = []) {
  new Function(themeBootScript(FALLBACK, classes))();
}

beforeEach(() => {
  localStorage.clear();
  setThemePaintProfile(null);
  document.body.removeAttribute('style');
  document.body.className = '';
});

describe('the boot tag', () => {
  it('paints its default on a first visit, with the page classes', () => {
    boot(['docs-themed']);
    expect(background()).toBe('#1e1e1e');
    expect([...document.body.classList]).toEqual(['vscode-dark', 'docs-themed']);
    expect(document.body.style.colorScheme).toBe('dark');
  });

  it('paints the remembered paint of the picked theme instead', () => {
    localStorage.setItem('dormouse:active-theme', 'light-one');
    remember({ themeId: 'light-one', kind: 'light', vars: { '--vscode-editor-background': '#ffffff' } });
    boot();
    expect(background()).toBe('#ffffff');
    expect(document.body.classList.contains('vscode-light')).toBe(true);
  });

  it('ignores a remembered paint of a theme no longer picked', () => {
    localStorage.setItem('dormouse:active-theme', 'picked-elsewhere');
    remember({ themeId: 'light-one', kind: 'light', vars: { '--vscode-editor-background': '#ffffff' } });
    boot();
    expect(background()).toBe('#1e1e1e');
  });

  it('ignores a remembered paint that is not only custom properties', () => {
    remember({ themeId: 'x', kind: 'light', vars: { background: 'url(https://example.com/x)' } });
    boot();
    expect(document.body.style.background).toBe('');
    expect(background()).toBe('#1e1e1e');
  });
});

describe('painting through a profile', () => {
  const light = getBundledThemes().find(({ type }) => type === 'light')!;
  const profile = { derive: () => ({ '--page-token': 'derived' }) };

  it('paints and remembers what the profile derives with the theme', () => {
    setThemePaintProfile(profile);
    applyTheme(light);
    const remembered = JSON.parse(localStorage.getItem('dormouse:theme-paint')!) as ThemePaint;
    expect(remembered).toEqual(themeBootPaint({ ...profile, defaultThemeId: light.id }));
    expect(document.body.style.getPropertyValue('--page-token')).toBe('derived');
  });

  it('remembers nothing without a profile', () => {
    applyTheme(getBundledThemes().find(({ id }) => id !== light.id)!);
    expect(localStorage.getItem('dormouse:theme-paint')).toBeNull();
  });
});
