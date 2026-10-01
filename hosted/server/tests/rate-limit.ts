import { expect } from "vitest";
import { wrangler } from "./bundle";

/** The `limit` of the rate-limit binding `name`, from whichever Hosted config declares it. */
export function limitOf(name: string) {
  const binding = Object.values(wrangler)
    .flatMap(({ ratelimits }) => ratelimits ?? [])
    .find((binding) => binding.name === name);
  if (!binding) throw new Error(`no rate limit named ${name}`);
  return binding.simple.limit;
}

/**
 * Sends `send(0)`, `send(1)`, … from one caller until the first 429, and
 * returns it. A `simple` rate limit counts in fixed windows on the wall clock,
 * so a run can admit up to twice `limit` when it straddles a boundary; a fast
 * loop straddles at most one, so the 429 must arrive after at least `limit`
 * admitted and within `2 * limit + 1` sends, whatever the window alignment.
 * `send` checks its own admitted answers.
 */
export async function untilLimited<R extends { status: number }>(
  limit: number,
  send: (i: number) => Promise<R>,
): Promise<R> {
  for (let i = 0; i <= 2 * limit; i++) {
    const response = await send(i);
    if (response.status === 429) {
      expect(i, "admitted before the first 429").toBeGreaterThanOrEqual(limit);
      return response;
    }
  }
  throw new Error(`no 429 in ${2 * limit + 1} sends against a limit of ${limit}`);
}
