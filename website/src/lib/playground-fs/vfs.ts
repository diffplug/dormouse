/**
 * The desktop playground's read-only filesystem (docs/specs/tutorial.md ->
 * Playground filesystem): a fixed tree of text files, POSIX paths only.
 */

import { byDisplayOrder } from "dor-tools-builtin/folder-viewer-page";

export const HOME = "/home/demo";

/** The playground's own user config, beside the snapshot: shown, never read for rules. */
export const USER_CONFIG = `${HOME}/.config/dormouse/dormouse.yml`;

export type EntryKind = "dir" | "file";
export interface DirEntry { name: string; kind: EntryKind }

type FsNode = { kind: "dir"; children: Map<string, FsNode> } | { kind: "file"; text: string };

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

export class VirtualFs {
  private readonly root: FsNode = { kind: "dir", children: new Map() };

  /** `files` maps an absolute path to its text; parent directories are implied. */
  constructor(files: Record<string, string>) {
    this.mkdir(HOME);
    for (const [path, text] of Object.entries(files)) {
      const normalized = normalizePath(path);
      const slash = normalized.lastIndexOf("/");
      const parent = this.mkdir(normalized.slice(0, slash));
      parent.children.set(normalized.slice(slash + 1), { kind: "file", text });
    }
  }

  private mkdir(path: string): Extract<FsNode, { kind: "dir" }> {
    let node = this.root as Extract<FsNode, { kind: "dir" }>;
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      let child = node.children.get(part);
      if (!child) node.children.set(part, child = { kind: "dir", children: new Map() });
      if (child.kind !== "dir") throw new Error(`not a directory: ${path}`);
      node = child;
    }
    return node;
  }

  private node(path: string): FsNode | undefined {
    let node: FsNode | undefined = this.root;
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      node = node?.kind === "dir" ? node.children.get(part) : undefined;
    }
    return node;
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
    return this.node(path)?.kind ?? null;
  }

  read(path: string): string | null {
    const node = this.node(path);
    return node?.kind === "file" ? node.text : null;
  }

  /** A directory's entries in the folder viewer's order, or null when `path` is not one. */
  list(path: string): DirEntry[] | null {
    const node = this.node(path);
    if (node?.kind !== "dir") return null;
    return [...node.children]
      .map(([name, child]) => ({ dir: child.kind === "dir", folded: name.toLowerCase(), entry: { name, kind: child.kind } }))
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
