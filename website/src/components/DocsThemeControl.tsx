/**
 * The reference pages' floating theme control, bottom right.
 *
 * The picker is the same `compact` ThemePicker the Pocket playground pages
 * use, for the same reason: these pages have no baseboard, so there is no
 * Settings dialog to put it in (docs/specs/theme.md -> Where the user picks a
 * theme). It opens upward, being pinned to the bottom of the viewport.
 */
import { useState } from "react";
import { ThemePicker } from "dormouse-lib/components/ThemePicker";
import { hasChosenDocsTheme, rememberDocsThemeChoice } from "../lib/docs-theme";

export default function DocsThemeControl() {
  // Read once, before the first paint: the prompt must not appear and then
  // vanish for a reader who already chose.
  const [chosen, setChosen] = useState(hasChosenDocsTheme);

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 print:hidden">
      {chosen ? null : (
        <div
          role="status"
          className="relative max-w-[15rem] rounded-lg border px-3 py-2 text-sm leading-snug shadow-2xl"
          style={{
            borderColor: "var(--vscode-panel-border, rgba(255,255,255,0.2))",
            backgroundColor: "var(--vscode-editorWidget-background, #1e1e1e)",
            color: "var(--vscode-editor-foreground, #d4d4d4)",
          }}
        >
          Reading these in the dark? Pick a theme — light or dark, it sticks.
          <span
            aria-hidden="true"
            className="absolute -bottom-1 right-6 size-2 rotate-45 border-b border-r"
            style={{
              borderColor: "var(--vscode-panel-border, rgba(255,255,255,0.2))",
              backgroundColor: "var(--vscode-editorWidget-background, #1e1e1e)",
            }}
          />
        </div>
      )}
      <div
        className="rounded border px-1.5 py-1 shadow-2xl"
        style={{
          borderColor: "var(--vscode-panel-border, rgba(255,255,255,0.2))",
          backgroundColor: "var(--vscode-editorWidget-background, #1e1e1e)",
          color: "var(--vscode-editor-foreground, #d4d4d4)",
        }}
      >
        <ThemePicker
          variant="compact"
          menuSide="above"
          onPick={() => {
            rememberDocsThemeChoice();
            setChosen(true);
          }}
        />
      </div>
    </div>
  );
}
