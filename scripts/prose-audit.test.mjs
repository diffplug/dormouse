import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dormouse-prose-audit-'));
  assert.equal(dirname(root), tmpdir());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const name of ['prose-audit.mjs', 'spec-md.mjs']) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(join(source, name), join(root, 'scripts', name));
  }
  put('scripts/spec-word-budgets.json', '{}');
  put('docs/specs/example.md', '# Example\n\nSee \x60src/direct.ts\x60.\n');
  put('src/direct.ts', 'export const direct = true;\n');
  put('src/rationale.ts', 'export const rationale = true;\n');
  for (const path of ['AGENTS.md', 'SECURITY.md', 'SELF_HOST.md', 'docs/compatible-agents.md']) put(path, '# Contract\n');
  put('docs/specs/example.rationale.md', '# Rationale\n\nSee \x60src/rationale.ts\x60.\n\n' + 'Measured because this boundary matters. '.repeat(35) + '\n');
  put('SELF_HOST.rationale.md', '# Installer evidence\n\nSee \x60src/rationale.ts\x60.\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ['scripts/prose-audit.mjs', '--json', ...args], { cwd: root, encoding: 'utf8' }));
  return { root, run, git };
}

test('full inventory includes companion contracts and installer rationale', t => {
  const { run } = fixture(t);
  const { specs } = run();
  assert.deepEqual(specs.map(report => report.spec).sort(), ['AGENTS.md', 'SECURITY.md', 'SELF_HOST.md', 'docs/compatible-agents.md', 'docs/specs/example.md'].sort());
  assert.equal(specs.find(report => report.spec === 'SELF_HOST.md').rationale.path, 'SELF_HOST.rationale.md');
});

test('rationale prose and its source references participate in the inventory', t => {
  const { run } = fixture(t);
  const report = run().specs.find(report => report.spec === 'docs/specs/example.md');
  assert.deepEqual(report.references, ['src/direct.ts', 'src/rationale.ts']);
  assert.deepEqual(report.rationale.references, ['src/rationale.ts']);
  assert.ok(report.rationale.prose.some(hit => hit.kind === 'LONG'));
  assert.ok(report.rationale.prose.some(hit => hit.kind === 'RATIONALE'));
  assert.equal(report.score, report.prose.length + report.rationale.prose.length + report.code.reduce((sum, file) => sum + file.findings.length, 0));
});

test('changed selection includes code referenced only by rationale', t => {
  const { root, run } = fixture(t);
  appendFileSync(join(root, 'src/rationale.ts'), 'export const changed = true;\n');
  assert.deepEqual(run('--changed=HEAD').specs.map(report => report.spec).sort(), ['SELF_HOST.md', 'docs/specs/example.md']);
});

test('removed rationale still selects its owning spec', t => {
  const { root, run } = fixture(t);
  unlinkSync(join(root, 'docs/specs/example.rationale.md'));
  const reports = run('--changed=HEAD').specs;
  assert.deepEqual(reports.map(report => report.spec), ['docs/specs/example.md']);
  assert.equal(reports[0].rationale, null);
});

test('changed selection resolves a newly present untracked referenced source', t => {
  const { root, run, git } = fixture(t);
  appendFileSync(join(root, 'docs/specs/example.md'), 'See \x60src/new.ts\x60.\n');
  git('add', 'docs/specs/example.md');
  git('-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'future reference');
  writeFileSync(join(root, 'src/new.ts'), '// Newly implemented source.\n');
  const reports = run('--changed=HEAD').specs;
  assert.deepEqual(reports.map(report => report.spec), ['docs/specs/example.md']);
  assert.ok(reports[0].references.includes('src/new.ts'));
});
