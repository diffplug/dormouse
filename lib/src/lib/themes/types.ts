export interface DormouseTheme {
  /** Stable unique ID, e.g. "GitHub.github-vscode-theme.github-dark-default" */
  id: string;
  /** Human-readable label from the VSCode theme */
  label: string;
  /** Theme base type */
  type: 'dark' | 'light';
  /** editor.background, recorded at import. Nothing renders it since the picker
   *  began resolving previews from `vars`; the persisted-shape guard in
   *  `store.ts` still requires it. */
  swatch: string;
  /** focusBorder, recorded at import. Read only by the docs and Hosted accent
   *  (`lib/src/lib/themes/contrast.ts`) — the picker's swatch dot uses the
   *  runtime focus-ring pick, which can differ when focusBorder is achromatic. */
  accent: string;
  /** --vscode-* CSS variable overrides */
  vars: Record<string, string>;
  /** Where this theme came from */
  origin: BundledOrigin | InstalledOrigin;
}

export interface BundledOrigin {
  kind: 'bundled';
}

export interface InstalledOrigin {
  kind: 'installed';
  /** OpenVSX namespace/name, e.g. "publisher/theme-extension" */
  extensionId: string;
  /** ISO date string */
  installedAt: string;
}
