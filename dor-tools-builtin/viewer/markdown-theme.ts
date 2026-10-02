/** The workbench theme as the Markdown page sees it: the host's iframe shim
 * sets `--vscode-*` variables and a body class, then fires `dormouse:theme`
 * (docs/specs/theme.md -> Tool iframe themes); without a host, the OS scheme. */
export interface PageTheme { dark: boolean; fontFamily: string }

let current: PageTheme | undefined;
const scheme = matchMedia('(prefers-color-scheme: dark)');

function read(): PageTheme {
  const classes = [...document.body.classList];
  const dark = classes.some(c => c.startsWith('vscode-'))
    ? !classes.includes('vscode-light') && !classes.includes('vscode-high-contrast-light')
    : scheme.matches;
  const fontFamily = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || 'system-ui, sans-serif';
  return dark === current?.dark && fontFamily === current.fontFamily ? current : (current = { dark, fontFamily });
}

/** The current theme; the same object until it changes. */
export const pageTheme = (): PageTheme => current ?? read();

export function subscribeTheme(listener: () => void): () => void {
  // React compares snapshots itself; every subscriber must hear every change.
  const update = () => { read(); listener(); };
  window.addEventListener('dormouse:theme', update);
  scheme.addEventListener('change', update);
  return () => { window.removeEventListener('dormouse:theme', update); scheme.removeEventListener('change', update); };
}
