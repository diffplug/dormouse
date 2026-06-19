import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import "./index.css";

// StrictMode everywhere (matches the lib web + standalone entries and Storybook):
// the dev-only double mount is now idempotent end to end. The Wall's onReady
// caches its initial restoration instead of consuming it (use-dockview-ready.ts),
// so the remount re-creates `tut-main` and the playground's addPanel no longer
// loses its referencePanel.
ReactDOM.hydrateRoot(
  document,
  <StrictMode>
    <HydratedRouter />
  </StrictMode>,
);
