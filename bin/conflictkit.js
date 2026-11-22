#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPackMarkdown, packConflicts } from '../src/pack.js';
import { formatVerifyMarkdown, verifyResolution } from '../src/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, '..', 'package.json');

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  return pkg.version || '0.0.0';
}

function printHelp() {
  const help = `conflictkit v${readVersion()}

Non-destructive git merge conflict context packer and resolution verifier.

Usage:
  conflictkit pack [repoDir] [--onto <ref>] [--out <file>] [--json]
  conflictkit verify [repoDir] [--base <ref>] [--cmd <testCmd>] [--json]
  conflictkit --help | -h
  conflictkit --version | -v

Commands:
  pack      Simulate merging HEAD onto <ref> without mutating the working tree.
            Auto-detects upstream/main, origin/main, main, or master if --onto is omitted.
  verify    Check that no conflict markers remain and optionally run tests.
            Auto-discovers package.json scripts.test if --cmd is omitted.
`;
  process.stdout.write(help);
}

/**
 * Parse CLI arguments for a subcommand, supporting flags with values and booleans.
 */
function parseArgs(argv, valueFlags, booleanFlags) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v' || arg === '-V') {
      flags.version = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;

    if (booleanFlags.has(flagName)) {
      flags[flagName.slice(2)] = true;
      continue;
    }

    if (valueFlags.has(flagName)) {
      if (eqIdx !== -1) {
        flags[flagName.slice(2)] = arg.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`Missing value for ${flagName}`);
        }
        flags[flagName.slice(2)] = next;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  return { positionals, flags };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v' || args[0] === '-V') {
    process.stdout.write(`${readVersion()}\n`);
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  try {
    if (command === 'pack') {
      const { positionals, flags } = parseArgs(
        rest,
        new Set(['--onto', '--out']),
        new Set(['--json']),
      );
      if (flags.help) {
        printHelp();
        process.exit(0);
      }
      if (flags.version) {
        process.stdout.write(`${readVersion()}\n`);
        process.exit(0);
      }
      if (positionals.length > 1) {
        throw new Error(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
      }

      const result = packConflicts({
        repoDir: positionals[0] || '.',
        onto: flags.onto,
      });

      const output = flags.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatPackMarkdown(result)}\n`;

      if (flags.out) {
        const outPath = path.resolve(flags.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, output, 'utf8');
      } else {
        process.stdout.write(output);
      }
      process.exit(0);
    }

    if (command === 'verify') {
      const { positionals, flags } = parseArgs(
        rest,
        new Set(['--base', '--cmd']),
        new Set(['--json']),
      );
      if (flags.help) {
        printHelp();
        process.exit(0);
      }
      if (flags.version) {
        process.stdout.write(`${readVersion()}\n`);
        process.exit(0);
      }
      if (positionals.length > 1) {
        throw new Error(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
      }

      const result = verifyResolution({
        repoDir: positionals[0] || '.',
        base: flags.base,
        cmd: flags.cmd,
      });

      const output = flags.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatVerifyMarkdown(result)}\n`;

      process.stdout.write(output);
      process.exit(result.passed ? 0 : 1);
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
