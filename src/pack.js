import {
  getCommitLog,
  getCurrentBranch,
  getDiffStat,
  getHunkLineHistory,
  getMergeBase,
  readGitObjectText,
  resolveCommitOid,
  resolveOntoRef,
  resolveRepoRoot,
  runMergeTree,
} from './git.js';

const MARKER_START = '<'.repeat(7);
const MARKER_END = '>'.repeat(7);

/**
 * Find 1-based line ranges of conflict blocks in `conflictMarked` text.
 */
function findConflictLineRanges(conflictMarked) {
  if (!conflictMarked) {
    return [];
  }
  const lines = conflictMarked.split(/\r?\n/);
  const ranges = [];
  let start = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith(`${MARKER_START} `) || line === MARKER_START) {
      start = i + 1;
    } else if (
      start !== null &&
      (line.startsWith(`${MARKER_END} `) || line === MARKER_END)
    ) {
      ranges.push({ start, end: i + 1 });
      start = null;
    }
  }
  return ranges;
}

/**
 * Group merge-tree stage entries by file path.
 */
function groupConflictedFiles(stageEntries) {
  const byPath = new Map();
  for (const entry of stageEntries) {
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, {
        path: entry.path,
        stages: { base: null, ours: null, theirs: null },
      });
    }
    const item = byPath.get(entry.path);
    const info = { oid: entry.oid, mode: entry.mode };
    if (entry.stage === 1) {
      item.stages.base = info;
    } else if (entry.stage === 2) {
      item.stages.ours = info;
    } else if (entry.stage === 3) {
      item.stages.theirs = info;
    }
  }
  return [...byPath.values()];
}

/**
 * Non-destructively pack merge conflict context for `repoDir`.
 */
export function packConflicts(options = {}) {
  const repoRoot = resolveRepoRoot(options.repoDir || '.');
  const ontoInfo = resolveOntoRef(repoRoot, options.onto);
  const headOid = resolveCommitOid(repoRoot, 'HEAD');
  const branch = getCurrentBranch(repoRoot);
  const mergeBase = getMergeBase(repoRoot, ontoInfo.oid, headOid);

  const mergeResult = runMergeTree(repoRoot, headOid, ontoInfo.oid);

  if (mergeResult.clean) {
    return {
      status: 'clean',
      repoRoot,
      branch,
      head: headOid,
      onto: ontoInfo.ref,
      ontoOid: ontoInfo.oid,
      autoDetectedOnto: ontoInfo.autoDetected,
      mergeBase,
      treeOid: mergeResult.treeOid,
      conflicts: [],
    };
  }

  const branchCommits = getCommitLog(repoRoot, `${mergeBase}..${headOid}`);
  const branchDiffStat = getDiffStat(repoRoot, `${mergeBase}..${headOid}`);
  const grouped = groupConflictedFiles(mergeResult.stageEntries);

  const conflicts = grouped.map((item) => {
    const filePath = item.path;
    const baseText = item.stages.base
      ? readGitObjectText(repoRoot, item.stages.base.oid)
      : readGitObjectText(repoRoot, `${mergeBase}:${filePath}`);
    const oursText = item.stages.ours
      ? readGitObjectText(repoRoot, item.stages.ours.oid)
      : readGitObjectText(repoRoot, `${headOid}:${filePath}`);
    const theirsText = item.stages.theirs
      ? readGitObjectText(repoRoot, item.stages.theirs.oid)
      : readGitObjectText(repoRoot, `${ontoInfo.oid}:${filePath}`);
    const conflictMarked = mergeResult.treeOid
      ? readGitObjectText(repoRoot, `${mergeResult.treeOid}:${filePath}`)
      : null;

    const upstreamCommits = getCommitLog(
      repoRoot,
      `${mergeBase}..${ontoInfo.oid}`,
      ['-n', '5', '--', filePath],
    );

    const ranges = findConflictLineRanges(conflictMarked);
    const hunkHistory = [];
    for (const range of ranges.slice(0, 3)) {
      const entries = getHunkLineHistory(
        repoRoot,
        `${mergeBase}..${ontoInfo.oid}`,
        filePath,
        range.start,
        range.end,
      );
      if (entries.length > 0) {
        hunkHistory.push({
          startLine: range.start,
          endLine: range.end,
          commits: entries,
        });
      }
    }

    const fileMessages = mergeResult.messages.filter((msg) =>
      msg.includes(filePath),
    );

    return {
      path: filePath,
      stages: item.stages,
      messages: fileMessages,
      upstreamCommits,
      hunkHistory,
      base: baseText,
      ours: oursText,
      theirs: theirsText,
      conflictMarked,
    };
  });

  return {
    status: 'conflicted',
    repoRoot,
    branch,
    head: headOid,
    onto: ontoInfo.ref,
    ontoOid: ontoInfo.oid,
    autoDetectedOnto: ontoInfo.autoDetected,
    mergeBase,
    treeOid: mergeResult.treeOid,
    branchCommits,
    branchDiffStat,
    messages: mergeResult.messages,
    conflicts,
  };
}

/**
 * Format a `packConflicts` result as concise Markdown.
 */
export function formatPackMarkdown(packResult) {
  if (packResult.status === 'clean') {
    return [
      '# ConflictKit Pack: CLEAN',
      '',
      `- Repo: \`${packResult.repoRoot}\``,
      `- Branch: \`${packResult.branch}\` (\`${packResult.head.slice(0, 8)}\`)`,
      `- Onto: \`${packResult.onto}\` (\`${packResult.ontoOid.slice(0, 8)}\`)`,
      `- Merge-Base: \`${packResult.mergeBase.slice(0, 8)}\``,
      `- Result: CLEAN (0 conflicts)`,
      '',
    ].join('\n');
  }

  const lines = [
    `# ConflictKit Pack: CONFLICTED (${packResult.conflicts.length} file${packResult.conflicts.length === 1 ? '' : 's'})`,
    '',
    `- Repo: \`${packResult.repoRoot}\``,
    `- Branch: \`${packResult.branch}\` (\`${packResult.head.slice(0, 8)}\`)`,
    `- Onto: \`${packResult.onto}\` (\`${packResult.ontoOid.slice(0, 8)}\`)`,
    `- Merge-Base: \`${packResult.mergeBase.slice(0, 8)}\``,
    '',
    '## Current Branch Intent',
    '',
  ];

  if (packResult.branchCommits.length === 0) {
    lines.push('No branch commits found between merge-base and HEAD.', '');
  } else {
    for (const c of packResult.branchCommits) {
      lines.push(`- \`${c.shortHash}\` ${c.subject} (${c.author})`);
    }
    lines.push('');
  }

  if (packResult.branchDiffStat) {
    lines.push('```text', packResult.branchDiffStat, '```', '');
  }

  for (const conflict of packResult.conflicts) {
    lines.push(`## File: \`${conflict.path}\``, '');
    if (conflict.messages.length > 0) {
      for (const msg of conflict.messages) {
        lines.push(`- ${msg}`);
      }
      lines.push('');
    }

    lines.push('### Upstream Commits Touching File', '');
    if (conflict.upstreamCommits.length === 0) {
      lines.push('No upstream commits found in range.', '');
    } else {
      for (const c of conflict.upstreamCommits) {
        lines.push(`- \`${c.shortHash}\` ${c.subject} (${c.author})`);
      }
      lines.push('');
    }

    if (conflict.hunkHistory.length > 0) {
      lines.push('### Hunk Line History', '');
      for (const h of conflict.hunkHistory) {
        lines.push(`- Lines ${h.startLine}-${h.endLine}:`);
        for (const entry of h.commits) {
          lines.push(`  - ${entry}`);
        }
      }
      lines.push('');
    }

    lines.push('### 3-Way Context', '');
    if (conflict.conflictMarked !== null) {
      lines.push('#### Conflict Markers', '', '```', conflict.conflictMarked.trimEnd(), '```', '');
    }
    if (conflict.base !== null) {
      lines.push('#### Base', '', '```', conflict.base.trimEnd(), '```', '');
    }
    if (conflict.ours !== null) {
      lines.push('#### Ours (HEAD)', '', '```', conflict.ours.trimEnd(), '```', '');
    }
    if (conflict.theirs !== null) {
      lines.push(`#### Theirs (${packResult.onto})`, '', '```', conflict.theirs.trimEnd(), '```', '');
    }
  }

  return lines.join('\n');
}
