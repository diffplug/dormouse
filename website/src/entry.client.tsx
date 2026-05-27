import ReactDOM from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import "./index.css";

// Intentionally not wrapped in <React.StrictMode>. The desktop playground's
// Wall/dockview setup is not idempotent across StrictMode's dev-only double
// mount: the first onReady consumes initialPaneIds, so the remount's onReady
// loses `tut-main` and PlaygroundDesktop's addPanel referencePanel throws.
ReactDOM.hydrateRoot(document, <HydratedRouter />);
