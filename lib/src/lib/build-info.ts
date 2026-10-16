/**
 * Which build this webview is, for Settings → About
 * (`docs/specs/deploy.md` → "Build stamp"). **Display only**: the stamp's
 * inputs are environment variables anyone building from source can set, so
 * nothing may decide trust, updates, or features from it.
 */

import type { VersionMetadata } from 'dor/commands/types';

/** The hosts a stamped bundle is built for; the website's is its desktop playground. */
export type AboutHost = 'standalone' | 'vscode' | 'playground';

/** Written by `buildStampVitePlugin` in `scripts/build-stamp.mjs`. */
export interface BuildStamp extends VersionMetadata {
  /** The tree had uncommitted or untracked changes. */
  dirty: boolean;
  /** Built by release.yml from the version tag, at its commit, from a clean tree. */
  official: boolean;
  host: AboutHost;
}

/** Substituted by `buildStampVitePlugin`; absent from lib's own builds, Storybook, and tests. */
declare const __DORMOUSE_BUILD__: BuildStamp | undefined;

export function readBuildStamp(): BuildStamp | null {
  return typeof __DORMOUSE_BUILD__ === 'undefined' ? null : __DORMOUSE_BUILD__;
}
