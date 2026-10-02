/**
 * The founding card's live half: seats left in the open cohort, and the row of
 * founders who chose to be shown.
 *
 * Read from the server, which reads the billing provider and holds the cache;
 * never derived here and never persisted. A count computed on the client is a
 * count a reader can edit, and a stored one outlives the cohort it describes
 * (docs/specs/pricing.md -> The Hosted page).
 *
 * Every failure — offline, 404 before the endpoint is deployed, a non-2xx, a
 * body that is not the shape below — drops the part it spoils, and the card
 * renders without it rather than showing an error. The price beside them is
 * prerendered, so a provider outage costs the page nothing it sells.
 */

/** Where both come from, in one request. Not deployed until checkout ships. */
export const COHORT_ENDPOINT = "/api/hosted/cohorts";

/** The most avatars the row draws; every other founder joins the `+N`. */
export const MAX_SHOWN_FOUNDERS = 40;

/** A founder who opted in at checkout. */
export type Founder = {
  name: string;
  /** A path on this origin, or absent: the row then draws the initial. */
  avatar?: string;
};

export type Founders = {
  /** Every founding buyer, shown or not. */
  total: number;
  shown: Founder[];
};

export type Cohort = {
  seatsLeft: number | null;
  founders: Founders | null;
};

/** A whole, non-negative count, or nothing. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Only a path the Hosted origin serves. The server proxies each avatar so a
 * reader's browser never asks GitHub or Google about this page; a provider URL
 * reaching the client is a server bug, and drawing the initial keeps it from
 * becoming a leak.
 */
function sameOriginPath(value: unknown): string | undefined {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : undefined;
}

function founder(value: unknown): Founder | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, avatar } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return undefined;
  const path = sameOriginPath(avatar);
  return path ? { name: name.trim(), avatar: path } : { name: name.trim() };
}

function founders(value: unknown): Founders | null {
  if (typeof value !== "object" || value === null) return null;
  const { total, shown } = value as Record<string, unknown>;
  const all = count(total);
  if (all === undefined || all === 0 || !Array.isArray(shown)) return null;
  const valid = shown
    .map(founder)
    .filter((f): f is Founder => f !== undefined)
    .slice(0, Math.min(MAX_SHOWN_FOUNDERS, all));
  return { total: all, shown: valid };
}

export async function fetchCohort(signal?: AbortSignal): Promise<Cohort> {
  try {
    const response = await fetch(COHORT_ENDPOINT, { signal, headers: { accept: "application/json" } });
    if (!response.ok) return { seatsLeft: null, founders: null };
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return { seatsLeft: null, founders: null };
    const fields = body as Record<string, unknown>;
    return { seatsLeft: count(fields.seatsLeft) ?? null, founders: founders(fields.founders) };
  } catch {
    return { seatsLeft: null, founders: null };
  }
}
