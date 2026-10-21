import { createRoot } from "react-dom/client";
import { getStoredActiveThemeId } from "../../lib/src/lib/themes/store";
import { applyHostedTheme, DEFAULT_THEME_ID } from "./theme";
import { App } from "./App";
import { takeEnrollment } from "./enrollment";
import "./style.css";

applyHostedTheme(document, getStoredActiveThemeId() ?? DEFAULT_THEME_ID);
// Taken before anything renders; a later fragment change on `/enroll` is App's.
const enrollment = takeEnrollment();
createRoot(document.getElementById("root")!).render(
  <App enrollment={enrollment} />,
);
