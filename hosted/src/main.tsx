import { createRoot } from "react-dom/client";
import { applyTheme } from "../../lib/src/lib/themes/apply";
import { getBundledThemes } from "../../lib/src/lib/themes/store";
import { App } from "./App";
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
createRoot(document.getElementById("root")!).render(<App />);
