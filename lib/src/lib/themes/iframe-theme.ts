/** The public CSS surface a Tool receives, using VS Code's webview names. */
export function captureIframeTheme() {
  const style = getComputedStyle(document.body);
  const vars: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const key = style[i];
    if (key.startsWith('--vscode-')) vars[key] = style.getPropertyValue(key).trim();
  }
  const classes = document.body.classList;
  const kind = classes.contains('vscode-high-contrast-light') ? 'vscode-high-contrast-light'
    : classes.contains('vscode-high-contrast') ? 'vscode-high-contrast'
    : classes.contains('vscode-light') ? 'vscode-light' : 'vscode-dark';
  return { __dormouse: 'theme', vars, kind, scheme: kind.endsWith('light') ? 'light' : 'dark' };
}

/** One subscription per live frame; updates never navigate or reload it. */
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
  frame.addEventListener('load', send);
  send();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(queued);
    window.removeEventListener('message', receive);
    frame.removeEventListener('load', send);
  };
}
