/** The workbench theme as an editor page sees it: the host's iframe shim
 * sets `--vscode-*` variables and a body class, then fires `dormouse:theme`
 * (docs/specs/theme.md -> Tool iframe themes); without a host, the OS scheme. */
export interface PageTheme { dark: boolean; fontFamily: string }

let current: PageTheme | undefined;
const scheme = matchMedia('(prefers-color-scheme: dark)');

/** The current theme, read fresh; the same object until it changes. */
export function pageTheme(): PageTheme {
  const classes = [...document.body.classList];
  const dark = classes.some(c => c.startsWith('vscode-'))
    ? !classes.includes('vscode-light') && !classes.includes('vscode-high-contrast-light')
    : scheme.matches;
  const fontFamily = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || 'system-ui, sans-serif';
  return dark === current?.dark && fontFamily === current.fontFamily ? current : (current = { dark, fontFamily });
}

export function subscribeTheme(listener: () => void): () => void {
  // React compares snapshots itself, so every subscriber hears every change.
  window.addEventListener('dormouse:theme', listener);
  scheme.addEventListener('change', listener);
  return () => { window.removeEventListener('dormouse:theme', listener); scheme.removeEventListener('change', listener); };
}
