'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCliArgs, formatSummary, USAGE, formatProgressLine } = require('../src/index');

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

test('parseCliArgs: --skip-html-report defaults to false (HTML emitted by default)', () => {
  const noFlag = parseCliArgs(['--model', 'gemma3:12b']);
  assert.equal(noFlag.values['skip-html-report'], false);

  const withFlag = parseCliArgs(['--model', 'gemma3:12b', '--skip-html-report']);
  assert.equal(withFlag.values['skip-html-report'], true);
});

test('USAGE mentions --skip-html-report', () => {
  assert.match(USAGE, /--skip-html-report/);
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
  assert.match(USAGE, /--skip-promptfoo/);
  assert.match(USAGE, /--skip-port-scan/);
  assert.match(USAGE, /--list-models/);
  assert.match(USAGE, /--help/);
});
