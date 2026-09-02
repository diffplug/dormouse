/**
 * The reference pages' floating theme control, bottom right.
 *
 * The picker is the same `compact` ThemePicker the Pocket playground pages
 * use, for the same reason: these pages have no baseboard, so there is no
 * Settings dialog to put it in (docs/specs/theme.md -> Where the user picks a
 * theme). It opens upward, being pinned to the bottom of the viewport.
 */
import { useEffect, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { ThemePicker } from "dormouse-lib/components/ThemePicker";
import { dismissThemePrompt, isThemePromptDismissed } from "../lib/docs-theme";

/**
 * Both floating panels sit over the page's own themed background, so they take
 * the picked theme's widget colors. Literal fallbacks rather than the site
 * palette: the control is pinned to the viewport and must stay legible in the
 * moment before a theme is applied.
 */
const PANEL_STYLE: React.CSSProperties = {
  borderColor: "var(--vscode-panel-border, rgba(255,255,255,0.2))",
  backgroundColor: "var(--vscode-editorWidget-background, #1e1e1e)",
  color: "var(--vscode-editor-foreground, #d4d4d4)",
};

export default function DocsThemeControl() {
  // Prerender and the first client render must agree without consulting
  // browser-only storage. Unknown stays hidden; after hydration, only a reader
  // who has not answered sees the prompt, so a dismissed prompt never flashes.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => setDismissed(isThemePromptDismissed()), []);

  const dismiss = () => {
    dismissThemePrompt();
    setDismissed(true);
  };

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 print:hidden">
      {dismissed === false ? (
        <div
          role="status"
          className="relative max-w-[15rem] rounded-lg border py-2 pl-3 pr-8 text-sm leading-snug shadow-2xl"
          style={PANEL_STYLE}
        >
          Don't like the colors? Pick a theme.
          {/* Closing counts as answering the prompt, so it does not return on
              the next page: a reader who declined has still seen the offer. */}
          <button
            type="button"
            aria-label="Dismiss theme prompt"
            onClick={dismiss}
            className="absolute right-1.5 top-1.5 rounded p-1 opacity-50 hover:opacity-100"
          >
            <XIcon size={12} weight="bold" />
          </button>
          <span
            aria-hidden="true"
            className="absolute -bottom-1 right-6 size-2 rotate-45 border-b border-r"
            style={PANEL_STYLE}
          />
        </div>
      ) : null}
      <div className="rounded border px-1.5 py-1 shadow-2xl" style={PANEL_STYLE}>
        <ThemePicker variant="compact" menuSide="above" onPick={dismiss} />
      </div>
    </div>
  );
}
