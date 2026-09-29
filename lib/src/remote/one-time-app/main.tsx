import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OneTimeApp } from './OneTimeApp';
import { applyPocketTheme } from '../pocket-app/pocket-theme';
import { reloadOnNewLink, takeOneTimeLinkUrl } from './take-link';

// Pocket's theme on <body> before first paint, as Pocket's own `main.tsx`
// restores it — but applied, not restored: this page keeps nothing, so no
// stored pick is read or written (docs/specs/one-time.md -> "Phone page").
applyPocketTheme();

// Take the link and erase its fragment before the first render, and here
// rather than inside a component: taking erases, so the read has to happen
// exactly once per page load, and module scope is the only place that is
// structurally guaranteed.
const linkUrl = takeOneTimeLinkUrl();
reloadOnNewLink();

const root = document.getElementById('one-time-root');
if (!root) throw new Error('#one-time-root is missing');

createRoot(root).render(
  <StrictMode>
    <OneTimeApp linkUrl={linkUrl} />
  </StrictMode>,
);
