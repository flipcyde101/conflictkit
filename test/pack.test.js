import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { formatPackMarkdown, packConflicts } from '../src/pack.js';
import { commitFile, createTempDir, git, initRepo, removeDir } from './helpers.js';

const tempDirs = [];

function makeRepo() {
  const dir = createTempDir();
  tempDirs.push(dir);
  initRepo(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    removeDir(tempDirs.pop());
  }
});

describe('packConflicts', () => {
  it('reports CLEAN for non-overlapping branches and auto-detects main', () => {
    const repo = makeRepo();
    commitFile(repo, 'app.js', 'const a = 1;\n', 'feat: add app.js');

    git(repo, ['checkout', '-b', 'feature/clean']);
    commitFile(repo, 'feature.js', 'export const f = true;\n', 'feat: add feature.js');

    git(repo, ['checkout', 'main']);
    commitFile(repo, 'other.js', 'export const o = 2;\n', 'feat: add other.js');

    git(repo, ['checkout', 'feature/clean']);

    const result = packConflicts({ repoDir: repo });
    assert.equal(result.status, 'clean');
    assert.equal(result.onto, 'main');
    assert.equal(result.autoDetectedOnto, true);
    assert.deepEqual(result.conflicts, []);

    const md = formatPackMarkdown(result);
    assert.match(md, /ConflictKit Pack: CLEAN/);
    assert.match(md, /Result: CLEAN/);
  });

  it('extracts 3-way conflict context, branch intent, and upstream history without mutating working tree', () => {
    const repo = makeRepo();
    const baseContent = [
      'function greet(name) {',
      '  return "Hello, " + name;',
      '}',
      'module.exports = { greet };',
      '',
    ].join('\n');
    commitFile(repo, 'greet.js', baseContent, 'feat: initial greet');

    git(repo, ['checkout', '-b', 'feature/greeting']);
    const oursContent = [
      'function greet(name) {',
      '  return `Hi ${name}!`;',
      '}',
      'module.exports = { greet };',
      '',
    ].join('\n');
    commitFile(repo, 'greet.js', oursContent, 'feat: use template greeting');

    git(repo, ['checkout', 'main']);
    const theirsContent = [
      'function greet(name) {',
      '  return `Welcome, ${name}.`;',
      '}',
      'module.exports = { greet };',
      '',
    ].join('\n');
    commitFile(repo, 'greet.js', theirsContent, 'fix: formal welcome message');

    git(repo, ['checkout', 'feature/greeting']);

    // Add dirty working tree and staged changes to prove non-destructive behavior.
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'untracked dirty\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged content\n', 'utf8');
    git(repo, ['add', 'staged.txt']);
    const statusBefore = git(repo, ['status', '--porcelain']);
    const greetBefore = fs.readFileSync(path.join(repo, 'greet.js'), 'utf8');

    const result = packConflicts({ repoDir: repo, onto: 'main' });

    const statusAfter = git(repo, ['status', '--porcelain']);
    assert.equal(statusAfter, statusBefore);
    assert.equal(
      fs.readFileSync(path.join(repo, 'greet.js'), 'utf8'),
      greetBefore,
    );

    assert.equal(result.status, 'conflicted');
    assert.equal(result.onto, 'main');
    assert.equal(result.autoDetectedOnto, false);
    assert.equal(result.branch, 'feature/greeting');
    assert.equal(result.branchCommits.length, 1);
    assert.equal(result.branchCommits[0].subject, 'feat: use template greeting');
    assert.match(result.branchDiffStat, /greet\.js/);

    assert.equal(result.conflicts.length, 1);
    const conflict = result.conflicts[0];
    assert.equal(conflict.path, 'greet.js');
    assert.equal(conflict.base, baseContent);
    assert.equal(conflict.ours, oursContent);
    assert.equal(conflict.theirs, theirsContent);
    assert.ok(conflict.conflictMarked);
    assert.match(conflict.conflictMarked, /<{7}/);
    assert.match(conflict.conflictMarked, /={7}/);
    assert.match(conflict.conflictMarked, />{7}/);
    assert.equal(conflict.upstreamCommits.length, 1);
    assert.equal(
      conflict.upstreamCommits[0].subject,
      'fix: formal welcome message',
    );

    const md = formatPackMarkdown(result);
    assert.match(md, /ConflictKit Pack: CONFLICTED \(1 file\)/);
    assert.match(md, /## Current Branch Intent/);
    assert.match(md, /## File: `greet\.js`/);
    assert.match(md, /### Upstream Commits Touching File/);
    assert.match(md, /### 3-Way Context/);
  });

  it('throws clear errors for non-git dirs and missing refs', () => {
    const nonGit = createTempDir();
    tempDirs.push(nonGit);
    assert.throws(() => packConflicts({ repoDir: nonGit }), /Not a git repository/);

    const repo = makeRepo();
    assert.throws(
      () => packConflicts({ repoDir: repo, onto: 'nonexistent-ref' }),
      /Ref not found/,
    );
  });
});
