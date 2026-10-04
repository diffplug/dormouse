#!/usr/bin/env node
/**
 * Defines this clone's `md-sentences` merge driver, which .gitattributes
 * assigns to `*.md` / `*.mdx`. Git never runs a driver a repository declares
 * on its own, so each clone opts in once; worktrees share the setting. Until
 * then Git merges those files line by line, as it would without the attribute.
 *
 * The driver runs the checked-out scripts/md-merge.mjs, and falls back to
 * Git's line merge on a branch that predates it.
 */
import { execFileSync } from 'node:child_process';

const script = '"$(git rev-parse --show-toplevel)/scripts/md-merge.mjs"';
const driver = [
  `if [ -f ${script} ]; then node ${script} %O %A %B %L %P %S %X %Y;`,
  'else git merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B; fi',
].join(' ');

const set = (key, value) => execFileSync('git', ['config', '--local', key, value]);
set('merge.md-sentences.name', 'sentence-aware markdown merge (scripts/md-merge.mjs)');
set('merge.md-sentences.driver', driver);
console.log('setup-git: markdown now merges sentence by sentence in this clone and its worktrees');
