// Shell integration reports Git Bash directories as `/c/...` (a drive root
// is `/c`), while the CLI sends native Windows paths. Share the comparison
// between CLI discovery and the renderer's command/Tool reuse checks.
function canonicalizeCwdForMatch(path: string): string {
  const withDrive = path.replace(/^\/([A-Za-z])(?:\/|$)/, (_match, drive: string) => `${drive}:/`);
  if (!/^[A-Za-z]:[\\/]/.test(withDrive)) return path;
  const unified = withDrive.replace(/\//g, '\\');
  return unified.charAt(0).toUpperCase() + unified.slice(1);
}

/** Compare reported cwds after folding MSYS drive paths, slash direction and
 * drive-letter case. Missing paths never match. Directory-name case and
 * symlinks remain distinct; the caller resolves relative paths beforehand. */
export function cwdPathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalizeCwdForMatch(a) === canonicalizeCwdForMatch(b);
}
