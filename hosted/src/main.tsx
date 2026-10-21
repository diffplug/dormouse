import { createRoot } from "react-dom/client";
import { applyTheme } from "../../lib/src/lib/themes/apply";
import { hostedTheme } from "./theme";
import { App } from "./App";
import { takeEnrollment } from "./enrollment";
import "./style.css";

const preference = matchMedia("(prefers-color-scheme: dark)");
function restoreTheme() {
  const theme = hostedTheme(preference.matches);
  applyTheme(theme);
  document.documentElement.style.colorScheme = theme.type;
}
restoreTheme();
preference.addEventListener("change", restoreTheme);
// Taken before anything renders; a later fragment change on `/enroll` is App's.
const enrollment = takeEnrollment();
createRoot(document.getElementById("root")!).render(
  <App enrollment={enrollment} />,
);
