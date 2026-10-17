import type { ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';

export const noticeLinkClass = 'shrink-0 hover:underline';
export const noticeLinkStyle = { color: 'var(--vscode-textLink-foreground)' };

export interface NoticeLink {
  label: string;
  onClick: () => void;
}

/** One host notice in the Baseboard's notice slot: a message, its links, and a dismiss. */
export function BaseboardNotice({ message, title, links, onDismiss }: {
  message: ReactNode;
  title?: string;
  links: NoticeLink[];
  onDismiss: () => void;
}) {
  return (
    <span className="flex items-center gap-1.5 pb-1 text-sm font-mono text-muted">
      <span className="truncate" title={title}>{message}</span>
      {links.map((link) => (
        <span key={link.label} className="contents">
          <span className="shrink-0">·</span>
          <button onClick={link.onClick} className={noticeLinkClass} style={noticeLinkStyle}>
            {link.label}
          </button>
        </span>
      ))}
      <button
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 hover:bg-foreground/10 hover:text-foreground"
        aria-label="Dismiss"
      >
        <XIcon size={10} />
      </button>
    </span>
  );
}
