/**
 * The docs pages' theme picker, and the prompt that points a reader at it.
 *
 * The picker is the same `compact` ThemePicker the Pocket playground pages
 * use, for the same reason: these pages have no baseboard, so there is no
 * Settings dialog to put it in (docs/specs/theme.md -> Where the user picks a
 * theme).
 *
 * Two placements, because the docs have two shapes. Wide screens float it
 * bottom right, clear of the rail, opening upward. Narrow screens have a
 * sticky bar already naming the section, so it sits at the end of that line
 * and opens downward rather than adding a second floating control to a small
 * viewport.
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

export default function DocsThemeControl({
  variant = "floating",
}: {
  variant?: "floating" | "inline";
}) {
  // Prerender and the first client render must agree without consulting
  // browser-only storage. Unknown stays hidden; after hydration, only a reader
  // who has not answered sees the prompt, so a dismissed prompt never flashes.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => setDismissed(isThemePromptDismissed()), []);

  const dismiss = () => {
    dismissThemePrompt();
    setDismissed(true);
  };

  const inline = variant === "inline";

  const prompt =
    dismissed === false ? (
      <div
        role="status"
        // Explicit width when inline: an absolutely-positioned box shrinks to
        // fit its containing block, which here is the picker, so the prose
        // would wrap one word per line.
        className={`rounded-lg border py-2 pl-3 pr-8 text-sm leading-snug shadow-2xl ${
          inline ? "absolute right-0 top-full z-20 mt-2 w-[15rem]" : "relative max-w-[15rem]"
        }`}
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
        {/* Points at the picker, which is below on wide screens and above in
            the bar. */}
        <span
          aria-hidden="true"
          className={`absolute right-6 size-2 rotate-45 ${
            inline ? "-top-1 border-l border-t" : "-bottom-1 border-b border-r"
          }`}
          style={PANEL_STYLE}
        />
      </div>
    ) : null;

  const picker = (
    <div className="rounded border px-1.5 py-1 shadow-2xl" style={PANEL_STYLE}>
      <ThemePicker
        variant="compact"
        menuSide={inline ? "below" : "above"}
        onPick={dismiss}
      />
    </div>
  );

  if (inline) {
    return (
      <div className="relative shrink-0 print:hidden">
        {picker}
        {prompt}
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 hidden flex-col items-end gap-2 print:hidden lg:flex">
      {prompt}
      {picker}
    </div>
  );
}
