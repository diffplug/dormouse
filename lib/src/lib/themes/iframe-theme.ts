import { inferVscodeThemeKind } from './vscode-color-resolver';

const WEBVIEW_THEME_CLASS = {
  light: 'vscode-light', dark: 'vscode-dark', hcLight: 'vscode-high-contrast-light', hcDark: 'vscode-high-contrast',
} as const;

/** The public CSS surface a Tool receives, using VS Code's webview names. */
export function captureIframeTheme() {
  const style = getComputedStyle(document.body);
  const vars: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const key = style[i];
    if (key.startsWith('--vscode-')) vars[key] = style.getPropertyValue(key).trim();
  }
  const kind = WEBVIEW_THEME_CLASS[inferVscodeThemeKind()];
  return { __dormouse: 'theme', vars, kind, scheme: kind.endsWith('light') ? 'light' : 'dark' };
}

/** One subscription per live frame; updates never navigate or reload it. The
 * shim asks again at each document load, so a load needs no send of its own. */
export function connectIframeTheme(frame: HTMLIFrameElement, origin: string): () => void {
  let queued = 0;
  const send = () => frame.contentWindow?.postMessage(captureIframeTheme(), origin);
  const schedule = () => {
    if (!queued) queued = requestAnimationFrame(() => { queued = 0; send(); });
  };
  const receive = (event: MessageEvent) => {
    if (event.origin === origin && event.source === frame.contentWindow && event.data?.__dormouse === 'theme-request') send();
  };
  const observer = new MutationObserver(schedule);
  for (const target of [document.body, document.documentElement]) {
    observer.observe(target, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.addEventListener('message', receive);
  send();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(queued);
    window.removeEventListener('message', receive);
  };
}
