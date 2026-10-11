import { ClipboardTextIcon } from '@phosphor-icons/react';
import { Fragment, useEffect, useState, useSyncExternalStore } from 'react';
import { ExternalTextLink } from './ExternalTextLink';
import { modalActionButton } from './design';
import { hostOf } from './remote-control-shared';
import { buildTag, installKind, readBuildStamp, type BuildStamp, type InstallKind } from '../lib/build-info';
import { writeTextToClipboard } from '../lib/clipboard';
import { getPlatform, PLATFORM_STRING } from '../lib/platform';
import type { AboutHost } from '../lib/platform/types';
import type { RelayMode } from '../host/relay-origin';
import { getBurrowStatusSnapshot, subscribeToBurrowStatus, type BurrowStatusState } from '../remote/burrow/burrow-status-store';

const REPO_URL = 'https://github.com/diffplug/dormouse';
const CHANGELOG_URL = 'https://dormouse.sh/changelog/';
const SECURITY_URL = 'https://dormouse.sh/security/';
const DOWNLOAD_URL = 'https://dormouse.sh/#download';

/** What About shows. `relay` is `loading` until the Burrow answers, and `null` where there is none to ask. */
export interface AboutFacts {
  host: AboutHost | undefined;
  stamp: BuildStamp | null;
  relay: { mode: RelayMode; origin: string } | 'loading' | null;
}

const KIND_LABEL: Record<InstallKind, string> = {
  official: 'Official release',
  development: 'Development build',
  'self-host': 'Self-host build',
  playground: 'Web playground',
};

const HOST_LABEL: Record<AboutHost, string> = {
  standalone: 'Desktop app',
  vscode: 'VS Code extension',
  playground: 'Website',
};

/** `null` while a self-host build could still be the answer. */
function kindOf(facts: AboutFacts): InstallKind | null {
  if (facts.relay === 'loading' && facts.host !== 'playground') return null;
  const mode = facts.relay === 'loading' || facts.relay === null ? null : facts.relay.mode;
  return installKind(facts.host, facts.stamp, mode);
}

function versionLine(stamp: BuildStamp | null): string {
  return stamp ? `Dormouse ${buildTag(stamp)}` : 'Dormouse, version unknown';
}

function commitLine(stamp: BuildStamp): string {
  return stamp.dirty ? `${stamp.commit}, with uncommitted changes` : stamp.commit;
}

/**
 * The plain text Copy puts on the clipboard, for a bug report. Built only on
 * click, never rendered: the Settings search indexes rendered text, and a
 * user agent would make About match half the words anyone types.
 */
export function aboutDiagnostics(
  facts: AboutFacts,
  env: { platform: string; userAgent: string } = {
    platform: PLATFORM_STRING,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  },
): string {
  const kind = kindOf(facts);
  const lines = [
    facts.stamp ? `${versionLine(facts.stamp)} (${commitLine(facts.stamp)})` : versionLine(null),
    `Install: ${kind ? KIND_LABEL[kind] : 'unknown'}`,
  ];
  if (facts.host) lines.push(`Host: ${HOST_LABEL[facts.host]}`);
  if (facts.relay && facts.relay !== 'loading') lines.push(`Relay: ${hostOf(facts.relay.origin)} (${facts.relay.mode})`);
  lines.push(`OS: ${env.platform}`, `User agent: ${env.userAgent}`);
  return `${lines.join('\n')}\n`;
}

function explanation(kind: InstallKind, facts: AboutFacts): string {
  switch (kind) {
    case 'official':
      return `Built by Dormouse’s release pipeline from tag v${facts.stamp!.version}.`;
    case 'development':
      return 'Built from source rather than by Dormouse’s release pipeline, so it may differ from any release.';
    case 'self-host': {
      const relay = facts.relay !== null && facts.relay !== 'loading' ? hostOf(facts.relay.origin) : 'your Relay';
      return `Built from source to reach only ${relay}. It never updates itself; rebuild it to update.`;
    }
    case 'playground':
      return 'Simulated terminals running in your browser. Nothing here runs on your computer.';
  }
}

function sourceRef(stamp: BuildStamp | null): string | null {
  if (!stamp) return null;
  return stamp.official ? `v${stamp.version}` : stamp.commit;
}

/** About, from facts alone — what the stories and tests render. */
export function AboutPanel({ facts }: { facts: AboutFacts }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timeout);
  }, [copied]);

  const kind = kindOf(facts);
  const ref = sourceRef(facts.stamp);
  const links: Array<[string, string]> = [
    ...(kind === 'playground' ? [['Download Dormouse', DOWNLOAD_URL] as [string, string]] : []),
    ['Changelog', CHANGELOG_URL],
    ['Source', ref ? `${REPO_URL}/tree/${ref}` : REPO_URL],
    ['License', `${REPO_URL}/blob/${ref ?? 'main'}/LICENSE`],
    ['Security', SECURITY_URL],
  ];

  return (
    <div className="mt-2 text-sm leading-relaxed">
      <div className="text-foreground">{versionLine(facts.stamp)}</div>
      <div className="text-muted">
        {kind ? KIND_LABEL[kind] : '…'}
        {facts.stamp ? <> · {commitLine(facts.stamp)}</> : null}
        {facts.host && kind !== 'playground' ? <> · {HOST_LABEL[facts.host]}</> : null}
      </div>
      {kind ? <div className="mt-1 text-muted">{explanation(kind, facts)}</div> : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="text-muted">
          {links.map(([label, href], index) => (
            <Fragment key={label}>
              {index > 0 ? ' · ' : null}
              <ExternalTextLink href={href}>{label}</ExternalTextLink>
            </Fragment>
          ))}
        </div>
        <button
          type="button"
          className={`${modalActionButton({ tone: 'secondary' })} flex items-center gap-1.5`}
          onClick={async () => {
            if (await writeTextToClipboard(aboutDiagnostics(facts))) setCopied(true);
          }}
        >
          <ClipboardTextIcon size={14} weight="bold" />
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </div>
  );
}

function relayFact(state: BurrowStatusState): AboutFacts['relay'] {
  switch (state.kind) {
    case 'loading':
      return 'loading';
    case 'ready':
      return { mode: state.status.relayMode, origin: state.status.relayOrigin };
    // No Burrow (the website), or none that answered: no relay to name.
    case 'unsupported':
    case 'error':
      return null;
  }
}

/** Settings → About for this window's build (`docs/specs/deploy.md` → "Build stamp"). */
export function AboutSettings() {
  // The relay mode comes from the Burrow, never the webview's own bundle: the
  // VS Code webview is built without the relay define.
  const burrow = useSyncExternalStore(subscribeToBurrowStatus, getBurrowStatusSnapshot);
  return <AboutPanel facts={{ host: getPlatform().aboutHost, stamp: readBuildStamp(), relay: relayFact(burrow) }} />;
}
