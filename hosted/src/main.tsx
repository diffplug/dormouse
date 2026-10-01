import { createRoot } from "react-dom/client";
import { applyTheme } from "../../lib/src/lib/themes/apply";
import { getBundledThemes } from "../../lib/src/lib/themes/store";
import { normalizeEnrollUserCode } from "../../remote-lib-common/src/remote/enroll-code.ts";
import { App, type Enrollment } from "./App";
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
/**
 * An enrollment link's user code (`docs/specs/hosted.md` -> "Burrow
 * enrollment"), taken once before anything renders and erased from the address
 * bar and history; null when this is no enrollment link. The page holds it in
 * memory only.
 */
function takeEnrollment(): Enrollment | null {
  const { pathname, search, hash } = location;
  if (pathname !== "/enroll" || hash === "") return null;
  history.replaceState(null, "", pathname + search);
  return { code: normalizeEnrollUserCode(hash.slice(1)) };
}
const enrollment = takeEnrollment();
// A link opened in the tab already showing this page changes only its
// fragment, which loads nothing: reload, and take it as the first load did.
window.addEventListener("hashchange", () => location.reload());
createRoot(document.getElementById("root")!).render(
  <App enrollment={enrollment} />,
);
