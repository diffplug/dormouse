import { getBundledThemes } from "../../lib/src/lib/themes/store";

/** The two system-preference choices used by Hosted's production entrypoint. */
export function hostedTheme(dark: boolean) {
  const id = dark
    ? "vscode.theme-kimbie-dark.kimbie-dark"
    : "vscode.theme-defaults.light-visual-studio";
  return getBundledThemes().find((theme) => theme.id === id)!;
}
