import { createRoot } from "react-dom/client";
import { applyHostedTheme, storedThemeId } from "./theme";
import { App } from "./App";
import { takeEnrollment } from "./enrollment";
import "./style.css";

applyHostedTheme(document, storedThemeId());
// Taken before anything renders; a later fragment change on `/enroll` is App's.
const enrollment = takeEnrollment();
createRoot(document.getElementById("root")!).render(
  <App enrollment={enrollment} />,
);
