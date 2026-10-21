import { createRoot } from "react-dom/client";
import { applyHostedTheme } from "./theme";
import { App } from "./App";
import { takeEnrollment } from "./enrollment";
import "./style.css";

const preference = matchMedia("(prefers-color-scheme: dark)");
function restoreTheme() {
  applyHostedTheme(document, preference.matches);
}
restoreTheme();
preference.addEventListener("change", restoreTheme);
// Taken before anything renders; a later fragment change on `/enroll` is App's.
const enrollment = takeEnrollment();
createRoot(document.getElementById("root")!).render(
  <App enrollment={enrollment} />,
);
