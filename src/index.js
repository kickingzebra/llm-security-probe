#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry. The orchestration logic lives in run-probe.js; this file only
// parses argv, prints a human-readable summary, and sets the exit code.
//
// Usage:
//   node src/index.js --model gemma3:12b
//   node src/index.js --model gemma3:12b --skip-promptfoo
//   node src/index.js --model gemma3:12b --skip-port-scan
//   node src/index.js --model gemma3:12b --output local-data/runs
//   node src/index.js --list-models
//   node src/index.js --help
// ─────────────────────────────────────────────────────────────────────────────

const { parseArgs } = require('node:util');
const { runProbe, DEFAULT_OUTPUT_DIR } = require('./run-probe');
const { listInstalledModels } = require('./ollama-models');

const USAGE = `
Usage:
  node src/index.js --model <name>            run the full probe (port-scan + promptfoo)
  node src/index.js --model <name> --skip-promptfoo
  node src/index.js --model <name> --skip-port-scan
  node src/index.js --model <name> --output <dir>
  node src/index.js --list-models             list installed Ollama models, exit
  node src/index.js --help                    print this message

Defaults:
  --output  ${DEFAULT_OUTPUT_DIR}
`;

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      model: { type: 'string' },
      output: { type: 'string', default: DEFAULT_OUTPUT_DIR },
      'skip-promptfoo': { type: 'boolean', default: false },
      'skip-port-scan': { type: 'boolean', default: false },
      'list-models': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    },
    allowPositionals: false
  });
}

function formatProgressLine({ index, total, id, status, durationMs }) {
  const seconds = (durationMs / 1000).toFixed(1);
  const tag = status === 'pass' ? 'pass' : 'FAIL';
  return `[${index}/${total}] ${id.padEnd(32)} ${tag.padEnd(4)} (${seconds}s)\n`;
}

function formatSummary(run) {
  const lines = [];
  lines.push('');
  lines.push(`Run ${run.runId}`);
  lines.push(`Model:           ${run.model}`);
  lines.push(`Phase:           ${run.phase}`);
  lines.push(`Started:         ${run.startedAt}`);
  lines.push(`Ended:           ${run.endedAt}`);
  lines.push(`Overall:         ${run.overallStatus.toUpperCase()}`);
  lines.push(
    `Refusal rate:    ${(run.summary.refusalRate * 100).toFixed(1)}%  ` +
      `(${run.summary.passed}/${run.summary.total} refused)`
  );
  lines.push('');
  lines.push('By category:');
  for (const [cat, b] of Object.entries(run.summary.byCategory)) {
    lines.push(
      `  ${cat.padEnd(18)} ${b.passed}/${b.total} refused  ` +
        `(${(b.refusalRate * 100).toFixed(0)}%)`
    );
  }
  if (run.warnings && run.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of run.warnings) lines.push(`  - ${w}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function listModelsCmd() {
  const result = await listInstalledModels();
  if (!result.ok) {
    process.stderr.write(`error: could not reach Ollama: ${result.error.code}\n`);
    process.exit(2);
    return;
  }
  if (result.models.length === 0) {
    process.stdout.write('(no models installed)\n');
    return;
  }
  process.stdout.write('Installed Ollama models:\n');
  for (const m of result.models) {
    process.stdout.write(
      `  ${m.name}  (${m.parameterSize || '?'} ${m.quantization || ''})\n`
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n${USAGE}`);
    process.exit(2);
    return;
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (values['list-models']) {
    await listModelsCmd();
    return;
  }

  if (!values.model) {
    process.stderr.write(`error: --model is required\n${USAGE}`);
    process.exit(2);
    return;
  }

  const result = await runProbe({
    model: values.model,
    outputDir: values.output,
    skipPromptfoo: values['skip-promptfoo'],
    skipPortScan: values['skip-port-scan'],
    onProgress: (event) => process.stderr.write(formatProgressLine(event))
  });

  if (!result.ok) {
    process.stderr.write(`error: ${result.error.code}: ${result.error.message}\n`);
    process.exit(2);
    return;
  }

  process.stdout.write(formatSummary(result.run));
  process.stdout.write(`Wrote: ${result.outputPath}\n`);
  process.exit(result.run.overallStatus === 'pass' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${(err && err.stack) || err}\n`);
    process.exit(2);
  });
}

module.exports = { main, parseCliArgs, formatSummary, formatProgressLine, USAGE };
