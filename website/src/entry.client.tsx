import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import "./index.css";

// StrictMode everywhere (matches the lib web + standalone entries and Storybook):
// the dev-only double mount is idempotent end to end. The Wall seeds its layout once
// per mount (a `lathSeededRef` guard), so a StrictMode remount keeps the same panes
// rather than re-generating them.
ReactDOM.hydrateRoot(
  document,
  <StrictMode>
    <HydratedRouter />
  </StrictMode>,
);
