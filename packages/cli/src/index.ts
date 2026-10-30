#!/usr/bin/env bun
import { SQL } from 'bun';
import {
  DefinitionValidationError,
  EventLogCorruptError,
  checkFiles,
  createVersion,
  diffDefinitions,
  isCanonical,
  loadDefinition,
  rebuildReadModel,
  renderDiffText,
  resolveImprovement,
  serializeDefinition,
  writeFiles,
  type RebuildReport,
  type ValidationError,
} from '@factory/core';

type Flags = Record<string, string | boolean>;

interface ParsedArgs {
  positionals: string[];
  flags: Flags;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
        flags[name] = argv[index + 1];
        index += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/** Prints code, file, pointer, message — in that order. */
function printErrors(errors: ValidationError[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(errors, null, 2)}\n`);
    return;
  }
  for (const error of errors) {
    const pointer = error.pointer === '' ? '/' : error.pointer;
    process.stdout.write(`${error.code} ${error.file} ${pointer}: ${error.message}\n`);
  }
}

function fail(errors: ValidationError[], json: boolean): never {
  printErrors(errors, json);
  process.exit(1);
}

function requireDir(positionals: string[], command: string): string {
  const dir = positionals[0];
  if (!dir) {
    process.stderr.write(`factory ${command}: missing <dir>\n`);
    process.exit(2);
  }
  return dir;
}

function load(dir: string, json: boolean) {
  const result = loadDefinition(dir);
  if (!result.definition) fail(result.errors, json);
  return result.definition;
}

const HELP = `factory — validate, export, import, diff and pin factory definitions

Usage:
  factory validate <dir> [--json]
  factory export <dir> --out <dir> [--check]
  factory import <dir> [--json]
  factory diff <a> <b> [--json] [--exit-code]
  factory fmt <dir>
  factory version <dir> [--allow-dirty]
  factory rebuild --from <runs-dir> [--dry-run] [--json]

Exit codes: 0 ok, 1 validation/diff/corrupt-log failure, 2 usage error.
`;

function cmdValidate(positionals: string[], flags: Flags): void {
  const dir = requireDir(positionals, 'validate');
  const json = flags.json === true;
  const { definition, errors } = loadDefinition(dir);

  if (!definition) fail(errors, json);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          factory: definition.manifest.name,
          resources: definition.resources.length,
          improvement: resolveImprovement(definition.manifest.improvement),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const improvement = resolveImprovement(definition.manifest.improvement);
    process.stdout.write(
      `ok: ${definition.manifest.name} (${definition.resources.length} resources) in ${dir}\n`,
    );
    process.stdout.write(
      `improvement: authority=${improvement.authority} (${improvement.source})${
        improvement.authority === 'canary'
          ? ` canaryPercent=${improvement.canaryPercent ?? 'unset'} rollbackThreshold=${improvement.rollbackThreshold ?? 'unset'} observationWindowHours=${improvement.observationWindowHours}`
          : ''
      } maxProbes=${improvement.maxProbes}\n`,
    );
  }
}

function cmdExport(positionals: string[], flags: Flags): void {
  const dir = requireDir(positionals, 'export');
  const definition = load(dir, false);
  const files = serializeDefinition(definition);

  if (flags.check === true) {
    const check = checkFiles(dir, files);
    if (!isCanonical(check)) {
      for (const path of check.missing) process.stdout.write(`missing ${path}\n`);
      for (const path of check.changed) process.stdout.write(`not canonical ${path}\n`);
      for (const path of check.extra) process.stdout.write(`unexpected ${path}\n`);
      process.exit(1);
    }
    process.stdout.write(`canonical: ${files.length} files in ${dir}\n`);
    return;
  }

  const out = flags.out;
  if (typeof out !== 'string') {
    process.stderr.write('factory export: --out <dir> is required (or use --check)\n');
    process.exit(2);
  }

  writeFiles(out, files);
  process.stdout.write(`wrote ${files.length} files to ${out}\n`);
}

function cmdImport(positionals: string[], flags: Flags): void {
  const dir = requireDir(positionals, 'import');
  const definition = load(dir, flags.json === true);

  const summary = {
    factory: definition.manifest.name,
    resources: definition.resources.map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      path: resource.path,
    })),
  };

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      `imported ${summary.factory}: ${summary.resources.length} resources (no DB writes)\n`,
    );
  }
}

function cmdDiff(positionals: string[], flags: Flags): void {
  if (positionals.length < 2) {
    process.stderr.write('factory diff: requires <a> <b>\n');
    process.exit(2);
  }
  const [a, b] = positionals;
  const before = load(a, flags.json === true);
  const after = load(b, flags.json === true);
  const diff = diffDefinitions(before, after);

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else {
    const text = renderDiffText(diff);
    process.stdout.write(text.length > 0 ? text : 'no semantic differences\n');
  }

  if (flags['exit-code'] === true && !diff.isEmpty) process.exit(1);
}

function cmdFmt(positionals: string[]): void {
  const dir = requireDir(positionals, 'fmt');
  const definition = load(dir, false);
  const files = serializeDefinition(definition);
  writeFiles(dir, files);
  process.stdout.write(`formatted ${files.length} files in ${dir}\n`);
}

function cmdVersion(positionals: string[], flags: Flags): void {
  const dir = requireDir(positionals, 'version');
  try {
    const record = createVersion(dir, { allowDirty: flags['allow-dirty'] === true });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    if (error instanceof DefinitionValidationError) fail(error.errors, flags.json === true);
    process.stderr.write(`factory version: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function printRebuildReport(report: RebuildReport): void {
  const { diff, scanned, written } = report;
  const counts = (values: string[]): string => String(values.length);
  process.stdout.write(`scanned ${scanned.runs} run(s), ${scanned.events} event(s)\n`);
  process.stdout.write(
    `missing:   runs ${counts(diff.missing.runs)}, steps ${counts(diff.missing.steps)}, events ${counts(diff.missing.events)}\n`,
  );
  process.stdout.write(
    `divergent: runs ${counts(diff.divergent.runs)}, steps ${counts(diff.divergent.steps)}, events ${counts(diff.divergent.events)}\n`,
  );
  process.stdout.write(
    `orphaned:  runs ${counts(diff.orphaned.runs)}, steps ${counts(diff.orphaned.steps)}, events ${counts(diff.orphaned.events)} (kept, never deleted)\n`,
  );

  for (const [label, entries] of [
    ['missing run', diff.missing.runs],
    ['missing step', diff.missing.steps],
    ['missing event', diff.missing.events],
    ['divergent run', diff.divergent.runs],
    ['divergent step', diff.divergent.steps],
    ['divergent event', diff.divergent.events],
    ['orphaned run', diff.orphaned.runs],
    ['orphaned step', diff.orphaned.steps],
    ['orphaned event', diff.orphaned.events],
  ] as const) {
    for (const entry of entries.slice(0, 20)) process.stdout.write(`  ${label} ${entry}\n`);
    if (entries.length > 20) process.stdout.write(`  … and ${entries.length - 20} more ${label}(s)\n`);
  }

  if (report.dryRun) {
    process.stdout.write('dry run: no rows written\n');
    return;
  }
  process.stdout.write(
    `wrote ${written.runs} run(s), ${written.steps} step(s), ${written.events} event(s)\n`,
  );
}

async function cmdRebuild(flags: Flags): Promise<void> {
  const from = typeof flags.from === 'string' ? flags.from : 'runs';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('factory rebuild: DATABASE_URL is required\n');
    process.exit(2);
  }

  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    const report = await rebuildReadModel(sql, {
      runsDir: from,
      dryRun: flags['dry-run'] === true,
      ...(typeof flags.run === 'string' ? { runId: flags.run } : {}),
    });
    if (flags.json === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printRebuildReport(report);
    }
  } catch (error) {
    if (error instanceof EventLogCorruptError) {
      for (const log of error.logs) {
        process.stderr.write(
          `event_log_corrupt ${log.runId} seq ${log.seq} (${log.reason}): ${log.detail}\n`,
        );
      }
      process.exit(1);
    }
    process.stderr.write(
      `factory rebuild: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  } finally {
    await sql.close();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }

  const { positionals, flags } = parseArgs(rest);

  switch (command) {
    case 'validate':
      cmdValidate(positionals, flags);
      return;
    case 'export':
      cmdExport(positionals, flags);
      return;
    case 'import':
      cmdImport(positionals, flags);
      return;
    case 'diff':
      cmdDiff(positionals, flags);
      return;
    case 'fmt':
      cmdFmt(positionals);
      return;
    case 'version':
      cmdVersion(positionals, flags);
      return;
    case 'rebuild':
      await cmdRebuild(flags);
      return;
    default:
      process.stderr.write(`factory: unknown command "${command}"\n\n${HELP}`);
      process.exit(2);
  }
}

await main();
