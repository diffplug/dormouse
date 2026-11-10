// ledger.mjs — the ledger of one audit pass: a directory outside the repository that holds the
// snapshot, the unit file lists and assignments, the reviewers' findings, the fix queues and logs,
// and the run records. Node built-ins only.
//
//   init --ledger <dir> --worktrees <dir> --base <ref> [--previous <older-ledger>]
//   units [--snapshot <dir>] [--out <dir>]         re-cut units/ and assign/ from references/units.json
//   show [--control] <unit> <nn> [<nn>…]
//   list                                           regenerate REVIEW-LIST.md
//   run <name> <role> <model> <tokens> <duration-ms>
//   scorecard                                      print and write SCORECARD.md
//   queues                                         write queue/<lane>.md from lanes.json
//   pr <lane> <branch> <base> <new|pr-number> <title> [--limits <text>] [--dry-run]
//
// Every command but init takes the ledger from --ledger or MODEL_PASS_LEDGER.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REFS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'references');
const SUBDIRS = ['findings', 'control', 'units', 'assign', 'queue', 'fixlog', 'backup', 'probes', 'snapshot'];
const ROLES = ['review', 'control', 'fix', 'synthesis', 'other'];
const VERDICTS = ['fix', 'defer', 'ignore', 'declined'];
const EVIDENCE = ['REPRODUCED', 'TRACED', 'PLAUSIBLE', 'TEST-ONLY'];
const SEVS = ['high', 'med', 'low'];
const CATS = ['BROKEN', 'INCONSISTENT', 'INEFFICIENT', 'UNNEEDED', 'TEST-GAP'];
const FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

// ---------------------------------------------------------------- plumbing

function die(msg) {
  console.error(`ledger: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = new Set(['control', 'dry-run']);
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (flags.has(a.slice(2))) opts[a.slice(2)] = true;
    else if (i + 1 < argv.length) opts[a.slice(2)] = argv[++i];
    else die(`${a} needs a value`);
  }
  return { opts, pos };
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function mustSh(cmd, args, cwd) {
  const r = sh(cmd, args, cwd);
  if (!r.ok) die(`${cmd} ${args.join(' ')} failed: ${r.err.split('\n').pop()}`);
  return r.out;
}

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const lines = (text) => text.replace(/\r\n?/g, '\n').split('\n');
const cpSlice = (s, n) => Array.from(s).slice(0, n).join('');
const pad2 = (n) => String(n).padStart(2, '0');
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function codePointCmp(a, b) {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0);
  }
  return x.length - y.length;
}

function ledgerDir(opts) {
  const dir = opts.ledger || process.env.MODEL_PASS_LEDGER;
  if (!dir) die('no ledger: pass --ledger <dir> or set MODEL_PASS_LEDGER');
  const abs = path.resolve(dir);
  if (!exists(path.join(abs, 'pass.json'))) die(`${abs} is not a ledger (no pass.json); create one with init`);
  return abs;
}

const passOf = (L) => JSON.parse(read(path.join(L, 'pass.json')));

function readTsv(file) {
  if (!exists(file)) return [];
  return lines(read(file)).filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split('\t'));
}

// ---------------------------------------------------------------- findings, logs, queues

const ID = /\b([a-z][a-z-]*-\d+)\b/g;

function norm(fid) {
  const i = fid.lastIndexOf('-');
  return `${fid.slice(0, i)}-${pad2(parseInt(fid.slice(i + 1), 10))}`;
}

function mdFiles(dir) {
  return exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
}

function loadFixed(L) {
  const fixed = {};
  for (const parts of readTsv(path.join(L, 'fixed.tsv'))) fixed[norm(parts[0])] = parts.length > 1 ? parts[1] : '';
  return fixed;
}

// One fix log's entries: [{ ids, status, commit, note }], in file order.
function logEntries(file) {
  const out = [];
  for (const block of read(file).split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n');
    const head = nl < 0 ? block : block.slice(0, nl);
    const body = nl < 0 ? '' : block.slice(nl + 1);
    const m = head.match(/—\s*(fixed|skipped|disproved)/);
    if (!m) continue;
    const commit = body.match(/^- commit:\s*([0-9a-f]{7,})/m);
    const note = body.match(/^- note:\s*(.+)$/m);
    out.push({ head, ids: [...head.split('—')[0].matchAll(ID)].map((x) => norm(x[1])), status: m[1], commit: commit ? commit[1] : '', note: note ? note[1] : '' });
  }
  return out;
}

// finding id -> [status, commit, lane], across every fix log.
function loadFixlogs(L) {
  const out = {};
  const dir = path.join(L, 'fixlog');
  for (const f of mdFiles(dir)) {
    for (const e of logEntries(path.join(dir, f))) for (const id of e.ids) out[id] = [e.status, e.commit, f.slice(0, -3)];
  }
  return out;
}

function loadQueued(L) {
  const out = {};
  const dir = path.join(L, 'queue');
  for (const f of mdFiles(dir)) {
    for (const line of lines(read(path.join(dir, f)))) {
      if (!/^\s*\d+\.\s/.test(line)) continue;
      for (const m of line.matchAll(/`([a-z][a-z-]*-\d+)`/g)) if (!(norm(m[1]) in out)) out[norm(m[1])] = f.slice(0, -3);
    }
  }
  return out;
}

// Summary-table rows of every findings file in `dir` (findings/ or control/).
function loadFindings(dir) {
  const rows = [];
  for (const f of mdFiles(dir)) {
    const unit = f.slice(0, -3);
    const text = read(path.join(dir, f));
    const partial = text.startsWith('STATUS: partial');
    const esc = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\|\\s*(${esc}-\\d+)\\s*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|(.*)\\|\\s*$`, 'gm');
    for (const m of text.matchAll(re)) {
      const [fid, cat, sev, conf, sure, line] = m.slice(1).map((g) => g.trim());
      rows.push({ id: norm(fid), unit, cat: cat.split('/')[0].trim().split(' ')[0], sev, conf, sure: sure.toLowerCase().startsWith('yes'), line, partial });
    }
  }
  return rows;
}

// Each `### <unit>-NN` section's Category / Severity / Confidence / Evidence and Sure-fix lines.
function loadDetails(dir, unit) {
  const file = path.join(dir, `${unit}.md`);
  const out = {};
  if (!exists(file)) return out;
  for (const part of read(file).split(/^(?=### )/m)) {
    const m = part.match(/^### (\S+?)-(\d+)\b/);
    if (!m) continue;
    const d = {};
    const c = part.match(/\*\*Category \/ Severity \/ Confidence \/ Evidence\*\*:\s*(.*)/);
    if (c) {
      const [cat = '', sev = '', ...rest] = c[1].split(' / ');
      const ev = rest.join(' / ');
      d.cat = cat.trim().split(/[\s(,+]/)[0];
      d.sev = sev.trim().toLowerCase().replace(/^medium$/, 'med');
      const hits = EVIDENCE.map((e) => [ev.indexOf(e), e]).filter(([i]) => i >= 0).sort((a, b) => a[0] - b[0]);
      d.evidence = hits.length ? hits[0][1] : 'other';
    }
    const s = part.match(/\*\*Sure-fix\*\*:\s*(\S+)/);
    if (s) d.sure = s[1].toLowerCase().startsWith('yes');
    out[norm(`${m[1]}-${m[2]}`)] = d;
  }
  return out;
}

// Summary rows merged with their section details: the section wins where it says something.
function findingsOf(dir) {
  const rows = loadFindings(dir);
  const cache = {};
  return rows.map((r) => {
    const d = (cache[r.unit] ||= loadDetails(dir, r.unit))[r.id] || {};
    return { ...r, cat: d.cat || r.cat, sev: d.sev || r.sev, sure: d.sure ?? r.sure, evidence: d.evidence || 'other' };
  });
}

function loadDecisions(L) {
  const file = path.join(L, 'decisions.tsv');
  if (!exists(file)) return null;
  const out = {};
  for (const [id, verdict, ...reason] of readTsv(file)) {
    if (id === 'finding-id') continue;
    if (!VERDICTS.includes(verdict)) die(`decisions.tsv: ${id} has verdict "${verdict}"; use one of ${VERDICTS.join(', ')}`);
    out[norm(id)] = { verdict, reason: reason.join('\t').trim() };
  }
  return out;
}

// ---------------------------------------------------------------- init and units

function walk(root) {
  const out = [];
  const visit = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(full, r);
      else if (e.isSymbolicLink()) {
        let isDir = false;
        try { isDir = fs.statSync(full).isDirectory(); } catch { /* a dangling link is a file */ }
        if (!isDir) out.push(r);
      } else out.push(r);
    }
  };
  visit(root, '');
  return out.sort(codePointCmp);
}

// Lines as Python's text mode counts them: \n, \r\n, and a lone \r each end a line.
function countLines(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return 0; }
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) n++;
    else if (buf[i] === 13) { n++; if (buf[i + 1] === 10) i++; }
  }
  if (buf.length && buf[buf.length - 1] !== 10 && buf[buf.length - 1] !== 13) n++;
  return n;
}

function substitute(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function varsOf(pass) {
  return {
    LEDGER: pass.ledger,
    SNAPSHOT: path.join(pass.ledger, 'snapshot'),
    BASE: pass.base.slice(0, 9),
    CHECKOUT: path.join(pass.worktrees, 'review-main'),
    WORKTREES: pass.worktrees,
    CARGO_TARGET: path.join(pass.repo, 'standalone', 'src-tauri', 'target'),
  };
}

function renderAssignment(u, cross) {
  const paras = [];
  const noList = cross && !/no file list/.test(u.what) ? ' You have no file list: your unit is cross-cutting.' : '';
  paras.push('You are a reviewer in a read-only audit of the Dormouse repository. First read the shared brief at `{{LEDGER}}/BRIEF.md` and follow it exactly: it defines the paths (`SP`), the method, the evidence classes, the output format, and the rules (read-only, no subagents, final reply ≤200 words).' + noList);
  paras.push(`**Your unit: \`${u.unit}\`** — ${u.what}`);
  if (u.read) paras.push(u.read);
  paras.push(...(u.before || []));
  const items = u.focus.map((f, i) => `${u.numbered ? `${i + 1}.` : '-'} ${f}`);
  paras.push([u.focusHeading || '**Look especially hard at:**', ...items].join('\n'));
  paras.push(...(u.notes || []));
  paras.push(`Findings file: \`SP/findings/${u.unit}.md\`.` + (cross ? '' : ` File list: \`SP/units/${u.unit}.txt\`.`));
  return paras.join('\n\n') + '\n';
}

// Assign every file under `snapshot` to the first matching unit and write units/ and assign/
// under `out`. Returns false when a file is unclaimed or a unit is empty.
function cutUnits(snapshot, out, vars) {
  const cat = JSON.parse(read(path.join(REFS, 'units.json')));
  const re = (p) => new RegExp(p);
  const exclude = cat.exclude.map(re);
  const units = cat.units.map((u) => ({ ...u, res: u.rules.map(re), testRe: re(u.tests || cat.tests), src: [], test: [], bin: [] }));
  const binary = re(cat.binary), skipLines = re(cat.skipLines);
  const unassigned = [], excluded = [];
  for (const f of walk(snapshot)) {
    if (exclude.some((r) => r.test(f))) { excluded.push(f); continue; }
    const u = units.find((x) => x.res.some((r) => r.test(f)));
    if (!u) unassigned.push(f);
    else (binary.test(f) ? u.bin : u.testRe.test(f) ? u.test : u.src).push(f);
  }
  const locCache = new Map();
  const loc = (f) => { if (!locCache.has(f)) locCache.set(f, countLines(path.join(snapshot, f))); return locCache.get(f); };
  const sum = (fs_) => fs_.filter((f) => !skipLines.test(f)).reduce((a, f) => a + loc(f), 0);
  const byLoc = (fs_) => [...fs_].sort((a, b) => loc(b) - loc(a));
  for (const d of ['units', 'assign']) fs.mkdirSync(path.join(out, d), { recursive: true });
  const empty = [];
  let total = 0;
  for (const u of units) {
    const s = sum(u.src), t = sum(u.test);
    total += u.src.length + u.test.length + u.bin.length;
    if (!u.src.length && !u.test.length && !u.bin.length) empty.push(u.unit);
    const txt = [`# unit ${u.unit}: ${u.src.length} source files (${s} lines), ${u.test.length} test/story files (${t} lines)`, '## SOURCE (must read in full)'];
    for (const f of byLoc(u.src)) txt.push(`${String(loc(f)).padStart(6)}  ${f}`);
    txt.push('## TESTS / STORIES / FIXTURES (secondary)');
    for (const f of byLoc(u.test)) txt.push(`${String(loc(f)).padStart(6)}  ${f}`);
    if (u.bin.length) {
      txt.push('## BINARY ASSETS (existence/usage only)');
      for (const f of [...u.bin].sort(codePointCmp)) txt.push(`        ${f}`);
    }
    fs.writeFileSync(path.join(out, 'units', `${u.unit}.txt`), txt.join('\n') + '\n');
    if (!u.holding) fs.writeFileSync(path.join(out, 'assign', `${u.unit}.md`), substitute(renderAssignment(u, false), vars));
    console.log(`${u.unit.padEnd(28)} src ${String(u.src.length).padStart(4)} files ${String(s).padStart(6)} lines | test ${String(u.test.length).padStart(4)} files ${String(t).padStart(6)} lines | bin ${u.bin.length}`);
  }
  for (const c of cat.cross) fs.writeFileSync(path.join(out, 'assign', `${c.unit}.md`), substitute(renderAssignment(c, true), vars));
  console.log(`assigned ${total}, excluded ${excluded.length}, unassigned ${unassigned.length}; ${units.length} units, ${cat.cross.length} cross-cutting`);
  for (const f of unassigned) console.log(`  UNASSIGNED ${f}`);
  for (const u of empty) console.log(`  EMPTY UNIT ${u}`);
  if (unassigned.length || empty.length) {
    console.error('ledger: the tree has moved since references/units.json was written: give each unassigned file a unit (or an exclude pattern) and retire or re-aim each empty unit');
    return false;
  }
  return true;
}

function cmdInit(opts) {
  for (const k of ['ledger', 'worktrees', 'base']) if (!opts[k]) die(`init needs --${k}`);
  const L = path.resolve(opts.ledger);
  if (exists(L) && fs.readdirSync(L).length) die(`${L} is not empty; init needs a new or empty directory`);
  const repo = mustSh('git', ['rev-parse', '--show-toplevel'], process.cwd());
  const base = mustSh('git', ['rev-parse', '--verify', `${opts.base}^{commit}`], repo);
  if (L === repo || L.startsWith(repo + path.sep)) die('the ledger must live outside the repository');
  for (const d of SUBDIRS) fs.mkdirSync(path.join(L, d), { recursive: true });
  const tar = path.join(L, 'snapshot.tar');
  mustSh('git', ['archive', '--output', tar, base], repo);
  mustSh('tar', ['-x', '-f', tar, '-C', path.join(L, 'snapshot')]);
  fs.rmSync(tar);
  const pass = { base, created: new Date().toISOString(), ledger: L, worktrees: path.resolve(opts.worktrees), repo, previous: opts.previous ? path.resolve(opts.previous) : null };
  fs.writeFileSync(path.join(L, 'pass.json'), JSON.stringify(pass, null, 2) + '\n');
  const vars = varsOf(pass);
  fs.writeFileSync(path.join(L, 'BRIEF.md'), substitute(read(path.join(REFS, 'reviewer-brief.md')), vars));
  fs.writeFileSync(path.join(L, 'FIXBRIEF.md'), substitute(read(path.join(REFS, 'implementer-brief.md')), vars));
  if (pass.previous) {
    fs.mkdirSync(path.join(L, 'previous'));
    for (const f of ['REVIEW-LIST.md', 'decisions.tsv']) {
      if (exists(path.join(pass.previous, f))) fs.copyFileSync(path.join(pass.previous, f), path.join(L, 'previous', f));
      else console.log(`note: ${pass.previous} has no ${f}`);
    }
  }
  console.log(`ledger ${L} at ${vars.BASE}`);
  if (!cutUnits(path.join(L, 'snapshot'), L, vars)) process.exit(1);
}

function cmdUnits(opts) {
  const L = ledgerDir(opts);
  const snapshot = path.resolve(opts.snapshot || path.join(L, 'snapshot'));
  if (!cutUnits(snapshot, path.resolve(opts.out || L), varsOf(passOf(L)))) process.exit(1);
}

// ---------------------------------------------------------------- show

function cmdShow(opts, pos) {
  const L = ledgerDir(opts);
  const [unit, ...want] = pos;
  if (!unit || !want.length) die('usage: show [--control] <unit> <nn> [<nn>…]');
  const file = path.join(L, opts.control ? 'control' : 'findings', `${unit}.md`);
  if (!exists(file)) die(`no ${file}`);
  const wanted = new Set(want);
  for (const part of read(file).split(/^(?=### )/m)) {
    const m = part.match(/^### (\S+?)-(\d+)\b/);
    if (!m || !(wanted.has(m[2]) || wanted.has(m[2].replace(/^0+/, '')))) continue;
    process.stdout.write(part.split(/^## /m)[0].trimEnd() + '\n\n');
  }
}

// ---------------------------------------------------------------- list

function cmdList(opts) {
  const L = ledgerDir(opts);
  const fixed = loadFixed(L), logs = loadFixlogs(L), queued = loadQueued(L), rows = loadFindings(path.join(L, 'findings'));
  const decisions = loadDecisions(L);
  // A queued lane counts as started once its implementer has opened a fix log.
  const launched = new Set(mdFiles(path.join(L, 'fixlog')).map((f) => f.slice(0, -3)));
  for (const r of rows) {
    const fid = r.id;
    if (fid in fixed) r.status = `fixed ${fixed[fid]}`;
    else if (fid in logs && logs[fid][0] === 'fixed') r.status = `fixed ${logs[fid][1]} (${logs[fid][2]} lane)`;
    else if (decisions && fid in decisions) r.status = decisions[fid].reason ? `${decisions[fid].verdict} — ${decisions[fid].reason}` : decisions[fid].verdict;
    else if (fid in logs) r.status = `${logs[fid][0]} by implementer`;
    else if (fid in queued) r.status = (launched.has(queued[fid]) ? 'in fix lane ' : 'queued, not started: ') + queued[fid];
    else if (r.sure) r.status = 'sure-fix, not queued yet';
    else r.status = 'needs your decision';
  }
  const order = { high: 0, med: 1, low: 2 };
  const kindOf = (r) => r.status.split(' ')[0];
  const count = (xs, key) => xs.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {});
  const units = new Set(rows.map((r) => r.unit));
  const out = ['# Audit findings: what happened to each one', ''];
  out.push(`${rows.length} findings from ${units.size} units. Print any finding in full with \`node .claude/skills/model-pass/scripts/ledger.mjs show <unit> <nn>\` from the repository root.`);
  out.push('');
  const statusKind = count(rows, kindOf);
  out.push('| | ' + CATS.join(' | ') + ' | all |');
  out.push('|---|' + '---|'.repeat(CATS.length + 1));
  const kinds = [['fixed', 'Fixed'], ['in', 'In a fix lane now'], ['queued,', 'Queued, not started'], ['sure-fix,', 'Sure-fix, not queued yet'],
    ['skipped', 'Skipped by implementer'], ['disproved', 'Disproved by implementer']];
  if (decisions) kinds.push(['fix', 'Decided: fix'], ['defer', 'Deferred'], ['ignore', 'Ignored'], ['declined', 'Declined']);
  kinds.push(['needs', 'Needs your decision']);
  for (const [kind, label] of kinds) {
    const c = count(rows.filter((r) => kindOf(r) === kind), (r) => r.cat);
    out.push(`| ${label} | ` + CATS.map((k) => c[k] || 0).join(' | ') + ` | ${statusKind[kind] || 0} |`);
  }
  const total = count(rows, (r) => r.cat);
  out.push('| **All** | ' + CATS.map((k) => total[k] || 0).join(' | ') + ` | ${rows.length} |`);
  out.push('');
  const table = (title, subset) => {
    if (!subset.length) return;
    out.push(`## ${title}`, '', '| ID | Sev | Conf | Status | Finding |', '|---|---|---|---|---|');
    subset.sort((a, b) => ((order[a.sev] ?? 3) - (order[b.sev] ?? 3)) || cmpStr(a.id, b.id));
    for (const r of subset) out.push(`| ${r.id} | ${r.sev} | ${r.conf} | ${r.status} | ${r.line} |`);
    out.push('');
  };
  const open = rows.filter((r) => !r.status.startsWith('fixed') && !r.status.startsWith('disproved'));
  table('Broken, high severity, not fixed', open.filter((r) => r.cat === 'BROKEN' && r.sev === 'high'));
  table('Broken, medium severity, not fixed', open.filter((r) => r.cat === 'BROKEN' && r.sev === 'med'));
  table('Broken, low severity, not fixed', open.filter((r) => r.cat === 'BROKEN' && r.sev === 'low'));
  table('Spec and code disagree, not fixed', open.filter((r) => r.cat === 'INCONSISTENT'));
  table('Inefficient, not fixed', open.filter((r) => r.cat === 'INEFFICIENT'));
  table('Unneeded, not fixed', open.filter((r) => r.cat === 'UNNEEDED'));
  table('Test gaps', open.filter((r) => r.cat === 'TEST-GAP'));
  table('Fixed', rows.filter((r) => r.status.startsWith('fixed')));
  table('Disproved by an implementer', rows.filter((r) => r.status.startsWith('disproved')));
  const partial = [...new Set(rows.filter((r) => r.partial).map((r) => r.unit))].sort();
  if (partial.length) out.push('Units still being reviewed when this was compiled: ' + partial.join(', ') + '.');
  const file = path.join(L, 'REVIEW-LIST.md');
  fs.writeFileSync(file, out.join('\n') + '\n');
  console.log(`${file}: ${rows.length} findings; ` + Object.entries(statusKind).map(([k, v]) => `${k.replace(/,$/, '')} ${v}`).join(', '));
}

// ---------------------------------------------------------------- run

function cmdRun(opts, pos) {
  const L = ledgerDir(opts);
  const [name, role, model, tokens, ms] = pos;
  if (pos.length !== 5) die('usage: run <name> <role> <model> <tokens> <duration-ms>');
  if (!ROLES.includes(role)) die(`role must be one of ${ROLES.join(', ')}, not "${role}"`);
  for (const [k, v] of [['tokens', tokens], ['duration-ms', ms]]) if (!/^\d+$/.test(v)) die(`${k} must be a whole number, not "${v}"`);
  const file = path.join(L, 'runs.tsv');
  if (!exists(file)) fs.writeFileSync(file, 'name\trole\tmodel\ttokens\tduration_ms\trecorded\n');
  fs.appendFileSync(file, [name, role, model, tokens, ms, new Date().toISOString()].join('\t') + '\n');
  console.log(`recorded ${role} run ${name} (${model}, ${tokens} tokens)`);
}

function loadRuns(L) {
  return readTsv(path.join(L, 'runs.tsv')).filter((r) => r[0] !== 'name' || r[1] !== 'role')
    .map(([name, role, model, tokens, ms, recorded]) => ({ name, role, model, tokens: Number(tokens) || 0, ms: Number(ms) || 0, recorded }));
}

// name -> { model (latest row), tokens (sum) } for one role.
function runsBy(runs, role) {
  const out = {};
  for (const r of runs.filter((x) => x.role === role)) {
    const e = (out[r.name] ||= { model: r.model, tokens: 0, ms: 0 });
    e.model = r.model;
    e.tokens += r.tokens;
    e.ms += r.ms;
  }
  return out;
}

// ---------------------------------------------------------------- scorecard

const fmt = (n) => (Number.isFinite(n) ? (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 })) : '—');
const div = (a, b) => (b ? a / b : NaN);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `|${'---|'.repeat(head.length)}`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function reviewGroups(L, runs) {
  const groups = [];
  for (const [role, dirName] of [['review', 'findings'], ['control', 'control']]) {
    const dir = path.join(L, dirName);
    const byUnit = runsBy(runs, role);
    const found = findingsOf(dir);
    const units = new Set([...mdFiles(dir).map((f) => f.slice(0, -3)), ...Object.keys(byUnit)]);
    for (const unit of units) {
      const model = byUnit[unit]?.model || 'unrecorded';
      let g = groups.find((x) => x.role === role && x.model === model);
      if (!g) groups.push((g = { role, model, units: [], tokens: 0, findings: [] }));
      g.units.push(unit);
      g.tokens += byUnit[unit]?.tokens || 0;
      g.findings.push(...found.filter((r) => r.unit === unit).map((r) => ({ ...r, model })));
    }
  }
  const rank = (g) => (g.role === 'review' ? 0 : 2) + (g.model === 'unrecorded' ? 1 : 0);
  return groups.sort((a, b) => rank(a) - rank(b) || cmpStr(a.model, b.model));
}

function cmdScorecard(opts) {
  const L = ledgerDir(opts);
  const runs = loadRuns(L);
  const pass = passOf(L);
  const out = [`# Scorecard — pass at ${pass.base.slice(0, 9)}`, ''];
  const groups = reviewGroups(L, runs);
  const by = (xs, key, values) => values.map((v) => xs.filter((x) => x[key] === v).length);

  out.push('## Reviews by model', '');
  out.push(mdTable(['Model', 'Role', 'Units', 'Tokens', 'Tokens/unit', 'Findings', 'Findings/unit', 'high', 'med', 'low', 'Sure-fix', 'Tokens per high/med'],
    groups.map((g) => {
      const hm = g.findings.filter((f) => f.sev === 'high' || f.sev === 'med').length;
      const tok = g.model === 'unrecorded' ? NaN : g.tokens;
      return [g.model, g.role, g.units.length, fmt(tok), fmt(div(tok, g.units.length)), g.findings.length, fmt(div(g.findings.length, g.units.length)),
        ...by(g.findings, 'sev', SEVS), g.findings.filter((f) => f.sure).length, fmt(div(tok, hm))];
    })));
  out.push('', 'By category:', '');
  out.push(mdTable(['Model', 'Role', ...CATS, 'other'], groups.map((g) => [g.model, g.role, ...by(g.findings, 'cat', CATS), g.findings.filter((f) => !CATS.includes(f.cat)).length])));
  out.push('', 'By evidence:', '');
  out.push(mdTable(['Model', 'Role', ...EVIDENCE, 'other'], groups.map((g) => [g.model, g.role, ...by(g.findings, 'evidence', [...EVIDENCE, 'other'])])));
  out.push('', 'Units: ' + groups.map((g) => `${g.model} ${g.role}: ${[...g.units].sort().join(', ')}`).join('; ') + '.', '');

  const pilotFile = path.join(L, 'pilot.tsv');
  if (exists(pilotFile)) {
    const pilot = readTsv(pilotFile).filter((r) => r[0] !== 'unit');
    const ids = new Set(findingsOf(path.join(L, 'findings')).map((r) => r.id));
    const cids = new Set(findingsOf(path.join(L, 'control')).map((r) => r.id));
    const reviewRuns = runsBy(runs, 'review'), controlRuns = runsBy(runs, 'control');
    const cell = (rs) => `${rs.length} (${SEVS.map((s) => rs.filter((r) => r.sev === s).length).join('/')})`;
    const row = (label, rs) => [label, cell(rs.filter((r) => r.id !== '-' && r.cid !== '-')), cell(rs.filter((r) => r.cid === '-')), cell(rs.filter((r) => r.id === '-'))];
    const parsed = pilot.map(([unit, id = '-', cid = '-', sev = '']) => ({ unit, id: id === '-' ? '-' : norm(id), cid: cid === '-' ? '-' : norm(cid), sev: sev.trim().toLowerCase() }));
    const missing = parsed.flatMap((r) => [r.id !== '-' && !ids.has(r.id) ? r.id : null, r.cid !== '-' && !cids.has(r.cid) ? `control ${r.cid}` : null]).filter(Boolean);
    const units = [...new Set(parsed.map((r) => r.unit))];
    out.push('## Pilot overlap', '', 'Each cell: count (high/med/low).', '');
    out.push(mdTable(['Unit', 'Model / control', 'Found by both', 'Only the model under test', 'Only the control'],
      [...units.map((u) => { const r = row(u, parsed.filter((x) => x.unit === u)); return [r[0], `${reviewRuns[u]?.model || 'unrecorded'} / ${controlRuns[u]?.model || 'unrecorded'}`, ...r.slice(1)]; }),
        (() => { const r = row('**All**', parsed); return [r[0], '', ...r.slice(1)]; })()]));
    if (missing.length) out.push('', `pilot.tsv names findings no findings file has: ${missing.join(', ')}.`);
    out.push('');
  }

  const fixRuns = runsBy(runs, 'fix');
  const logDir = path.join(L, 'fixlog');
  const lanes = [...new Set([...mdFiles(logDir).map((f) => f.slice(0, -3)), ...Object.keys(fixRuns)])].sort();
  out.push('## Fix lanes', '');
  out.push(mdTable(['Lane', 'Model', 'Fixed', 'Skipped', 'Disproved', 'Tokens', 'Tokens per fix'], lanes.map((lane) => {
    const st = {};
    if (exists(path.join(logDir, `${lane}.md`))) for (const e of logEntries(path.join(logDir, `${lane}.md`))) for (const id of e.ids) st[id] = e.status;
    const c = (s) => Object.values(st).filter((v) => v === s).length;
    const tok = fixRuns[lane] ? fixRuns[lane].tokens : NaN;
    return [lane, fixRuns[lane]?.model || 'unrecorded', c('fixed'), c('skipped'), c('disproved'), fmt(tok), fmt(div(tok, c('fixed')))];
  })));
  out.push('');

  const logs = loadFixlogs(L);
  const sure = groups.filter((g) => g.role === 'review').flatMap((g) => g.findings).filter((f) => f.sure && f.id in logs);
  const models = [...new Set(sure.map((f) => f.model))];
  out.push('## Reviewer precision', '', 'Findings their reviewer marked sure-fix that a fix log has an entry for.', '');
  out.push(mdTable(['Model', 'Logged', 'Fixed', 'Skipped', 'Disproved'], [...models.map((m) => sure.filter((f) => f.model === m)), sure].map((fs_, i) => {
    const c = (s) => fs_.filter((f) => logs[f.id][0] === s).length;
    return [i < models.length ? models[i] : '**All**', fs_.length, `${c('fixed')} (${pct(c('fixed'), fs_.length)})`, `${c('skipped')} (${pct(c('skipped'), fs_.length)})`, `${c('disproved')} (${pct(c('disproved'), fs_.length)})`];
  })));
  const text = out.join('\n') + '\n';
  fs.writeFileSync(path.join(L, 'SCORECARD.md'), text);
  process.stdout.write(text);
}

// ---------------------------------------------------------------- queues

function cmdQueues(opts) {
  const L = ledgerDir(opts);
  const file = path.join(L, 'lanes.json');
  if (!exists(file)) die(`no ${file}: write lane -> { branch, units, extra?, skip?, dirs, notes } first`);
  const lanes = JSON.parse(read(file));
  const WT = passOf(L).worktrees;
  const SEV = { high: 0, med: 1, low: 2 };
  const CAT = { BROKEN: 0, INCONSISTENT: 1, INEFFICIENT: 2, 'TEST-GAP': 3, UNNEEDED: 4 };
  const fixed = loadFixed(L), logs = loadFixlogs(L), rows = loadFindings(path.join(L, 'findings'));
  const done = new Set([...Object.keys(fixed), ...Object.keys(logs)]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const [lane, spec] of Object.entries(lanes)) {
    const extra = spec.extra || [], skip = spec.skip || [];
    const chosen = rows.filter((r) => spec.units.includes(r.unit) && r.sure && !done.has(r.id) && !skip.includes(r.id));
    chosen.push(...extra.filter((i) => i in byId && !done.has(i)).map((i) => byId[i]));
    const key = (r) => [extra.includes(r.id) ? 0 : 1, CAT[r.cat] ?? 9, SEV[r.sev] ?? 3];
    chosen.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || cmpStr(a.id, b.id); });
    const out = [`# Queue: lane \`${lane}\``, '',
      `Worktree: \`${WT}/${spec.branch}\` (branch \`${spec.branch}\`). Commit on that branch; never push.`,
      `Your directories: ${spec.dirs}. Other implementers are working in other worktrees on other directories. If a fix needs a file outside yours, make the smallest edit there and say so in your log; if it needs more than a few lines there, skip.`,
      '', 'Every finding below was marked a sure fix by its reviewer. That is a claim for you to check, not an order: re-verify each one against the current code, and skip freely.', ''];
    if (spec.notes && spec.notes.length) out.push('## Notes that override the findings', ...spec.notes.map((n) => `- ${n}`), '');
    out.push('## Implement in this order');
    chosen.forEach((r, n) => out.push(`${n + 1}. \`${r.id}\` (${r.cat}, ${r.sev}, ${r.conf}) — ${cpSlice(r.line, 200)}`));
    out.push('', 'Every other finding in those files needs a decision: do not fix it.');
    fs.writeFileSync(path.join(L, 'queue', `${lane}.md`), out.join('\n') + '\n');
    console.log(`${lane.padEnd(14)} ${String(chosen.length).padStart(3)} findings  ` + Object.keys(CAT).map((c) => `${c}=${chosen.filter((r) => r.cat === c).length}`).join(' '));
  }
}

// ---------------------------------------------------------------- pr

function implementer(runs, lane) {
  const fix = runs.filter((r) => r.role === 'fix' && r.name === lane).sort((a, b) => cmpStr(a.recorded || '', b.recorded || ''));
  if (!fix.length) return 'A subagent';
  const model = fix[fix.length - 1].model;
  const name = model.charAt(0).toUpperCase() + model.slice(1);
  return `${/^[aeiou]/i.test(name) ? 'An' : 'A'} ${name} agent`;
}

function prSection(L, lane, wt, limits) {
  const file = path.join(L, 'fixlog', `${lane}.md`);
  if (!exists(file)) die(`no ${file}`);
  const fixed = [], skipped = [];
  for (const e of logEntries(file)) {
    const ids = e.head.split('—')[0].trim();
    if (e.status === 'fixed' && e.commit) fixed.push([e.commit, ids]);
    else if (e.status !== 'fixed') skipped.push([ids, e.status, cpSlice(e.note.trim().split(/(?<=[.!?])\s/)[0], 300)]);
  }
  const rows = ['| Commit | Findings |', '|---|---|'];
  for (const [sha, ids] of fixed) {
    const r = sh('git', ['log', '-1', '--format=%s', sha], wt);
    rows.push(`| ${(r.ok && r.out) || '(commit not on this branch)'} | ${ids} |`);
  }
  let out = rows.join('\n');
  if (skipped.length) out += "\n\nLeft alone, with the implementer's reason:\n\n" + skipped.map(([ids, kind, why]) => `- \`${ids}\` (${kind}): ${why}`).join('\n');
  if (limits) out += '\n\nNot verified: ' + limits;
  return [out, fixed.length];
}

function cmdPr(opts, pos) {
  const L = ledgerDir(opts);
  if (pos.length !== 5) die('usage: pr <lane> <branch> <base> <new|pr-number> <title> [--limits <text>] [--dry-run]');
  const [lane, branch, base, pr, title] = pos;
  const wt = path.join(passOf(L).worktrees, branch);
  if (!exists(wt)) die(`no worktree at ${wt}`);
  const dry = !!opts['dry-run'];
  const [section, count] = prSection(L, lane, wt, (opts.limits || '').trim());
  const bodyFile = path.join(L, `pr-${lane}-generated.md`);
  const step = (cmd, args) => {
    if (dry) { console.log(`$ (cd ${wt} && ${[cmd, ...args].map((a) => (/^[\w./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')})`); return ''; }
    return mustSh(cmd, args, wt);
  };
  const pushed = step('git', ['push', '-u', 'origin', branch]);
  if (!dry) console.log(pushed || 'pushed');
  let body;
  if (pr === 'new') {
    const parent = step('gh', ['pr', 'list', '--head', base, '--json', 'number', '--jq', '.[0].number']);
    const stacked = parent ? `Stacked on #${parent}. ` : '';
    body = `${stacked}${count} commits from the audit, one finding per commit. ${implementer(loadRuns(L), lane)} implemented each from a reviewer's write-up; `
      + "the finding ids refer to the audit ledger. Each commit's message states what a user or caller saw before, what changed, and, where behavior changed, "
      + 'the test that failed on the old code.\n\n## Commits\n\n' + section
      + "\n\n## Validation\n\nEach commit passed its package's tests, the typechecks its files fall under, and `spec-lint` when it was made. "
      + "This PR's CI is the first full gate for the branch as a whole.\n\n" + FOOTER + '\n';
    if (!dry) fs.writeFileSync(bodyFile, body);
    step('gh', ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile]);
  } else {
    const addition = `## Second batch: ${count} more commits\n\nAdded after this PR opened, from the same audit units and by the same method.\n\n` + section + '\n\n';
    const current = step('gh', ['pr', 'view', pr, '--json', 'body', '--jq', '.body']);
    if (dry) body = `(inserted before "## Validation", or before the footer, of PR #${pr}'s current body)\n\n${addition}`;
    else {
      const marker = '## Validation';
      body = current.includes(marker) ? current.replace(marker, () => addition + marker) : current.replace(FOOTER, () => addition + FOOTER);
      fs.writeFileSync(bodyFile, body);
    }
    step('gh', ['pr', 'edit', pr, '--body-file', bodyFile]);
  }
  if (dry) process.stdout.write(`\n----- body -----\n${body}`);
  else console.log(`body: ${bodyFile}`);
}

// ---------------------------------------------------------------- main

const COMMANDS = { init: cmdInit, units: cmdUnits, show: cmdShow, list: cmdList, run: cmdRun, scorecard: cmdScorecard, queues: cmdQueues, pr: cmdPr };
const [command, ...rest] = process.argv.slice(2);
if (!COMMANDS[command]) die(`unknown command "${command || ''}"; one of ${Object.keys(COMMANDS).join(', ')} (see the header of this file)`);
const { opts, pos } = parseArgs(rest);
COMMANDS[command](opts, pos);
