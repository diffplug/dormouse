/**
 * The desktop playground's filesystem (docs/specs/tutorial.md -> Playground
 * filesystem): a copy-on-write overlay over a stock tree, POSIX paths only.
 * The stock tree is built once and never written; each `VirtualFs` keeps its
 * own writes in memory, so a page refresh drops them.
 */

import { byDisplayOrder } from "dor-tools-builtin/folder-viewer-page";

export const HOME = "/home/demo";

/** The playground's own user config, beside the snapshot: shown, never read for rules. */
export const USER_CONFIG = `${HOME}/.config/dormouse/dormouse.yml`;

export type EntryKind = "dir" | "file";
export interface DirEntry { name: string; kind: EntryKind }
/** A file's contents: text, or bytes for a binary file such as a pasted image. */
export type FileData = string | Uint8Array;

type Dir = { kind: "dir"; children: Map<string, FsNode> };
type FsNode = Dir | { kind: "file"; data: FileData };

/** An overlay entry hiding a stock file renamed away. */
const WHITEOUT = Symbol("whiteout");

/** `path` with `.`, `..`, and repeated slashes resolved; `..` stops at `/`. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The immutable tree every window's overlay sits on. */
export class StockTree {
  private readonly root: Dir = { kind: "dir", children: new Map() };

  /** `files` maps an absolute path to its contents; parent directories are implied. */
  constructor(files: Record<string, FileData>) {
    this.mkdir(HOME);
    for (const [path, data] of Object.entries(files)) {
      const normalized = normalizePath(path);
      this.mkdir(parentOf(normalized)).children.set(nameOf(normalized), { kind: "file", data });
    }
  }

  private mkdir(path: string): Dir {
    let node = this.root;
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      let child = node.children.get(part);
      if (!child) node.children.set(part, child = { kind: "dir", children: new Map() });
      if (child.kind !== "dir") throw new Error(`not a directory: ${path}`);
      node = child;
    }
    return node;
  }

  /** The node at the normalized `path`, which callers must not mutate. */
  node(path: string): FsNode | undefined {
    let node: FsNode | undefined = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      node = node?.kind === "dir" ? node.children.get(part) : undefined;
    }
    return node;
  }
}

export class VirtualFs {
  private readonly stock: StockTree;
  /** Files written or renamed away since the page loaded, by normalized path. */
  private readonly overlay = new Map<string, FileData | typeof WHITEOUT>();

  /** A fresh overlay on `stock`, or on a stock tree of `files`. */
  constructor(stock: StockTree | Record<string, FileData>) {
    this.stock = stock instanceof StockTree ? stock : new StockTree(stock);
  }

  /** `input` as an absolute path: `~` and `~/…` name the home directory, a
   * `file:` URL with no host or `localhost` names its path, and anything
   * else resolves against `cwd`. Null for any other URL. */
  resolve(cwd: string, input: string): string | null {
    if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
      let url: URL;
      try { url = new URL(input); } catch { return null; }
      if (url.protocol !== "file:" || url.hostname !== "") return null;
      try { return normalizePath(decodeURIComponent(url.pathname)); } catch { return null; }
    }
    if (input === "~" || input.startsWith("~/")) return normalizePath(HOME + input.slice(1));
    return normalizePath(input.startsWith("/") ? input : `${cwd}/${input}`);
  }

  kind(path: string): EntryKind | null {
    const normalized = normalizePath(path);
    const written = this.overlay.get(normalized);
    if (written !== undefined) return written === WHITEOUT ? null : "file";
    return this.stock.node(normalized)?.kind ?? null;
  }

  /** A file's contents as stored, or null when `path` is not a file. */
  data(path: string): FileData | null {
    const normalized = normalizePath(path);
    const written = this.overlay.get(normalized);
    if (written !== undefined) return written === WHITEOUT ? null : written;
    const node = this.stock.node(normalized);
    return node?.kind === "file" ? node.data : null;
  }

  /** A file's contents as text (bytes decode as UTF-8), or null when `path` is not a file. */
  read(path: string): string | null {
    const data = this.data(path);
    return data === null || typeof data === "string" ? data : new TextDecoder().decode(data);
  }

  /** A file's contents as bytes (text encodes as UTF-8), or null when `path` is not a file. */
  bytes(path: string): Uint8Array | null {
    const data = this.data(path);
    return data === null || typeof data !== "string" ? data : new TextEncoder().encode(data);
  }

  /** Creates or replaces the file `path`, whose directory must exist. */
  write(path: string, data: FileData): void {
    const normalized = normalizePath(path);
    if (this.kind(parentOf(normalized)) !== "dir") throw new Error(`no such directory: ${parentOf(normalized)}`);
    if (this.kind(normalized) === "dir") throw new Error(`is a directory: ${normalized}`);
    this.overlay.set(normalized, data);
  }

  /** Moves the file `from` to `to`, replacing any file there. */
  rename(from: string, to: string): void {
    const source = normalizePath(from);
    const data = this.data(source);
    if (data === null) throw new Error(`no such file: ${source}`);
    if (normalizePath(to) === source) return;
    this.write(to, data);
    if (this.stock.node(source)) this.overlay.set(source, WHITEOUT);
    else this.overlay.delete(source);
  }

  /** A directory's entries in the folder viewer's order, or null when `path` is not one. */
  list(path: string): DirEntry[] | null {
    const dir = normalizePath(path);
    const node = this.stock.node(dir);
    if (node?.kind !== "dir") return null;
    const kinds = new Map<string, EntryKind>([...node.children].map(([name, child]) => [name, child.kind]));
    for (const [written, data] of this.overlay) {
      if (written === dir || parentOf(written) !== dir) continue;
      if (data === WHITEOUT) kinds.delete(nameOf(written));
      else kinds.set(nameOf(written), "file");
    }
    return [...kinds]
      .map(([name, kind]) => ({ dir: kind === "dir", folded: name.toLowerCase(), entry: { name, kind } }))
      .sort(byDisplayOrder)
      .map(({ entry }) => entry);
  }

  /** `name` in `dir` extended through each directory holding one directory
   * and nothing else (`a/b/c`), as the folder viewer compacts chains. */
  compacted(dir: string, name: string): string {
    let display = name;
    let path = `${normalizePath(dir)}/${name}`.replace(/^\/\//, "/");
    for (let depth = 0; depth < 32; depth++) {
      const children = this.list(path);
      if (!children || children.length !== 1 || children[0].kind !== "dir") break;
      display += `/${children[0].name}`;
      path += `/${children[0].name}`;
    }
    return display;
  }

  /** Every file under `dir`, relative to it, `/`-separated, in display order;
   * dot-entries are skipped, as the picker skips them outside a work tree. */
  files(dir: string): string[] {
    const out: string[] = [];
    const walk = (path: string, prefix: string) => {
      for (const entry of this.list(path) ?? []) {
        if (entry.name.startsWith(".")) continue;
        const child = `${path === "/" ? "" : path}/${entry.name}`;
        if (entry.kind === "dir") walk(child, `${prefix}${entry.name}/`);
        else out.push(`${prefix}${entry.name}`);
      }
    };
    walk(normalizePath(dir), "");
    return out;
  }
}
