import { useEffect, useRef, useState } from 'react';
import { markdownLink, headingIds } from '../src/markdown-links';

export function assignHeadingIds(): void {
  const headings = [...document.querySelectorAll<HTMLElement>('.prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6')];
  headingIds(headings.map(h => h.textContent ?? '')).forEach((id, i) => { headings[i].id = id; });
}

/** Links are reading actions. The context menu keeps editing available without
 * making a plain click enter the link editor instead of following the link. */
export function MarkdownNavigation({ follow, edit }: {
  follow(href: string, disposition: 'current' | 'other'): void;
  edit(anchor: HTMLAnchorElement): void;
}) {
  const [menu, setMenu] = useState<{ anchor: HTMLAnchorElement; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const anchor = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLAnchorElement>('.prose a[href]') : null;
    const click = (event: MouseEvent) => {
      const link = anchor(event.target);
      if (!link || event.button !== 0) return;
      const href = link.getAttribute('href') ?? '';
      // Web/mail links keep their existing handling. Unsupported local links
      // reach the route's visible error, never the capability URL as navigation.
      if (/^(?:https?:|mailto:)/i.test(href.trim())) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setMenu(null);
      if (event.detail <= 1) follow(href, event.ctrlKey || event.metaKey ? 'other' : 'current');
    };
    const context = (event: MouseEvent) => {
      const link = anchor(event.target);
      if (!link || !markdownLink(link.getAttribute('href') ?? '')) return;
      event.preventDefault(); event.stopPropagation();
      setMenu({ anchor: link, x: event.clientX, y: event.clientY });
    };
    document.addEventListener('click', click, true);
    document.addEventListener('contextmenu', context, true);
    const observer = new MutationObserver(assignHeadingIds);
    observer.observe(document.getElementById('root')!, { childList: true, characterData: true, subtree: true });
    assignHeadingIds();
    return () => { document.removeEventListener('click', click, true); document.removeEventListener('contextmenu', context, true); observer.disconnect(); };
  }, [follow]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button')?.focus();
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); menu.anchor.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...(menuRef.current?.querySelectorAll('button') ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key, true); };
  }, [menu]);
  if (!menu) return null;
  return <div ref={menuRef} className="md-link-menu" role="menu" style={{ left: Math.max(0, Math.min(menu.x, innerWidth - 215)), top: Math.max(0, Math.min(menu.y, innerHeight - 72)) }}>
    <button role="menuitem" onClick={() => { follow(menu.anchor.getAttribute('href')!, 'other'); setMenu(null); }}>Open in another surface</button>
    <button role="menuitem" onClick={() => { edit(menu.anchor); setMenu(null); }}>Edit link</button>
  </div>;
}
