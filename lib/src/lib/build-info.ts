/**
 * Which build this webview is, for Settings → About
 * (`docs/specs/deploy.md` → "Build stamp"). **Display only**: the stamp's
 * inputs are environment variables anyone building from source can set, so
 * nothing may decide trust, updates, or features from it.
 */

import type { RelayMode } from '../host/relay-origin';
import type { AboutHost } from './platform/types';

/** Written by `computeBuildStamp` in `scripts/build-stamp.mjs`. */
export interface BuildStamp {
  /** The latest released version in `CHANGELOG.md`. */
  version: string;
  /** Short commit hash. */
  commit: string;
  /** Commits past the version tag, or `null` where the tag could not be resolved. */
  commitsSinceVersion: number | null;
  /** The tree had uncommitted or untracked changes. */
  dirty: boolean;
  /** Built by release.yml from the version tag, at its commit, from a clean tree. */
  official: boolean;
}

/** Substituted by `buildStampVitePlugin`; absent from lib's own builds, Storybook, and tests. */
declare const __DORMOUSE_BUILD__: unknown;

export function readBuildStamp(): BuildStamp | null {
  const raw = typeof __DORMOUSE_BUILD__ === 'undefined' ? undefined : __DORMOUSE_BUILD__;
  return isBuildStamp(raw) ? raw : null;
}

function isBuildStamp(value: unknown): value is BuildStamp {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'string' &&
    typeof v.commit === 'string' &&
    (v.commitsSinceVersion === null || typeof v.commitsSinceVersion === 'number') &&
    typeof v.dirty === 'boolean' &&
    typeof v.official === 'boolean'
  );
}

/** `1.2.0`, `1.2.0+14` past the tag, or `1.2.0+?` where the count is unknown — the form `dor version` prints. */
export function buildTag(stamp: BuildStamp): string {
  if (stamp.commitsSinceVersion === null) return `${stamp.version}+?`;
  return stamp.commitsSinceVersion > 0 ? `${stamp.version}+${stamp.commitsSinceVersion}` : stamp.version;
}

export type InstallKind = 'playground' | 'self-host' | 'official' | 'development';

/**
 * A self-host build is always built from source, so it names itself as such
 * ahead of official or not; anything short of a stamped official build reads
 * as development.
 */
export function installKind(host: AboutHost | undefined, stamp: BuildStamp | null, relayMode: RelayMode | null): InstallKind {
  if (host === 'playground') return 'playground';
  if (relayMode === 'self-host') return 'self-host';
  return stamp?.official ? 'official' : 'development';
}
