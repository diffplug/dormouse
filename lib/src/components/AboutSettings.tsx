import { ClipboardTextIcon } from '@phosphor-icons/react';
import { Fragment, useSyncExternalStore } from 'react';
import { buildTag } from 'dor/commands/terminal-text';
import { CopyButton } from './CopyButton';
import { ExternalTextLink } from './ExternalTextLink';
import { modalActionButton } from './design';
import { hostOf } from './remote-control-shared';
import { readBuildStamp, type AboutHost, type BuildStamp } from '../lib/build-info';
import { PLATFORM_STRING } from '../lib/platform';
import type { RelayBuild } from '../host/relay-origin';
import { getBurrowStatusSnapshot, subscribeToBurrowStatus, type BurrowStatusState } from '../remote/burrow/burrow-status-store';

const REPO_URL = 'https://github.com/diffplug/dormouse';
const CHANGELOG_URL = 'https://dormouse.sh/changelog/';
const SECURITY_URL = 'https://dormouse.sh/security/';
const DOWNLOAD_URL = 'https://dormouse.sh/#download';

/** What About shows. `relay` is `loading` until the Burrow answers, and `null` where there is none to ask. */
export interface AboutFacts {
  stamp: BuildStamp | null;
  relay: RelayBuild | 'loading' | null;
}

type InstallKind = 'playground' | 'self-host' | 'official' | 'development';

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

/**
 * A self-host build is always built from source, so it names itself as such
 * ahead of official or not; anything short of a stamped official build reads
 * as development. `null` while a self-host build could still be the answer.
 */
function kindOf({ stamp, relay }: AboutFacts): InstallKind | null {
  if (stamp?.host === 'playground') return 'playground';
  if (relay === 'loading') return null;
  if (relay?.mode === 'self-host') return 'self-host';
  return stamp?.official ? 'official' : 'development';
}

function versionLine(stamp: BuildStamp | null): string {
  return stamp ? `Dormouse version ${buildTag(stamp)}` : 'Dormouse, version unknown';
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
  const { stamp, relay } = facts;
  const kind = kindOf(facts);
  const lines = [
    stamp ? `${versionLine(stamp)} (${commitLine(stamp)})` : versionLine(null),
    `Install: ${kind ? KIND_LABEL[kind] : 'unknown'}`,
  ];
  if (stamp) lines.push(`Host: ${HOST_LABEL[stamp.host]}`);
  if (relay && relay !== 'loading') lines.push(`Relay: ${hostOf(relay.origin)} (${relay.mode})`);
  lines.push(`OS: ${env.platform}`, `User agent: ${env.userAgent}`);
  return `${lines.join('\n')}\n`;
}

function explanation(kind: InstallKind, { stamp, relay }: AboutFacts): string {
  switch (kind) {
    case 'official':
      return `Built by Dormouse’s release pipeline from tag v${stamp!.version}.`;
    case 'development':
      return 'Built from source rather than by Dormouse’s release pipeline, so it may differ from any release.';
    case 'self-host':
      return `Built from source to reach only ${hostOf((relay as RelayBuild).origin)}. It never updates itself; rebuild it to update.`;
    case 'playground':
      return 'Simulated terminals running in your browser. Nothing here runs on your computer.';
  }
}

/** About from facts alone, which the unit tests render. */
export function AboutPanel({ facts }: { facts: AboutFacts }) {
  const { stamp } = facts;
  const kind = kindOf(facts);
  const ref = stamp ? (stamp.official ? `v${stamp.version}` : stamp.commit) : null;
  const links: Array<[string, string]> = [
    ...(kind === 'playground' ? [['Download Dormouse', DOWNLOAD_URL] as [string, string]] : []),
    ['Changelog', CHANGELOG_URL],
    ['Source', ref ? `${REPO_URL}/tree/${ref}` : REPO_URL],
    ['License', `${REPO_URL}/blob/${ref ?? 'main'}/LICENSE`],
    ['Security', SECURITY_URL],
  ];

  return (
    <div className="mt-2 text-sm leading-relaxed">
      <div className="text-foreground">{versionLine(stamp)}</div>
      <div className="text-muted">
        {kind ? KIND_LABEL[kind] : '…'}
        {stamp ? <> · {commitLine(stamp)}</> : null}
        {stamp && kind !== 'playground' ? <> · {HOST_LABEL[stamp.host]}</> : null}
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
        <CopyButton
          text={() => aboutDiagnostics(facts)}
          label="Copy details"
          icon={<ClipboardTextIcon size={14} weight="bold" />}
          className={`${modalActionButton({ tone: 'secondary' })} flex items-center gap-1.5`}
        />
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
  return <AboutPanel facts={{ stamp: readBuildStamp(), relay: relayFact(burrow) }} />;
}
