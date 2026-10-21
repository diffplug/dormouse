// An in-memory filesystem keyed by exact path, recording every path a call
// reaches, so a test can show a share was refused before anything touched it.
export function fakeFs(entries) {
  const reached = [];
  const find = (path) => {
    reached.push(path);
    const entry = entries[path];
    if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return entry;
  };
  const stats = (entry) => ({
    isSymbolicLink: () => 'link' in entry,
    isDirectory: () => entry.dir === true,
    isFile: () => 'file' in entry,
  });
  return {
    reached,
    lstat: async (path) => stats(find(path)),
    readlink: async (path) => {
      const entry = find(path);
      if (!('link' in entry)) throw Object.assign(new Error(`EINVAL: ${path}`), { code: 'EINVAL' });
      return entry.link;
    },
    readdir: async (path) => {
      find(path);
      const prefix = path.endsWith('\\') || path.endsWith('/') ? path : `${path}${path.includes('\\') ? '\\' : '/'}`;
      return Object.keys(entries).filter(key => key.startsWith(prefix) && !/[\\/]/.test(key.slice(prefix.length))).map(key => key.slice(prefix.length));
    },
    readFile: async (path, limit) => {
      const entry = find(path);
      if (!('file' in entry) || entry.file.length > limit) throw new Error(`unreadable: ${path}`);
      return entry.file;
    },
  };
}

export const dir = { dir: true };
export const file = (contents = '') => ({ file: contents });
export const link = (target) => ({ link: target });

/** True for a path a share or device spelling would reach. */
export const isShare = (path) => /^[\\/]{2}/.test(path);
