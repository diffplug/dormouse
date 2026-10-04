// One disclosure row per package rather than per release
// (docs/specs/security-supply-chain.md -> "Disclosure").

/** Orders release versions numerically part by part, so 0.10 follows 0.9. */
export function compareVersions(a, b) {
  const partsA = a.split(/[.+-]/);
  const partsB = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const [x, y] = [partsA[i], partsB[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Merges releases into rows: one row per name and license, whose `versions`
 * lists every release oldest first. A license change between releases keeps
 * separate rows, since one row cannot state two licenses. Author and homepage
 * come from the newest release that names them — a crate that dropped Cargo's
 * deprecated `authors` field keeps the people its older releases named.
 * `groupBy` names further fields a merged row must agree on.
 */
export function mergeReleases(releases, groupBy = []) {
  const groups = Map.groupBy(releases, (release) =>
    [release.name, release.license ?? "", ...groupBy.map((field) => release[field] ?? "")].join("\0"));
  return [...groups.values()].map((group) => {
    const newestFirst = [...group].sort((a, b) => compareVersions(b.version, a.version));
    const { version: _version, ...newest } = newestFirst[0];
    return {
      ...newest,
      versions: [...new Set(newestFirst.map((release) => release.version))].reverse(),
      author: newestFirst.find((release) => release.author)?.author ?? null,
      homepage: newestFirst.find((release) => release.homepage)?.homepage ?? null,
    };
  });
}
