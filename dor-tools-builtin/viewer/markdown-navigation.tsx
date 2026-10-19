import { useEffect, useRef, useState } from 'react';
import { headingIds, isWebLink, markdownLink } from '../src/markdown-links';

/** The rendered heading `fragment` names. Ids are derived when a fragment is
 * followed, never written into the document or kept in sync while editing. */
export function headingFor(fragment: string): HTMLElement | undefined {
  const headings = [...document.querySelectorAll<HTMLElement>('.prose :is(h1,h2,h3,h4,h5,h6)')];
  return headings[headingIds(headings.map(h => h.textContent ?? '')).indexOf(fragment)];
}

/** The document path a local image opens, which `ImageChrome` and the Images
 * panel set on an element around it. */
const documentImage = (target: EventTarget | null) =>
  target instanceof HTMLImageElement ? target.closest<HTMLElement>('[data-document-image]')?.dataset.documentImage : undefined;

/** Document links and embedded images share navigation and its context menu. */
export function MarkdownNavigation({ follow, edit }: {
  follow(href: string, disposition: 'current' | 'other'): void;
  edit(anchor: HTMLAnchorElement): void;
}) {
  /** `link` is the anchor the menu opened on; an image's menu has none. */
  const [menu, setMenu] = useState<{ href: string; link?: HTMLAnchorElement; x: number; y: number } | null>(null);
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
    const doubleClick = (event: MouseEvent) => {
      const href = documentImage(event.target);
      if (!href) return;
      event.preventDefault();
      follow(href, 'current');
    };
    const context = (event: MouseEvent) => {
      const image = documentImage(event.target);
      const link = image === undefined ? anchor(event.target) ?? undefined : undefined;
      const href = image ?? link?.getAttribute('href');
      if (!href || !markdownLink(href)) return;
      event.preventDefault(); event.stopPropagation();
      setMenu({ href, link, x: event.clientX, y: event.clientY });
    };
    document.addEventListener('click', click, true);
    document.addEventListener('dblclick', doubleClick, true);
    document.addEventListener('contextmenu', context, true);
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('dblclick', doubleClick, true);
      document.removeEventListener('contextmenu', context, true);
    };
  }, [follow]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button')?.focus();
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); menu.link?.focus(); }
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
    <button role="menuitem" onClick={() => { follow(menu.href, 'other'); setMenu(null); }}>Open in another surface</button>
    <button role="menuitem" onClick={() => { if (menu.link) edit(menu.link); else follow(menu.href, 'current'); setMenu(null); }}>{menu.link ? 'Edit link' : 'Edit image'}</button>
  </div>;
}
