import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTempDir(prefix = 'conflictkit-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

export function git(cwd, args) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${res.status}): ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout.trim();
}

/**
 * Initialize a git repo with an initial commit on `main`.
 */
export function initRepo(repoDir) {
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'init\n', 'utf8');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-m', 'chore: initial commit']);
}

export function commitFile(repoDir, relPath, content, message) {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  git(repoDir, ['add', relPath]);
  git(repoDir, ['commit', '-m', message]);
}
