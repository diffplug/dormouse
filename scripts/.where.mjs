import { readFileSync } from 'node:fs';
import { parseMarkdown } from './md-unwrap.mjs';
const f = process.argv[2]; const text = readFileSync(f, 'utf8');
try { parseMarkdown(text, true); console.log('OK'); }
catch (e) { const p = e.place?.start ?? e.place; const line = text.split('\n')[p.line - 1]; console.log(`${p.line}:${p.column}`, JSON.stringify(line.slice(Math.max(0, p.column - 50), p.column + 40)), e.message.slice(0, 60)); }
