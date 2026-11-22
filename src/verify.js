import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  listWorkingFiles,
  resolveCommitOid,
  resolveRepoRoot,
} from './git.js';

const MARKER_START_RE = /^<{7}(?: |$)/;
const MARKER_SEP_RE = /^={7}$/;
const MARKER_END_RE = /^>{7}(?: |$)/;
const DEFAULT_NPM_TEST_STUB = 'echo "Error: no test specified" && exit 1';

/**
 * Scan a single file for unresolved git conflict markers.
 */
function scanFileForMarkers(repoRoot, relPath) {
  const fullPath = path.join(repoRoot, relPath);
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return [];
  }
  if (!stat.isFile()) {
    return [];
  }

  const buf = fs.readFileSync(fullPath);
  if (buf.includes(0)) {
    return [];
  }

  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  const hits = [];
  let inConflict = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (MARKER_START_RE.test(line)) {
      inConflict = true;
      hits.push({ file: relPath, line: i + 1, marker: line.trimEnd() });
    } else if (MARKER_END_RE.test(line)) {
      inConflict = false;
      hits.push({ file: relPath, line: i + 1, marker: line.trimEnd() });
    } else if (inConflict && MARKER_SEP_RE.test(line)) {
      hits.push({ file: relPath, line: i + 1, marker: line.trimEnd() });
    }
  }

  return hits;
}

/**
 * Resolve the verification command from `--cmd` or `package.json` `scripts.test`.
 */
function resolveTestCommand(repoRoot, explicitCmd) {
  if (explicitCmd) {
    return { command: explicitCmd, source: 'flag', isNpmTest: false };
  }

  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const testScript = pkg?.scripts?.test;
    if (
      typeof testScript === 'string' &&
      testScript.trim() !== '' &&
      testScript.trim() !== DEFAULT_NPM_TEST_STUB
    ) {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      return {
        command: `${npmBin} test`,
        source: 'package.json',
        isNpmTest: true,
        npmBin,
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Execute the verification command in `repoRoot`.
 */
function runTestCommand(repoRoot, resolvedCmd) {
  if (!resolvedCmd) {
    return {
      ran: false,
      command: null,
      source: null,
      passed: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  }

  const result = spawnSync(resolvedCmd.command, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });

  const exitCode = result.status ?? 1;
  const errorMsg = result.error ? result.error.message : '';

  return {
    ran: true,
    command: resolvedCmd.command,
    source: resolvedCmd.source,
    passed: exitCode === 0 && !result.error,
    exitCode,
    stdout: result.stdout ?? '',
    stderr: errorMsg
      ? `${result.stderr ?? ''}\n${errorMsg}`.trim()
      : (result.stderr ?? ''),
  };
}

/**
 * Verify that `repoDir` has no unresolved conflict markers and passes tests.
 */
export function verifyResolution(options = {}) {
  const repoRoot = resolveRepoRoot(options.repoDir || '.');
  let baseOid = null;
  if (options.base) {
    baseOid = resolveCommitOid(repoRoot, options.base);
  }

  const files = listWorkingFiles(repoRoot);
  const markerFindings = [];
  for (const relPath of files) {
    const hits = scanFileForMarkers(repoRoot, relPath);
    markerFindings.push(...hits);
  }

  const resolvedCmd = resolveTestCommand(repoRoot, options.cmd);
  const commandResult = runTestCommand(repoRoot, resolvedCmd);

  const passed =
    markerFindings.length === 0 &&
    (!commandResult.ran || commandResult.passed);

  return {
    status: passed ? 'passed' : 'failed',
    passed,
    repoRoot,
    base: options.base || null,
    baseOid,
    scannedFiles: files.length,
    markerFindings,
    commandResult,
  };
}

/**
 * Format a `verifyResolution` result as concise Markdown.
 */
export function formatVerifyMarkdown(verifyResult) {
  const header = verifyResult.passed
    ? '# ConflictKit Verify: PASSED'
    : '# ConflictKit Verify: FAILED';

  const lines = [
    header,
    '',
    `- Repo: \`${verifyResult.repoRoot}\``,
    `- Scanned files: ${verifyResult.scannedFiles}`,
    `- Conflict markers found: ${verifyResult.markerFindings.length}`,
  ];

  if (verifyResult.base) {
    lines.push(
      `- Base: \`${verifyResult.base}\` (\`${verifyResult.baseOid.slice(0, 8)}\`)`,
    );
  }

  if (verifyResult.commandResult.ran) {
    lines.push(
      `- Command (\`${verifyResult.commandResult.source}\`): \`${verifyResult.commandResult.command}\` -> ${verifyResult.commandResult.passed ? 'PASS' : `FAIL (exit ${verifyResult.commandResult.exitCode})`}`,
    );
  } else {
    lines.push('- Command: none (no --cmd or package.json test script)');
  }

  if (verifyResult.markerFindings.length > 0) {
    lines.push('', '## Unresolved Conflict Markers', '');
    for (const hit of verifyResult.markerFindings) {
      lines.push(`- \`${hit.file}:${hit.line}\` \`${hit.marker}\``);
    }
  }

  if (
    verifyResult.commandResult.ran &&
    !verifyResult.commandResult.passed
  ) {
    const output = [
      verifyResult.commandResult.stdout,
      verifyResult.commandResult.stderr,
    ]
      .filter((s) => s && s.trim())
      .join('\n')
      .trim();
    if (output) {
      lines.push('', '## Command Output', '', '```text', output, '```');
    }
  }

  lines.push('');
  return lines.join('\n');
}
