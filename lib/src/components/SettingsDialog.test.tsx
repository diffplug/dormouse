/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { __resetArchiveServiceForTests } from '../lib/notepad/archive-service';
import { clearAllNotepads } from '../lib/notepad/notepad-store';
import { SettingsDialog } from './SettingsDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;

function text(): string {
  return container.textContent ?? '';
}

function byText(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === label,
  );
  if (!found) throw new Error(`no button reading ${label}`);
  return found;
}

async function render() {
  await act(async () => root.render(<SettingsDialog onClose={() => {}} />));
  await act(async () => {});
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  __resetArchiveServiceForTests();
  clearAllNotepads();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetArchiveServiceForTests();
  clearAllNotepads();
});

describe('SettingsDialog notepad archive entry', () => {
  it('opens the Archive view in place and comes back', async () => {
    await render();
    expect(text()).toContain('Notepad archive');

    await act(async () => byText('Open archive').click());
    // Same dialog, different view: the archive's own chrome is what proves it.
    expect(byText('Back to Settings')).toBeTruthy();
    expect(text()).toContain('Nothing archived yet');

    await act(async () => byText('Back to Settings').click());
    expect(byText('Open archive')).toBeTruthy();
  });

  it('offers no entry on a host with no archive port', async () => {
    // Pocket's shape: the adapter simply has no `notepadArchive` at all.
    Reflect.deleteProperty(platform, 'notepadArchive');

    await render();

    expect(text()).not.toContain('Notepad archive');
  });
});
