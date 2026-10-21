import { useLayoutEffect, useRef, useState } from "react";
import { applyHostedTheme, hostedThemes, storeThemeId } from "./theme";

/** The docs pages' "pick a theme" offer, as a native control: the page it sits
 * on is a short form, not long-form reading. */
export function ThemeSelect() {
  const select = useRef<HTMLSelectElement>(null);
  const [themeId, setThemeId] = useState("");
  // Whatever the document was painted with, which a story frame sets itself.
  useLayoutEffect(() => {
    setThemeId(select.current!.ownerDocument.body.dataset.hostedTheme ?? "");
  }, []);
  return (
    <label className="theme-select">
      Theme
      <span className="select-wrap">
      <select
        ref={select}
        value={themeId}
        onChange={(event) => {
          const id = event.currentTarget.value;
          applyHostedTheme(event.currentTarget.ownerDocument, id);
          storeThemeId(id);
          setThemeId(id);
        }}
      >
        {hostedThemes().map((theme) => (
          <option key={theme.id} value={theme.id}>{theme.label}</option>
        ))}
      </select>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </label>
  );
}
