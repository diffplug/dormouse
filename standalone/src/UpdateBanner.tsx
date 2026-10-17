import type { ReactNode } from 'react';
import { BaseboardNotice, noticeLinkClass as linkClass, noticeLinkStyle as linkStyle, type NoticeLink } from './BaseboardNotice';

export type UpdateBannerState =
  | { status: 'idle' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string }
  | { status: 'downloaded'; version: string }
  | { status: 'restart-refused'; version: string; reason: string }
  | { status: 'dismissed' }
  | { status: 'post-update-success'; from: string; to: string }
  | { status: 'post-update-failure'; version: string; error?: string }
  // With automatic checks off, the weekly reminder, and the check the user
  // then asks for (`docs/specs/auto-update.md` → "How it works").
  | { status: 'check-due'; days: number }
  | { status: 'checking' }
  | { status: 'up-to-date'; version: string }
  | { status: 'check-failed' };

interface UpdateBannerProps {
  state: UpdateBannerState;
  onDismiss: () => void;
  onApproveUpdate: () => void;
  onRestart: () => void;
  onOpenChangelog: () => void;
  onOpenDebug: () => void;
  onCheckNow: () => void;
}


export function UpdateBanner({ state, onDismiss, onApproveUpdate, onRestart, onOpenChangelog, onOpenDebug, onCheckNow }: UpdateBannerProps) {
  if (state.status === 'idle' || state.status === 'dismissed') return null;

  let message: ReactNode;
  let title: string | undefined;
  let links: NoticeLink[];

  switch (state.status) {
    case 'available':
      message = (
        <>
          Update available
          {' · '}
          <button onClick={onOpenChangelog} className={linkClass} style={linkStyle}>
            Changelog
          </button>
          {' · '}
          <button onClick={onApproveUpdate} className={linkClass} style={linkStyle}>
            Install when I quit
          </button>
        </>
      );
      links = [];
      break;
    case 'downloading':
      message = `Downloading update v${state.version}`;
      links = [{ label: 'Changelog', onClick: onOpenChangelog }];
      break;
    case 'downloaded':
      message = `Update downloaded (v${state.version}) — will install when you quit`;
      links = [
        { label: 'Changelog', onClick: onOpenChangelog },
        { label: 'Restart now', onClick: onRestart },
      ];
      break;
    case 'restart-refused':
      // No "Restart now": the host's refusal holds until Dormouse relaunches.
      title = `Update downloaded (v${state.version}) — will install when you quit (couldn't restart: ${state.reason})`;
      message = title;
      links = [{ label: 'Changelog', onClick: onOpenChangelog }];
      break;
    case 'post-update-success':
      message = `Updated to v${state.to} — from v${state.from}`;
      links = [{ label: 'Changelog', onClick: onOpenChangelog }];
      break;
    case 'post-update-failure':
      message = 'Update failed';
      links = [{ label: 'Click here to debug', onClick: onOpenDebug }];
      break;
    case 'check-due':
      message = `No update check in ${state.days} days`;
      links = [{ label: 'Check now', onClick: onCheckNow }];
      break;
    case 'checking':
      message = 'Checking for updates…';
      links = [];
      break;
    case 'up-to-date':
      message = `Dormouse is up to date (v${state.version})`;
      links = [];
      break;
    case 'check-failed':
      message = 'Couldn’t check for updates';
      links = [{ label: 'Try again', onClick: onCheckNow }];
      break;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }

  return <BaseboardNotice message={message} title={title} links={links} onDismiss={onDismiss} />;
}
