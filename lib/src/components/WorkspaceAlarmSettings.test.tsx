// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceAlarmSettings } from './WorkspaceAlarmSettings';
import { WorkspaceIdContext } from './wall/wall-context';
import { createWorkspace, getWorkspacesSnapshot, resetWorkspaces } from '../lib/workspace-store';
import { speechQueue } from '../lib/speech-queue';
import { stubSpeechSynthesis } from '../lib/speech-synthesis-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { speechQueue.clear(); resetWorkspaces(); vi.unstubAllGlobals(); });

it('selects and tests a workspace voice, then resets to inheritance', async () => {
  const voice = { voiceURI: 'voice-1', name: 'Samantha', lang: 'en-US' };
  const engine = stubSpeechSynthesis([voice]);
  createWorkspace({ id: 'voice-workspace', name: 'Builds' });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorkspaceIdContext.Provider value="voice-workspace"><WorkspaceAlarmSettings /></WorkspaceIdContext.Provider>));
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Voice for this workspace"]')!;
    await act(async () => { select.value = 'voice:voice-1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(getWorkspacesSnapshot().workspaces.find(ws => ws.id === 'voice-workspace')?.alertDelivery).toEqual({ speakVoice: 'voice-1' });
    const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!;
    await act(async () => button('Play test sound').click());
    expect(engine.utterances[0].voice).toBe(voice);
    await act(async () => button('Use application defaults').click());
    expect(select.value).toBe('inherit');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
