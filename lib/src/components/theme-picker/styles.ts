import type { CSSProperties } from 'react';

/** Inline styles for the theme picker. Uses --vscode-* tokens so the picker
 *  blends into a VS Code shell while still rendering correctly outside one. */
export const themePickerStyles = {
  muted: { color: 'var(--vscode-descriptionForeground, #858585)' },
  foreground: { color: 'var(--vscode-editor-foreground, #cccccc)' },
  trigger: (open: boolean) => ({
    backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
    borderColor: open ? 'var(--vscode-focusBorder, #007fd4)' : 'var(--vscode-input-border, #3c3c3c)',
    color: 'var(--vscode-editor-foreground, #cccccc)',
  }),
  panel: {
    backgroundColor: 'var(--vscode-editorWidget-background, #252526)',
    borderColor: 'var(--vscode-panel-border, #2b2b2b)',
    color: 'var(--vscode-editor-foreground, #cccccc)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'var(--overlay-max-h-popover, calc(100dvh - 24px))',
    overflow: 'hidden',
  } satisfies CSSProperties,
  compactTrigger: { minHeight: 44, minWidth: 44 } satisfies CSSProperties,
  list: {
    flex: '1 1 auto',
    minHeight: 0,
    maxHeight: 320,
    overflowY: 'auto',
  } satisfies CSSProperties,
  footer: { flexShrink: 0 } satisfies CSSProperties,
  border: { borderColor: 'var(--vscode-panel-border, #2b2b2b)' },
  activeRow: {
    backgroundColor: 'var(--vscode-list-activeSelectionBackground, #094771)',
    color: 'var(--vscode-list-activeSelectionForeground, #ffffff)',
  },
  link: { color: 'var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3794ff))' },
  error: { color: 'var(--vscode-errorForeground, #f48771)' },
  button: {
    backgroundColor: 'var(--vscode-button-background, #0e639c)',
    color: 'var(--vscode-button-foreground, #ffffff)',
  },
};
