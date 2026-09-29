/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { captureIframeTheme, connectIframeTheme } from './iframe-theme';

afterEach(() => { document.body.textContent = ''; document.body.removeAttribute('style'); document.body.removeAttribute('class'); vi.restoreAllMocks(); });
it('exposes resolved VS Code variables and polarity, excluding unrelated app state', () => {
  document.body.style.setProperty('--vscode-editor-background', '#123456');
  document.body.style.setProperty('--private', 'secret');
  document.body.className = 'vscode-light';
  expect(captureIframeTheme()).toEqual({ __dormouse: 'theme', kind: 'vscode-light', scheme: 'light', vars: { '--vscode-editor-background': '#123456' } });
});
it('answers only its own frame and stops sending after disposal', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const dispose = connectIframeTheme(frame, 'http://localhost:4000');
  expect(post).toHaveBeenCalledTimes(1);
  const message = (origin: string, source = frame.contentWindow) => window.dispatchEvent(new MessageEvent('message', {
    origin, source, data: { __dormouse: 'theme-request' },
  }));
  message('https://elsewhere.test'); message('http://localhost:4000', window);
  expect(post).toHaveBeenCalledTimes(1);
  document.body.className = 'vscode-light'; message('http://localhost:4000');
  expect(post.mock.lastCall?.[0].scheme).toBe('light');
  dispose(); frame.dispatchEvent(new Event('load')); message('http://localhost:4000');
  expect(post).toHaveBeenCalledTimes(2);
});
