import { useEffect, useRef, useState } from 'react';
import { headingIds, isWebLink, markdownLink } from '../src/markdown-links';

/** The rendered heading `fragment` names. Ids are derived when a fragment is
 * followed, never written into the document or kept in sync while editing. */
export function headingFor(fragment: string): HTMLElement | undefined {
  const headings = [...document.querySelectorAll<HTMLElement>('.prose :is(h1,h2,h3,h4,h5,h6)')];
  return headings[headingIds(headings.map(h => h.textContent ?? '')).indexOf(fragment)];
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
      if (isWebLink(href)) return;
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
    return () => { document.removeEventListener('click', click, true); document.removeEventListener('contextmenu', context, true); };
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
