/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, setDefaultThemeId } from './apply';
import { captureThemeDiagnostics } from './diagnostics';
import type { DormouseTheme } from './types';
import { installLocalStorageStub } from '../test-local-storage';

const SELECTION = '--vscode-list-activeSelectionBackground';

const ALPHA_SELECTION_THEME: DormouseTheme = {
  id: 'test.alpha-selection',
  label: 'Alpha Selection',
  type: 'dark',
  swatch: '#103c48',
  accent: '#0096f5',
  vars: {
    '--vscode-sideBar-background': '#000000',
    [SELECTION]: '#ffffff80',
  },
  origin: { kind: 'installed', extensionId: 'test/alpha-selection', installedAt: '2026-11-09T00:00:00.000Z' },
};

describe('captureThemeDiagnostics', () => {
  beforeEach(() => {
    installLocalStorageStub();
    setDefaultThemeId(null);
    document.body.removeAttribute('class');
    document.body.removeAttribute('style');
  });

  it('traces the selection background the page paints, flattened', () => {
    applyTheme(ALPHA_SELECTION_THEME);
    const painted = document.body.style.getPropertyValue(SELECTION).trim();
    expect(painted).not.toBe('#ffffff80');

    const trace = captureThemeDiagnostics().resolverTraces.find((item) => item.name === SELECTION);
    expect(trace?.resolvedValue).toBe(painted);
  });
});
