import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restorePocketTheme } from './pocket-theme';
import { registerPushServiceWorker } from './service-worker';
import { takeSetupHash } from './setup-link';

// Apply the theme to <body> before first paint so the auth screens — not just
// the terminal wall — render with the shared VSCode `--color-*` tokens present
// (docs/specs/theme.md, docs/specs/pocket-app.md).
restorePocketTheme();

// Read the scanned code before the first render, and here rather than inside a
// component: taking the hash erases it, so the read has to happen exactly once
// per page load, and module scope is the only place that is structurally
// guaranteed. (A `useState` initializer happens to survive StrictMode's doubled
// mount, but nothing in the component makes that true — a render-body or effect
// read would lose the code outright.)
const scanned = takeSetupHash();

// Best-effort and never awaited: the worker only carries push, so registering
// it must not sit in front of the first paint (docs/specs/pocket-app.md).
registerPushServiceWorker();

const root = document.getElementById('pocket-root');
if (!root) throw new Error('#pocket-root is missing');

createRoot(root).render(
  <StrictMode>
    <App scanned={scanned} />
  </StrictMode>,
);
