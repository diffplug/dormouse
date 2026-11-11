/** Host-owned auxiliary identity survives live renderer reconnection. */
export interface HelperIdentity { parentId: string }
export type TerminalContextRequest =
  | { op: 'info'; id: string }
  | { op: 'promote'; id: string; restore?: HelperIdentity }
  | { op: 'openDirectory'; id: string; path: string }
  | { op: 'home' };
/** Each operation fills only the fields it answers. */
export interface TerminalContextInfo {
  error?: string;
  /** `home`: the host's home directory. */
  home?: string;
  /** `home`: the host machine's name, for telling a local OSC 7 from a remote one. */
  hostname?: string;
  /** `info`: null means inspection failed; never treat that as idle. */
  busy?: boolean | null;
}
