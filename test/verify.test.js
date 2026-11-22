import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { formatVerifyMarkdown, verifyResolution } from '../src/verify.js';
import { commitFile, createTempDir, initRepo, removeDir } from './helpers.js';

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

describe('verifyResolution', () => {
  it('passes on a clean repository without markers or test script', () => {
    const repo = makeRepo();
    commitFile(repo, 'index.js', 'export const ok = true;\n', 'feat: add index');

    const result = verifyResolution({ repoDir: repo });
    assert.equal(result.passed, true);
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.markerFindings, []);
    assert.equal(result.commandResult.ran, false);

    const md = formatVerifyMarkdown(result);
    assert.match(md, /ConflictKit Verify: PASSED/);
  });

  it('detects unresolved conflict markers in tracked and untracked files', () => {
    const repo = makeRepo();
    const start = '<'.repeat(7);
    const sep = '='.repeat(7);
    const end = '>'.repeat(7);

    const conflicted = [
      'const x = 1;',
      `${start} HEAD`,
      'const y = 2;',
      sep,
      'const y = 3;',
      `${end} main`,
      '',
    ].join('\n');

    commitFile(repo, 'broken.js', conflicted, 'wip: broken file');
    fs.writeFileSync(
      path.join(repo, 'untracked.txt'),
      `${start} ours\nfoo\n${sep}\nbar\n${end} theirs\n`,
      'utf8',
    );

    const result = verifyResolution({ repoDir: repo });
    assert.equal(result.passed, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.markerFindings.length, 6);
    assert.deepEqual(
      result.markerFindings.map((m) => `${m.file}:${m.line}`),
      [
        'broken.js:2',
        'broken.js:4',
        'broken.js:6',
        'untracked.txt:1',
        'untracked.txt:3',
        'untracked.txt:5',
      ],
    );

    const md = formatVerifyMarkdown(result);
    assert.match(md, /ConflictKit Verify: FAILED/);
    assert.match(md, /broken\.js:2/);
  });

  it('does not flag markdown setext headings as conflict markers', () => {
    const repo = makeRepo();
    commitFile(repo, 'DOC.md', 'Heading\n=======\nBody text.\n', 'docs: add doc');

    const result = verifyResolution({ repoDir: repo });
    assert.equal(result.passed, true);
    assert.deepEqual(result.markerFindings, []);
  });

  it('runs explicit --cmd and reports pass and fail', () => {
    const repo = makeRepo();

    const passRes = verifyResolution({
      repoDir: repo,
      cmd: 'node -e "process.exit(0)"',
    });
    assert.equal(passRes.passed, true);
    assert.equal(passRes.commandResult.ran, true);
    assert.equal(passRes.commandResult.source, 'flag');
    assert.equal(passRes.commandResult.passed, true);

    const failRes = verifyResolution({
      repoDir: repo,
      cmd: 'node -e "console.error(\'boom\'); process.exit(2)"',
    });
    assert.equal(failRes.passed, false);
    assert.equal(failRes.commandResult.ran, true);
    assert.equal(failRes.commandResult.exitCode, 2);
    assert.match(failRes.commandResult.stderr, /boom/);
  });

  it('auto-discovers package.json test script', () => {
    const repo = makeRepo();
    commitFile(
      repo,
      'package.json',
      JSON.stringify(
        {
          name: 'sample',
          version: '1.0.0',
          scripts: { test: 'node -e "console.log(\'ok\')"' },
        },
        null,
        2,
      ),
      'chore: add package.json',
    );

    const result = verifyResolution({ repoDir: repo, base: 'HEAD' });
    assert.equal(result.passed, true);
    assert.equal(result.base, 'HEAD');
    assert.ok(result.baseOid);
    assert.equal(result.commandResult.ran, true);
    assert.equal(result.commandResult.source, 'package.json');
    assert.equal(result.commandResult.passed, true);
  });
});
