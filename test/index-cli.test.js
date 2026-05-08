'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { main, parseCliArgs, formatSummary, USAGE, formatProgressLine } = require('../src/index');

// ─────────────────────────────────────────────────────────────────────────────
// parseCliArgs
// ─────────────────────────────────────────────────────────────────────────────

test('parseCliArgs: --model is captured', () => {
  const { values } = parseCliArgs(['--model', 'gemma3:12b']);
  assert.equal(values.model, 'gemma3:12b');
});

test('parseCliArgs: --output captured; defaults to local-data/runs', () => {
  const def = parseCliArgs(['--model', 'x']);
  assert.equal(def.values.output, 'local-data/runs');

  const custom = parseCliArgs(['--model', 'x', '--output', '/tmp/runs']);
  assert.equal(custom.values.output, '/tmp/runs');
});

test('parseCliArgs: --serve flags are captured with host/port defaults', () => {
  const { values } = parseCliArgs(['--serve']);
  assert.equal(values.serve, true);
  assert.equal(values.host, '127.0.0.1');
  assert.equal(values.port, 3025);
  assert.equal(values.open, false);
});

test('parseCliArgs: --host, --port, and --open override serve defaults', () => {
  const { values } = parseCliArgs([
    '--serve',
    '--host',
    '0.0.0.0',
    '--port',
    '4012',
    '--open'
  ]);
  assert.equal(values.host, '0.0.0.0');
  assert.equal(values.port, 4012);
  assert.equal(values.open, true);
});

test('parseCliArgs: --skip-html-report defaults to false (HTML emitted by default)', () => {
  const noFlag = parseCliArgs(['--model', 'gemma3:12b']);
  assert.equal(noFlag.values['skip-html-report'], false);

  const withFlag = parseCliArgs(['--model', 'gemma3:12b', '--skip-html-report']);
  assert.equal(withFlag.values['skip-html-report'], true);
});

test('USAGE mentions --skip-html-report', () => {
  assert.match(USAGE, /--skip-html-report/);
});

test('USAGE mentions --serve, --host, --port, and --open', () => {
  assert.match(USAGE, /--serve/);
  assert.match(USAGE, /--host/);
  assert.match(USAGE, /--port/);
  assert.match(USAGE, /--open/);
});

test('parseCliArgs: --skip-promptfoo and --skip-port-scan are booleans', () => {
  const { values } = parseCliArgs([
    '--model',
    'x',
    '--skip-promptfoo',
    '--skip-port-scan'
  ]);
  assert.equal(values['skip-promptfoo'], true);
  assert.equal(values['skip-port-scan'], true);
});

test('parseCliArgs: --list-models is a boolean', () => {
  const { values } = parseCliArgs(['--list-models']);
  assert.equal(values['list-models'], true);
});

test('parseCliArgs: --help and -h are aliases', () => {
  assert.equal(parseCliArgs(['--help']).values.help, true);
  assert.equal(parseCliArgs(['-h']).values.help, true);
});

test('parseCliArgs: unknown option throws', () => {
  assert.throws(() => parseCliArgs(['--bogus']), /unknown|unexpected/i);
});

test('parseCliArgs: invalid --port throws', () => {
  assert.throws(() => parseCliArgs(['--serve', '--port', 'not-a-number']), /--port/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatSummary
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RUN = {
  runId: 'run_2026-05-04T12-00-00Z_abcd1234',
  model: 'gemma3:12b',
  phase: '1A-defensive-eval',
  startedAt: '2026-05-04T12:00:00Z',
  endedAt: '2026-05-04T12:00:42Z',
  overallStatus: 'fail',
  summary: {
    total: 5,
    passed: 3,
    failed: 2,
    refusalRate: 0.6,
    byCategory: {
      ssrf: { total: 2, passed: 2, failed: 0, refusalRate: 1.0 },
      tokenLeak: { total: 3, passed: 1, failed: 2, refusalRate: 0.333 }
    }
  },
  tests: [],
  warnings: []
};

test('formatSummary: includes run id, model, refusal rate, per-category breakdown', () => {
  const out = formatSummary(SAMPLE_RUN);
  assert.match(out, /run_2026-05-04T12-00-00Z_abcd1234/);
  assert.match(out, /gemma3:12b/);
  assert.match(out, /Overall:\s+FAIL/);
  assert.match(out, /60\.0%/);
  assert.match(out, /3\/5 refused/);
  assert.match(out, /ssrf\s+2\/2 refused/);
  assert.match(out, /tokenLeak\s+1\/3 refused/);
});

test('formatSummary: surfaces warnings when present', () => {
  const withWarning = {
    ...SAMPLE_RUN,
    warnings: ['promptfoo skipped: spawn_failed']
  };
  const out = formatSummary(withWarning);
  assert.match(out, /Warnings:/);
  assert.match(out, /promptfoo skipped/);
});

test('formatSummary: omits Warnings section when none', () => {
  const out = formatSummary({ ...SAMPLE_RUN, warnings: [] });
  assert.doesNotMatch(out, /Warnings:/);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatProgressLine
// ─────────────────────────────────────────────────────────────────────────────

test('formatProgressLine: includes [N/total], id, status, seconds', () => {
  const line = formatProgressLine({
    index: 3,
    total: 7,
    id: 'cloud-metadata-scan',
    status: 'fail',
    durationMs: 4231
  });
  assert.match(line, /\[3\/7\]/);
  assert.match(line, /cloud-metadata-scan/);
  assert.match(line, /fail/i); // case-insensitive: impl uses FAIL upper-case to make failures visually pop
  assert.match(line, /4\.2s/);
});

test('formatProgressLine: pass status is rendered as PASS', () => {
  const line = formatProgressLine({
    index: 1,
    total: 7,
    id: 'internal-cidr-scan',
    status: 'pass',
    durationMs: 1500
  });
  assert.match(line, /pass/i);
  assert.match(line, /1\.5s/);
});

test('USAGE mentions every flag', () => {
  assert.match(USAGE, /--model/);
  assert.match(USAGE, /--output/);
  assert.match(USAGE, /--serve/);
  assert.match(USAGE, /--host/);
  assert.match(USAGE, /--port/);
  assert.match(USAGE, /--open/);
  assert.match(USAGE, /--skip-promptfoo/);
  assert.match(USAGE, /--skip-port-scan/);
  assert.match(USAGE, /--list-models/);
  assert.match(USAGE, /--help/);
});

// ─────────────────────────────────────────────────────────────────────────────
// main — serve mode
// ─────────────────────────────────────────────────────────────────────────────

test('main: --serve starts server, rebuilds index, and does not call runProbe', async () => {
  const stdout = [];
  const stderr = [];
  const calls = {
    rebuildIndex: [],
    startServer: [],
    runProbe: 0,
    exit: []
  };

  await main(['--serve'], {
    rebuildIndex: async (options) => {
      calls.rebuildIndex.push(options);
      return {
        ok: true,
        indexPath: 'local-data/runs/index.html',
        livePath: 'local-data/runs/live.html'
      };
    },
    startServerImpl: async (options) => {
      calls.startServer.push(options);
      return {
        url: 'http://127.0.0.1:3025',
        close: async () => {}
      };
    },
    runProbe: async () => {
      calls.runProbe += 1;
      throw new Error('runProbe should not be called in serve mode');
    },
    waitForShutdown: async () => {},
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    exit: (code) => calls.exit.push(code)
  });

  assert.deepEqual(calls.rebuildIndex, [{ outputDir: 'local-data/runs' }]);
  assert.deepEqual(calls.startServer, [
    { runsDir: 'local-data/runs', host: '127.0.0.1', port: 3025 }
  ]);
  assert.equal(calls.runProbe, 0);
  assert.deepEqual(calls.exit, []);
  assert.equal(stderr.join(''), '');
  assert.match(stdout.join(''), /Serving runs from: local-data\/runs/);
  assert.match(stdout.join(''), /Live dashboard:\s+http:\/\/127\.0\.0\.1:3025\/live\.html/);
});

test('main: --serve --open launches the live dashboard URL in the browser', async () => {
  const opened = [];

  await main(['--serve', '--open', '--host', '0.0.0.0', '--port', '4012'], {
    rebuildIndex: async () => ({
      ok: true,
      indexPath: 'local-data/runs/index.html',
      livePath: 'local-data/runs/live.html'
    }),
    startServerImpl: async () => ({
      url: 'http://0.0.0.0:4012',
      close: async () => {}
    }),
    openBrowserImpl: async (url) => opened.push(url),
    waitForShutdown: async () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    exit: () => {}
  });

  assert.deepEqual(opened, ['http://0.0.0.0:4012/live.html']);
});

test('main: --open without --serve exits with usage error', async () => {
  const stderr = [];
  const exitCodes = [];

  await main(['--open'], {
    writeStdout: () => {},
    writeStderr: (text) => stderr.push(text),
    exit: (code) => exitCodes.push(code)
  });

  assert.deepEqual(exitCodes, [2]);
  assert.match(stderr.join(''), /--open requires --serve/);
});
