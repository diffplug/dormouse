import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restorePocketTheme } from './pocket-theme';

// Apply the theme to <body> before first paint so the auth screens — not just
// the terminal wall — render with the shared VSCode `--color-*` tokens present
// (docs/specs/theme.md, docs/specs/pocket-app.md).
restorePocketTheme();

const root = document.getElementById('pocket-root');
if (!root) throw new Error('#pocket-root is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
