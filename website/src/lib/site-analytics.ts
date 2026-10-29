/**
 * Visit analytics for dormouse.sh: PostHog in cookieless mode, sent through
 * the site's own `/ingest` path (`public/_worker.js`), and only the events
 * below. docs/specs/website-docs.md -> "Visit analytics" is the contract;
 * Privacy says the same to visitors.
 *
 * Nothing here runs until the first event, and then only on dormouse.sh
 * itself, with neither Global Privacy Control nor Do Not Track set: otherwise
 * PostHog is never even downloaded. The import is the slim, no-external build,
 * so autocapture, replay, surveys, and the rest are not in the bundle at all,
 * and it never loads a script from anywhere.
 */
import type { PostHog, PostHogConfig } from "posthog-js/dist/module.slim.no-external.js";
import type { HostedRef } from "dormouse-lib/lib/hosted-links";
import type { TutorialState } from "./tutorial-state";
import type { Tier } from "./hosted-pricing";

/** PostHog's public project key: public by design, it only lets a page send. */
export const POSTHOG_PROJECT_KEY = "phc_AxHDxNuQ9uGy5AmejhxcZz3vNUPwZY2WgmCgW6WgNkTU";

/** The only host that counts: a dev server or a Pages preview sends nothing. */
export const ANALYTICS_HOSTNAME = "dormouse.sh";

/**
 * Every option chosen, not defaulted, so a posthog-js bump that changes a
 * default changes nothing here. `cookieless_mode: "always"` is what keeps
 * PostHog out of cookies and storage (it counts visitors with a daily hash
 * on its servers, and the project setting must be on or it drops the events);
 * `person_profiles: "never"` makes `identify` a no-op.
 */
export const POSTHOG_CONFIG: Partial<PostHogConfig> = {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-08-30",
  cookieless_mode: "always",
  disable_persistence: true,
  persistence: "memory",
  person_profiles: "never",
  internal_or_test_user_hostname: null,
  capture_pageview: false,
  capture_pageleave: false,
  autocapture: false,
  rageclick: false,
  capture_dead_clicks: false,
  capture_heatmaps: false,
  capture_exceptions: false,
  capture_performance: false,
  capture_webmcp: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,
  disable_external_dependency_loading: true,
  advanced_disable_flags: true,
  save_campaign_params: false,
  disable_scroll_properties: true,
};

/** What a route module may export as `handle`: `ownPageview` when it calls `trackPageview` itself. */
export type SiteRouteHandle = { ownPageview?: boolean };

/** The named events, and nothing else. */
export type SiteEvent =
  | { name: "hosted plan clicked"; plan: Tier["id"] }
  | { name: "tutorial completed"; tutorial: "desktop" | "pocket" };

type PrivacySignals = { globalPrivacyControl?: boolean; doNotTrack?: string | null };

/** False when the visitor's browser sends Global Privacy Control or Do Not Track. */
export function analyticsAllowed(nav: PrivacySignals = navigator): boolean {
  return nav.globalPrivacyControl !== true && nav.doNotTrack !== "1";
}

let client: Promise<PostHog | null> | null = null;

function posthog(): Promise<PostHog | null> {
  client ??=
    typeof window === "undefined" || location.hostname !== ANALYTICS_HOSTNAME || !analyticsAllowed()
      ? Promise.resolve(null)
      : import("posthog-js/dist/module.slim.no-external.js").then(
          ({ default: ph }) => {
            ph.init(POSTHOG_PROJECT_KEY, POSTHOG_CONFIG);
            return ph;
          },
          () => null,
        );
  return client;
}

/** One pageview of the current address, with the Hosted page's `ref` when it has one. */
export function trackPageview(ref?: HostedRef | "other" | null): void {
  void posthog().then((ph) => ph?.capture("$pageview", ref ? { ref } : undefined));
}

export function trackEvent({ name, ...properties }: SiteEvent): void {
  void posthog().then((ph) => ph?.capture(name, properties));
}

/**
 * Sends `tutorial completed` when this visit checks the last item; a tutorial
 * finished on an earlier visit, its progress restored, sends nothing.
 */
export function trackTutorialCompletion(state: TutorialState, tutorial: "desktop" | "pocket"): () => void {
  const finished = () => {
    const { done, total } = state.totalProgress();
    return total > 0 && done === total;
  };
  let wasFinished = finished();
  return state.subscribe(() => {
    const now = finished();
    if (now && !wasFinished) trackEvent({ name: "tutorial completed", tutorial });
    wasFinished = now;
  });
}
