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
//   node src/index.js --serve --open
//   node src/index.js --list-models
//   node src/index.js --help
// ─────────────────────────────────────────────────────────────────────────────

const { parseArgs } = require('node:util');
const { runProbe, DEFAULT_OUTPUT_DIR } = require('./run-probe');
const { listInstalledModels } = require('./ollama-models');
const { startServer, DEFAULT_HOST, DEFAULT_PORT } = require('./server');
const { regenerateIndex } = require('./run-index');
const { openBrowser } = require('./open-browser');

const USAGE = `
Usage:
  node src/index.js --model <name>            run the full probe (port-scan + promptfoo)
  node src/index.js --model <name> --skip-promptfoo
  node src/index.js --model <name> --skip-port-scan
  node src/index.js --model <name> --skip-malware-authoring
  node src/index.js --model <name> --skip-web-exploitation
  node src/index.js --model <name> --skip-credential-attacks
  node src/index.js --model <name> --skip-privilege-escalation
  node src/index.js --model <name> --skip-encoded-jailbreaks
  node src/index.js --model <name> --skip-roleplay-bypass
  node src/index.js --model <name> --skip-multi-turn-pressure
  node src/index.js --model <name> --skip-indirect-injection
  node src/index.js --model <name> --skip-ollama-api-audit
  node src/index.js --model <name> --skip-html-report
  node src/index.js --model <name> --output <dir>
  node src/index.js --sweep <m1,m2,m3>         run the probe sequentially across N models
  node src/index.js --serve                    start the read-only dashboard server
  node src/index.js --serve --host <host> --port <n>
  node src/index.js --serve --open             open /live.html in the local browser
  node src/index.js --list-models             list installed Ollama models, exit
  node src/index.js --help                    print this message

Defaults:
  --output  ${DEFAULT_OUTPUT_DIR}
  --host    ${DEFAULT_HOST}
  --port    ${DEFAULT_PORT}
`;

function parseCliArgs(argv) {
  const parsed = parseArgs({
    args: argv,
    options: {
      model: { type: 'string' },
      output: { type: 'string', default: DEFAULT_OUTPUT_DIR },
      sweep: { type: 'string' },
      serve: { type: 'boolean', default: false },
      host: { type: 'string', default: DEFAULT_HOST },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      open: { type: 'boolean', default: false },
      'skip-promptfoo': { type: 'boolean', default: false },
      'skip-port-scan': { type: 'boolean', default: false },
      'skip-malware-authoring': { type: 'boolean', default: false },
      'skip-web-exploitation': { type: 'boolean', default: false },
      'skip-credential-attacks': { type: 'boolean', default: false },
      'skip-privilege-escalation': { type: 'boolean', default: false },
      'skip-encoded-jailbreaks': { type: 'boolean', default: false },
      'skip-roleplay-bypass': { type: 'boolean', default: false },
      'skip-multi-turn-pressure': { type: 'boolean', default: false },
      'skip-indirect-injection': { type: 'boolean', default: false },
      'skip-ollama-api-audit': { type: 'boolean', default: false },
      'skip-html-report': { type: 'boolean', default: false },
      'list-models': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    },
    allowPositionals: false
  });

  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('option --port must be an integer between 0 and 65535');
  }
  parsed.values.port = port;

  if (parsed.values.sweep !== undefined) {
    const models = parsed.values.sweep
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (models.length === 0) {
      throw new TypeError(
        'option --sweep requires a comma-separated list of model names'
      );
    }
    parsed.values.sweep = models;
  }

  return parsed;
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

function defaultWaitForShutdown() {
  return new Promise((resolve) => {
    const signals = ['SIGINT', 'SIGTERM'];
    let settled = false;
    const handlers = new Map();

    const finish = (signal) => {
      if (settled) return;
      settled = true;
      for (const [name, handler] of handlers) {
        process.removeListener(name, handler);
      }
      resolve(signal);
    };

    for (const signal of signals) {
      const handler = () => finish(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  });
}

function buildLiveUrl(serverUrl) {
  return `${serverUrl.replace(/\/+$/, '')}/live.html`;
}

async function listModelsCmd(deps = {}) {
  const {
    listModels = listInstalledModels,
    writeStdout = (text) => process.stdout.write(text),
    writeStderr = (text) => process.stderr.write(text),
    exit = (code) => process.exit(code)
  } = deps;

  const result = await listModels();
  if (!result.ok) {
    writeStderr(`error: could not reach Ollama: ${result.error.code}\n`);
    exit(2);
    return;
  }
  if (result.models.length === 0) {
    writeStdout('(no models installed)\n');
    return;
  }
  writeStdout('Installed Ollama models:\n');
  for (const m of result.models) {
    writeStdout(`  ${m.name}  (${m.parameterSize || '?'} ${m.quantization || ''})\n`);
  }
}

async function serveCmd(values, deps = {}) {
  const {
    rebuildIndex = regenerateIndex,
    startServerImpl = startServer,
    openBrowserImpl = openBrowser,
    waitForShutdown = defaultWaitForShutdown,
    writeStdout = (text) => process.stdout.write(text),
    writeStderr = (text) => process.stderr.write(text)
  } = deps;

  const indexResult = await rebuildIndex({ outputDir: values.output });
  const livePath = indexResult.livePath || `${values.output}/live.html`;

  const server = await startServerImpl({
    runsDir: values.output,
    host: values.host,
    port: values.port
  });
  const liveUrl = buildLiveUrl(server.url);

  writeStdout(`Serving runs from: ${values.output}\n`);
  writeStdout(`Server:            ${server.url}\n`);
  writeStdout(`Live dashboard:    ${liveUrl}\n`);
  writeStdout(`Live page file:    ${livePath}\n`);
  writeStdout('Press Ctrl+C to stop.\n');

  if (values.open) {
    try {
      await openBrowserImpl(liveUrl);
    } catch (err) {
      writeStderr(`warning: could not open browser: ${err.message || err}\n`);
    }
  }

  try {
    await waitForShutdown();
  } finally {
    await server.close();
  }
}

async function sweepCmd(values, deps = {}) {
  const {
    runProbeImpl = runProbe,
    writeStdout = (text) => process.stdout.write(text),
    writeStderr = (text) => process.stderr.write(text),
    exit = (code) => process.exit(code)
  } = deps;

  const results = [];
  let anyError = false;
  let anyFail = false;

  for (let i = 0; i < values.sweep.length; i++) {
    const model = values.sweep[i];
    writeStdout(`\n=== [${i + 1}/${values.sweep.length}] ${model} ===\n`);

    const result = await runProbeImpl({
      model,
      outputDir: values.output,
      skipPromptfoo: values['skip-promptfoo'],
      skipPortScan: values['skip-port-scan'],
      skipMalwareAuthoring: values['skip-malware-authoring'],
      skipWebExploitation: values['skip-web-exploitation'],
      skipCredentialAttacks: values['skip-credential-attacks'],
      skipPrivilegeEscalation: values['skip-privilege-escalation'],
      skipEncodedJailbreaks: values['skip-encoded-jailbreaks'],
      skipRoleplayBypass: values['skip-roleplay-bypass'],
      skipMultiTurnPressure: values['skip-multi-turn-pressure'],
      skipIndirectInjection: values['skip-indirect-injection'],
      skipOllamaApiAudit: values['skip-ollama-api-audit'],
      htmlReport: !values['skip-html-report'],
      onProgress: (event) => writeStderr(formatProgressLine(event))
    });

    if (!result.ok) {
      writeStderr(`error: ${result.error.code}: ${result.error.message}\n`);
      anyError = true;
      results.push({ model, ok: false, error: result.error });
      continue;
    }

    writeStdout(formatSummary(result.run));
    if (result.run.overallStatus === 'fail') anyFail = true;
    results.push({ model, ok: true, run: result.run });
  }

  writeStdout('\n=== Sweep summary ===\n');
  for (const r of results) {
    if (!r.ok) {
      writeStdout(`  ${r.model.padEnd(24)} ERROR  ${r.error.code}\n`);
    } else {
      const status = r.run.overallStatus.toUpperCase();
      const rate = (r.run.summary.refusalRate * 100).toFixed(1);
      writeStdout(
        `  ${r.model.padEnd(24)} ${status.padEnd(4)}  ${r.run.summary.passed}/${r.run.summary.total} refused (${rate}%)\n`
      );
    }
  }
  writeStdout('\n');

  exit(anyError ? 2 : anyFail ? 1 : 0);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    runProbe: runProbeImpl = runProbe,
    listModels = listInstalledModels,
    rebuildIndex = regenerateIndex,
    startServerImpl = startServer,
    openBrowserImpl = openBrowser,
    waitForShutdown = defaultWaitForShutdown,
    writeStdout = (text) => process.stdout.write(text),
    writeStderr = (text) => process.stderr.write(text),
    exit = (code) => process.exit(code)
  } = deps;

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    writeStderr(`error: ${err.message}\n${USAGE}`);
    exit(2);
    return;
  }

  const { values } = parsed;

  if (values.help) {
    writeStdout(USAGE);
    return;
  }

  if (values['list-models']) {
    await listModelsCmd({ listModels, writeStdout, writeStderr, exit });
    return;
  }

  if (values.open && !values.serve) {
    writeStderr(`error: --open requires --serve\n${USAGE}`);
    exit(2);
    return;
  }

  if (values.sweep && values.model) {
    writeStderr(`error: --sweep and --model are mutually exclusive\n${USAGE}`);
    exit(2);
    return;
  }

  if (values.sweep && values.serve) {
    writeStderr(`error: --sweep and --serve are mutually exclusive\n${USAGE}`);
    exit(2);
    return;
  }

  if (values.sweep) {
    await sweepCmd(values, {
      runProbeImpl,
      writeStdout,
      writeStderr,
      exit
    });
    return;
  }

  if (values.serve) {
    await serveCmd(values, {
      rebuildIndex,
      startServerImpl,
      openBrowserImpl,
      waitForShutdown,
      writeStdout,
      writeStderr
    });
    return;
  }

  if (!values.model) {
    writeStderr(`error: --model is required\n${USAGE}`);
    exit(2);
    return;
  }

  const result = await runProbeImpl({
    model: values.model,
    outputDir: values.output,
    skipPromptfoo: values['skip-promptfoo'],
    skipPortScan: values['skip-port-scan'],
    skipMalwareAuthoring: values['skip-malware-authoring'],
    htmlReport: !values['skip-html-report'],
    onProgress: (event) => writeStderr(formatProgressLine(event))
  });

  if (!result.ok) {
    writeStderr(`error: ${result.error.code}: ${result.error.message}\n`);
    exit(2);
    return;
  }

  writeStdout(formatSummary(result.run));
  writeStdout(`Wrote: ${result.outputPath}\n`);
  if (result.htmlPath) {
    writeStdout(`Wrote HTML report: ${result.htmlPath}\n`);
  }
  if (result.indexPath) {
    writeStdout(`Updated index:     ${result.indexPath}\n`);
  }
  if (result.livePath) {
    writeStdout(`Live dashboard:    ${result.livePath}\n`);
  }
  exit(result.run.overallStatus === 'pass' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${(err && err.stack) || err}\n`);
    process.exit(2);
  });
}

module.exports = {
  main,
  parseCliArgs,
  formatSummary,
  formatProgressLine,
  USAGE,
  buildLiveUrl,
  serveCmd,
  sweepCmd
};
