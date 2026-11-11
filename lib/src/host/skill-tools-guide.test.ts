import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TerminalProtocolParser } from '../lib/terminal-protocol';
import { parseToolFile } from './tool-registry';

/** `dor skill tools`: what it tells a Tool author to type must be what the
 *  host accepts, so the guide cannot drift from the parsers. */
const guide = readFileSync(new URL('../../../dor/skill-tools.md', import.meta.url), 'utf8');
const PORT = 5173;

/** Every `printf '<format>'` in the guide, as the bytes `printf` writes with
 *  `$PORT` as its one argument. Only the escapes the guide uses are known, so
 *  a new one fails here rather than passing untested. */
const printed = [...guide.matchAll(/printf '([^']*)'/g)].map(([, format]) => {
  const bytes = format.replace(/\\033|\\007|%s/g, escape => ({ '\\033': '\x1b', '\\007': '\x07', '%s': String(PORT) })[escape]!);
  if (bytes.includes('\\') || bytes.includes('%')) throw new Error(`unknown printf escape in ${format}`);
  return bytes;
});

/** The verb and JSON object the bytes carry, read without the host's parser. */
function sent(bytes: string): { verb: string; payload: Record<string, unknown> } {
  const match = /^\x1b\]367;(\w+);(.*)\x07$/s.exec(bytes);
  if (!match) throw new Error(`not one OSC 367 sequence: ${JSON.stringify(bytes)}`);
  return { verb: match[1], payload: JSON.parse(match[2]) as Record<string, unknown> };
}

describe('the OSC 367 sequences dor skill tools prints', () => {
  it('names one of each verb', () => {
    expect(new Set(printed.map(bytes => sent(bytes).verb))).toEqual(new Set(['serve', 'state', 'open', 'dehydrate']));
  });

  it.each(printed)('the PTY parser accepts %j whole', bytes => {
    const { verb, payload } = sent(bytes);
    const result = new TerminalProtocolParser().process(`before${bytes}after`);
    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    switch (verb) {
      case 'serve':
        expect(event).toMatchObject({ kind: 'toolAnnounce', announce: { port: PORT, dehydrate: payload.dehydrate === true } });
        // An invalid path is dropped, not refused: check it survived.
        expect(event.kind === 'toolAnnounce' ? event.announce.path : null).toBe(payload.path);
        break;
      case 'state':
        expect(event).toEqual({ kind: 'toolState', state: { dirty: payload.dirty } });
        break;
      case 'open':
        expect(event).toEqual({ kind: 'toolOpen', open: { path: payload.path, preview: payload.preview === true } });
        break;
      case 'dehydrate':
        expect(event).toEqual({ kind: 'toolDehydrate', dehydrate: { payload: JSON.stringify(payload) } });
        break;
      default:
        throw new Error(`unexpected verb ${verb}`);
    }
  });
});

describe('the dormouse.yml examples dor skill tools prints', () => {
  const examples = [...guide.matchAll(/```yaml\n(.*?)```/gs)].map(([, text]) => text);

  it('has both the declaration and the import', () => {
    expect(examples).toHaveLength(2);
  });

  it.each(examples)('parses as a user file without warnings: %s', text => {
    const file = parseToolFile(text, { path: '/home/me/.config/dormouse/dormouse.yml', dir: '/home/me/.config/dormouse', scope: 'user' });
    expect(file.warnings).toEqual([]);
    expect(file.names).toHaveLength(1);
    const [name] = file.names;
    expect(file.tools.get(name)?.description ?? file.imports.get(name)?.description).toBeTruthy();
  });
});
