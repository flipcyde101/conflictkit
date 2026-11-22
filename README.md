# conflictkit

Non-destructive git merge conflict context packer and resolution verifier.

Zero runtime dependencies. Requires Node.js 24+ and `git`.

## Usage

### Pack conflict context

Simulates merging `HEAD` onto an upstream ref without modifying your working tree or index:

```bash
conflictkit pack [repoDir] [--onto <ref>] [--out <file>] [--json]
```

- Auto-detects upstream base (`upstream/main`, `origin/main`, `main`, `master`) if `--onto` is omitted.
- Reports `CLEAN` (exit 0) if the merge has no conflicts.
- When conflicted, extracts:
  1. Current branch commits and diff summary (`<mergeBase>..HEAD`).
  2. Recent upstream commits touching each conflicted file and hunk line history.
  3. Structured 3-way conflict context (`base`, `ours`, `theirs`, and conflict-marked content).

### Verify conflict resolution

Checks that no unresolved conflict markers remain and optionally runs tests:

```bash
conflictkit verify [repoDir] [--base <ref>] [--cmd <testCmd>] [--json]
```

- Scans tracked and non-ignored working files for `<<<<<<<`, `=======`, and `>>>>>>>` markers.
- Runs `--cmd` if provided, or auto-discovers `package.json` `scripts.test` when present.
- Exits non-zero if conflict markers remain or the test command fails.

### Other options

```bash
conflictkit --help
conflictkit --version
```
