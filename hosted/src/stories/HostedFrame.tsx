import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { applyHostedTheme, DEFAULT_THEME_ID } from "../theme";

const LIGHT_THEME_ID = "vscode.theme-defaults.light-visual-studio";
import css from "../style.css?inline";

const DOCUMENT = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="hosted-root"></div></body></html>';

/** Production CSS and theme in a separate document: neither Tailwind's reset
 * nor the surrounding docs/toolbar palette participates in this page. */
export function HostedFrame({ children, phone = false, light = false }: {
  children: ReactNode;
  phone?: boolean;
  light?: boolean;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [width, minimumHeight] = phone ? [390, 844] : [1200, 900];
  useLayoutEffect(() => {
    if (doc) applyHostedTheme(doc, light ? LIGHT_THEME_ID : DEFAULT_THEME_ID);
  }, [doc, light]);
  useLayoutEffect(() => {
    if (!doc) return;
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
    };
  }, [doc, minimumHeight]);
  return <iframe
    ref={iframe}
    title="Dormouse Hosted"
    data-hosted-frame
    srcDoc={DOCUMENT}
    onLoad={() => setDoc(iframe.current!.contentDocument)}
    style={{ display: "block", width, maxWidth: "100%", height: minimumHeight, border: 0, flexShrink: 0 }}
  >{doc && createPortal(children, doc.getElementById("hosted-root")!)}</iframe>;
}
