import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restorePocketTheme } from './pocket-theme';
import { registerPushServiceWorker } from './service-worker';
import { takePairingHash } from './pair-link';
import { purgeLegacyPairedMarkers } from '../client/pocket-client';

// Apply the theme to <body> before first paint so the auth screens — not just
// the terminal wall — render with the shared VSCode `--color-*` tokens present
// (docs/specs/theme.md, docs/specs/pocket-app.md).
restorePocketTheme();

// Erase a `#pair?` fragment before the first render, and here rather than
// inside a component: taking the hash erases it, so the read has to happen
// exactly once per page load, and module scope is the only place that is
// structurally guaranteed. Nothing is kept from it but the fact that it was
// there — see `pair-link.ts`.
const arrivedByCamera = takePairingHash();

// One sweep of the markers the pre-end-to-end Hosts view kept. Boot, because it
// is a one-time cleanup rather than anything a screen depends on.
purgeLegacyPairedMarkers();

// Best-effort and never awaited: the worker only carries push, so registering
// it must not sit in front of the first paint (docs/specs/pocket-app.md).
registerPushServiceWorker();

const root = document.getElementById('pocket-root');
if (!root) throw new Error('#pocket-root is missing');

createRoot(root).render(
  <StrictMode>
    <App arrivedByCamera={arrivedByCamera} />
  </StrictMode>,
);
