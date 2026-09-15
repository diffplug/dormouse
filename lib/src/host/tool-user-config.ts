import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseToolFile, type ToolFile } from './tool-registry';
import { readToolFile } from './tool-trust';

export function userToolConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'dormouse', 'dormouse.yml');
}

export async function readUserToolFile(path: string): Promise<ToolFile | null> {
  try {
    return parseToolFile(await readToolFile(path), { path, dir: dirname(path), scope: 'user' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
