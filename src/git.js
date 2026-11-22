import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_BASE_CANDIDATES = [
  'upstream/main',
  'origin/main',
  'main',
  'master',
];

/**
 * Run a git command in `repoDir` without invoking a shell.
 */
export function runGit(repoDir, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to execute git: ${result.error.message}`);
  }

  const status = result.status ?? 1;
  if (!options.allowFailure && status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `git ${args.join(' ')} failed (exit ${status})${detail ? `: ${detail}` : ''}`,
    );
  }

  return {
    status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Verify `repoDir` is inside a git repository and return its normalized root path.
 */
export function resolveRepoRoot(repoDir) {
  const resolved = path.resolve(repoDir || '.');
  const res = runGit(resolved, ['rev-parse', '--show-toplevel'], {
    allowFailure: true,
  });
  if (res.status !== 0) {
    throw new Error(`Not a git repository: ${resolved}`);
  }
  return path.resolve(res.stdout.trim());
}

/**
 * Resolve an explicit `--onto` ref or auto-detect the upstream base ref.
 */
export function resolveOntoRef(repoDir, explicitOnto) {
  if (explicitOnto) {
    const check = runGit(
      repoDir,
      ['rev-parse', '--verify', '--quiet', `${explicitOnto}^{commit}`],
      { allowFailure: true },
    );
    if (check.status !== 0) {
      throw new Error(`Ref not found or not a commit: ${explicitOnto}`);
    }
    return {
      ref: explicitOnto,
      oid: check.stdout.trim(),
      autoDetected: false,
    };
  }

  for (const candidate of DEFAULT_BASE_CANDIDATES) {
    const check = runGit(
      repoDir,
      ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
      { allowFailure: true },
    );
    if (check.status === 0) {
      return {
        ref: candidate,
        oid: check.stdout.trim(),
        autoDetected: true,
      };
    }
  }

  throw new Error(
    `Could not auto-detect upstream base (tried ${DEFAULT_BASE_CANDIDATES.join(', ')}). Pass --onto <ref>.`,
  );
}

/**
 * Resolve a ref to a commit OID, or throw if missing.
 */
export function resolveCommitOid(repoDir, ref) {
  const res = runGit(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return res.stdout.trim();
}

/**
 * Get the current branch name (or 'HEAD' if detached).
 */
export function getCurrentBranch(repoDir) {
  const res = runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'], {
    allowFailure: true,
  });
  return res.status === 0 ? res.stdout.trim() : 'HEAD';
}

/**
 * Compute the merge-base commit OID between `onto` and `head`.
 */
export function getMergeBase(repoDir, onto, head = 'HEAD') {
  const res = runGit(repoDir, ['merge-base', onto, head]);
  return res.stdout.trim();
}

/**
 * Parse `git log` output formatted with tab-separated fields.
 */
export function getCommitLog(repoDir, range, extraArgs = []) {
  const format = '%H%x09%h%x09%s%x09%an%x09%aI';
  const res = runGit(
    repoDir,
    ['log', `--format=${format}`, range, ...extraArgs],
    { allowFailure: true },
  );
  if (res.status !== 0 || !res.stdout.trim()) {
    return [];
  }
  return res.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, date] = line.split('\t');
      return { hash, shortHash, subject, author, date };
    });
}

/**
 * Get `git diff --stat` summary for a range.
 */
export function getDiffStat(repoDir, range) {
  const res = runGit(repoDir, ['diff', '--stat', range], {
    allowFailure: true,
  });
  return res.status === 0 ? res.stdout.trim() : '';
}

/**
 * Read a blob or tree-path as UTF-8 text, returning null if absent.
 */
export function readGitObjectText(repoDir, spec) {
  const res = runGit(repoDir, ['show', spec], { allowFailure: true });
  if (res.status !== 0) {
    return null;
  }
  return res.stdout;
}

/**
 * Run non-destructive `git merge-tree --write-tree --messages` between HEAD and `onto`.
 */
export function runMergeTree(repoDir, headRef, ontoRef) {
  const res = runGit(
    repoDir,
    ['merge-tree', '--write-tree', '--messages', headRef, ontoRef],
    { allowFailure: true },
  );

  if (res.status !== 0 && res.status !== 1) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(
      `git merge-tree failed (exit ${res.status})${detail ? `: ${detail}` : ''}`,
    );
  }

  const lines = res.stdout.split(/\r?\n/);
  const treeOid = (lines[0] || '').trim();
  const stageEntries = [];
  const messages = [];

  let inMessages = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inMessages) {
      if (line === '') {
        inMessages = true;
        continue;
      }
      const tabIdx = line.indexOf('\t');
      if (tabIdx !== -1) {
        const meta = line.slice(0, tabIdx).trim().split(/\s+/);
        const filePath = line.slice(tabIdx + 1);
        if (meta.length >= 3) {
          stageEntries.push({
            mode: meta[0],
            oid: meta[1],
            stage: Number(meta[2]),
            path: filePath,
          });
        }
      }
    } else if (line.trim()) {
      messages.push(line.trim());
    }
  }

  return {
    clean: res.status === 0,
    treeOid,
    stageEntries,
    messages,
  };
}

/**
 * Get best-effort hunk line history for a file in `range`.
 */
export function getHunkLineHistory(repoDir, range, filePath, startLine, endLine) {
  if (!startLine || !endLine || endLine < startLine) {
    return [];
  }
  const res = runGit(
    repoDir,
    [
      'log',
      '-n',
      '3',
      '--no-patch',
      '--format=%h %s (%an)',
      `-L`,
      `${startLine},${endLine}:${filePath}`,
      range,
    ],
    { allowFailure: true },
  );
  if (res.status !== 0 || !res.stdout.trim()) {
    return [];
  }
  return res.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
}

/**
 * List tracked and untracked non-ignored files in `repoDir`.
 */
export function listWorkingFiles(repoDir) {
  const res = runGit(repoDir, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (!res.stdout) {
    return [];
  }
  return res.stdout.split('\0').filter(Boolean).sort();
}
