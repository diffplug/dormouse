/** Host-owned auxiliary identity survives live renderer reconnection. */
export interface HelperIdentity { parentId: string; command: string }
/** Factory autorun: none, until the user saves a command. */
export const DEFAULT_HELPER_COMMAND = '';
/** What the Modify dialog offers to fill in. Never a default: `git status`
 *  opens the index, which runs what that repository's config names. */
export const SUGGESTED_HELPER_COMMAND = 'git status';
export type TerminalContextRequest =
  | { op: 'info'; id: string }
  | { op: 'promote'; id: string; restore?: HelperIdentity }
  | { op: 'openDirectory'; id: string; path: string }
  | { op: 'settings'; command?: string };
/** Each operation fills only the fields it answers. */
export interface TerminalContextInfo {
  error?: string;
  /** `settings`: the host's home directory and the global autorun command. */
  home?: string;
  command?: string;
  /** `info`: null means inspection failed; never treat that as idle. */
  busy?: boolean | null;
}
