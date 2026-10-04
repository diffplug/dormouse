import { createRoot } from "react-dom/client";
import { applyTheme } from "../../lib/src/lib/themes/apply";
import { getBundledThemes } from "../../lib/src/lib/themes/store";
import { ADMIN_METRICS_PAGE, AdminMetrics } from "./AdminMetrics";
import { App } from "./App";
import { takeCheckout, takeReturn } from "./checkout";
import { takeEnrollment } from "./enrollment";
import "./style.css";

const preference = matchMedia("(prefers-color-scheme: dark)");
function restoreTheme() {
  const id = preference.matches
    ? "vscode.theme-kimbie-dark.kimbie-dark"
    : "vscode.theme-defaults.light-visual-studio";
  const theme = getBundledThemes().find((theme) => theme.id === id)!;
  applyTheme(theme);
  document.documentElement.style.colorScheme = theme.type;
}
restoreTheme();
preference.addEventListener("change", restoreTheme);
const root = createRoot(document.getElementById("root")!);
if (location.pathname === ADMIN_METRICS_PAGE) root.render(<AdminMetrics />);
else {
  // Taken before anything renders; a later fragment change on `/enroll` is App's.
  const enrollment = takeEnrollment();
  const checkout = takeCheckout();
  const returned = takeReturn();
  root.render(<App enrollment={enrollment} checkout={checkout} returned={returned} />);
}
