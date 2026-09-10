/**
 * Seats left in the open founding cohort.
 *
 * Read from the server, which reads the billing provider and holds the cache;
 * never derived here and never persisted. A count computed on the client is a
 * count a reader can edit, and a stored one outlives the cohort it describes
 * (docs/specs/pricing.md -> The Hosted page).
 *
 * Every failure — offline, 404 before the endpoint is deployed, a non-2xx, a
 * body that is not the shape below — returns `null`, and the table renders
 * without counts rather than showing an error. The prices beside them are
 * prerendered, so a provider outage costs the page nothing it sells.
 */
import { type CohortId } from "./hosted-pricing";

/** Where the counts come from. Not deployed until checkout ships. */
export const COHORT_SEATS_ENDPOINT = "/api/hosted/cohorts";

/** Seats remaining in each ladder's open cohort. */
export type CohortSeats = Partial<Record<CohortId, number>>;

const COHORT_IDS: readonly CohortId[] = ["founding-annual", "founding-permanent"];

/** A whole, non-negative seat count, or nothing. */
function seatCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function fetchCohortSeats(signal?: AbortSignal): Promise<CohortSeats | null> {
  try {
    const response = await fetch(COHORT_SEATS_ENDPOINT, { signal, headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const seats: CohortSeats = {};
    for (const id of COHORT_IDS) {
      const count = seatCount((body as Record<string, unknown>)[id]);
      if (count !== undefined) seats[id] = count;
    }
    // An empty object would render as "no counts" anyway, but saying so with
    // `null` keeps one meaning for "there is nothing to show".
    return Object.keys(seats).length > 0 ? seats : null;
  } catch {
    return null;
  }
}
