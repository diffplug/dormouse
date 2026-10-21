import { createContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { resolveThemeVars } from "../../../lib/src/lib/themes/apply";
import { hostedTheme } from "../theme";
import css from "../style.css?inline";

export const HostedDocument = createContext<Document | null>(null);

const DOCUMENT = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="hosted-root"></div></body></html>';

/** Production CSS and theme in a separate document: neither Tailwind's reset
 * nor the surrounding docs/toolbar palette participates in this page. */
export function HostedFrame({ children, width = 1200, dark = false }: {
  children: ReactNode;
  width?: number;
  dark?: boolean;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const minimumHeight = width === 390 ? 844 : 900;
  useLayoutEffect(() => {
    if (!doc) return;
    const theme = hostedTheme(dark);
    const vars = resolveThemeVars(theme);
    for (const [name, value] of Object.entries(vars)) doc.body.style.setProperty(name, value);
    doc.body.classList.add(theme.type === "light" ? "vscode-light" : "vscode-dark");
    doc.body.style.colorScheme = theme.type;
    doc.documentElement.style.colorScheme = theme.type;
    const style = doc.createElement("style");
    // 100svh would grow with the measured iframe, preventing it from shrinking
    // after a shorter state. Pin only its minimum to the simulated viewport.
    style.textContent = `${css}\n.shell { min-height: ${minimumHeight}px; }`;
    doc.head.append(style);
    const frame = iframe.current!;
    const bodyRoot = doc.getElementById("hosted-root")!;
    let alive = true;
    const resize = () => {
      frame.style.height = `${Math.ceil(Math.max(minimumHeight, bodyRoot.getBoundingClientRect().height))}px`;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(bodyRoot);
    resize();
    void doc.fonts.ready.then(() => {
      if (!alive) return;
      resize();
      frame.dataset.ready = "true";
    });
    // Inspectable hrefs, but a click in a fixture never leaves Storybook.
    const intercept = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("a")) event.preventDefault();
    };
    doc.addEventListener("click", intercept);
    return () => {
      alive = false;
      delete frame.dataset.ready;
      observer.disconnect();
      doc.removeEventListener("click", intercept);
      style.remove();
      for (const name of Object.keys(vars)) doc.body.style.removeProperty(name);
      doc.body.classList.remove("vscode-light", "vscode-dark");
    };
  }, [doc, dark, minimumHeight]);
  return <iframe
    ref={iframe}
    title="Dormouse Hosted"
    data-hosted-frame
    srcDoc={DOCUMENT}
    onLoad={() => setDoc(iframe.current!.contentDocument)}
    style={{ display: "block", width, maxWidth: "100%", height: minimumHeight, border: 0, flexShrink: 0 }}
  >{doc && createPortal(<HostedDocument.Provider value={doc}>{children}</HostedDocument.Provider>, doc.getElementById("hosted-root")!)}</iframe>;
}
