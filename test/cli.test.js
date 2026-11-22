import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitFile, createTempDir, git, initRepo, removeDir } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BIN_PATH = path.join(PROJECT_ROOT, 'bin', 'conflictkit.js');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    removeDir(tempDirs.pop());
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    shell: false,
  });
}

describe('conflictkit CLI', () => {
  it('supports --help and --version', () => {
    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /conflictkit pack/);
    assert.match(help.stdout, /conflictkit verify/);

    const version = runCli(['--version']);
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('writes JSON bundle via pack --json --out and verifies clean repo', () => {
    const repo = createTempDir();
    tempDirs.push(repo);
    initRepo(repo);
    commitFile(repo, 'file.txt', 'base\n', 'base');

    git(repo, ['checkout', '-b', 'feat']);
    commitFile(repo, 'file.txt', 'ours\n', 'ours');

    git(repo, ['checkout', 'main']);
    commitFile(repo, 'file.txt', 'theirs\n', 'theirs');

    git(repo, ['checkout', 'feat']);

    const outDir = createTempDir('conflictkit-out-');
    tempDirs.push(outDir);
    const outFile = path.join(outDir, 'bundle.json');

    const packRes = runCli(['pack', repo, '--onto', 'main', '--json', '--out', outFile]);
    assert.equal(packRes.status, 0, packRes.stderr);
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(parsed.status, 'conflicted');
    assert.equal(parsed.conflicts.length, 1);
    assert.equal(parsed.conflicts[0].path, 'file.txt');

    const verifyClean = runCli(['verify', repo, '--json']);
    assert.equal(verifyClean.status, 0);
    assert.equal(JSON.parse(verifyClean.stdout).passed, true);

    const start = '<'.repeat(7);
    const end = '>'.repeat(7);
    fs.writeFileSync(path.join(repo, 'file.txt'), `${start} HEAD\nx\n${end} main\n`, 'utf8');
    const verifyDirty = runCli(['verify', repo, '--json']);
    assert.equal(verifyDirty.status, 1);
    assert.equal(JSON.parse(verifyDirty.stdout).passed, false);
  });

  it('contains zero em dashes (U+2014) in project files', () => {
    const filesToCheck = [
      'package.json',
      'README.md',
      'LICENSE',
      '.github/workflows/ci.yml',
      'bin/conflictkit.js',
      'src/git.js',
      'src/pack.js',
      'src/verify.js',
      'test/helpers.js',
      'test/pack.test.js',
      'test/verify.test.js',
      'test/cli.test.js',
    ];
    for (const rel of filesToCheck) {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      assert.equal(content.includes('\u2014'), false, `Found em dash in ${rel}`);
    }
  });
});
