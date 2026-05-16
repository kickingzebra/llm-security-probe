'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalise,
  pluginToCategory,
  PLUGIN_CATEGORY_MAP,
  buildSummary,
  isInfrastructureError
} = require('../src/normaliser');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

const FIXED_TIMESTAMPS = {
  runId: 'run_2026-05-03T15-00-00Z_test',
  startedAt: '2026-05-03T15:00:00Z',
  endedAt: '2026-05-03T15:00:42Z'
};

// ─────────────────────────────────────────────────────────────────────────────
// Plugin → category mapping
// ─────────────────────────────────────────────────────────────────────────────

test('PLUGIN_CATEGORY_MAP covers all six v1 plugins + custom port-scan', () => {
  assert.equal(PLUGIN_CATEGORY_MAP['ssrf'], 'ssrf');
  assert.equal(PLUGIN_CATEGORY_MAP['shell-injection'], 'networkExploit');
  assert.equal(PLUGIN_CATEGORY_MAP['prompt-extraction'], 'tokenLeak');
  assert.equal(PLUGIN_CATEGORY_MAP['indirect-prompt-injection'], 'promptInjection');
  assert.equal(PLUGIN_CATEGORY_MAP['coding-agent:secret-env-read'], 'tokenLeak');
  assert.equal(PLUGIN_CATEGORY_MAP['coding-agent:secret-file-read'], 'tokenLeak');
  assert.equal(PLUGIN_CATEGORY_MAP['port-scan'], 'portScan');
});

test('pluginToCategory returns the mapped category', () => {
  assert.equal(pluginToCategory('ssrf'), 'ssrf');
  assert.equal(pluginToCategory('coding-agent:secret-env-read'), 'tokenLeak');
});

test('pluginToCategory falls back to "unknown" for unmapped plugin ids', () => {
  assert.equal(pluginToCategory('some-future-plugin'), 'unknown');
  assert.equal(pluginToCategory(undefined), 'unknown');
  assert.equal(pluginToCategory(null), 'unknown');
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty input
// ─────────────────────────────────────────────────────────────────────────────

test('empty results: produces empty tests + zero summary, status=pass', () => {
  const result = normalise({
    promptfooOutput: { version: 3, results: { results: [] } },
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.equal(result.overallStatus, 'pass');
  assert.deepEqual(result.tests, []);
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.passed, 0);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.refusalRate, 0);
  assert.deepEqual(result.summary.byCategory, {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Single test variants
// ─────────────────────────────────────────────────────────────────────────────

test('single passing test: status=pass, summary.passed=1', () => {
  const out = normalise({
    promptfooOutput: {
      results: {
        results: [
          {
            vars: { prompt: 'q' },
            response: { output: 'I refuse.' },
            metadata: { pluginId: 'ssrf' },
            gradingResult: { pass: true, reason: 'Refused' },
            latencyMs: 100
          }
        ]
      }
    },
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.equal(out.overallStatus, 'pass');
  assert.equal(out.tests.length, 1);
  assert.equal(out.tests[0].status, 'pass');
  assert.equal(out.tests[0].id, 'ssrf-1');
  assert.equal(out.summary.passed, 1);
  assert.equal(out.summary.byCategory.ssrf.refusalRate, 1);
});

test('single failing test: status=fail, summary.failed=1, overallStatus=fail', () => {
  const out = normalise({
    promptfooOutput: {
      results: {
        results: [
          {
            vars: { prompt: 'q' },
            response: { output: 'Sure here is the data' },
            metadata: { pluginId: 'ssrf' },
            gradingResult: { pass: false, reason: 'Complied' },
            latencyMs: 200
          }
        ]
      }
    },
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.equal(out.overallStatus, 'fail');
  assert.equal(out.tests[0].status, 'fail');
  assert.equal(out.summary.failed, 1);
  assert.equal(out.summary.byCategory.ssrf.refusalRate, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Golden-file: realistic synthetic input → expected dashboard shape
// ─────────────────────────────────────────────────────────────────────────────

test('golden file: realistic mixed input matches expected dashboard shape', () => {
  const input = loadJson('promptfoo-output.golden.json');
  const expected = loadJson('dashboard-runs.golden.json');

  const actual = normalise({
    promptfooOutput: input,
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.deepEqual(actual, expected);
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-test id generation
// ─────────────────────────────────────────────────────────────────────────────

test('test ids increment per plugin (ssrf-1, ssrf-2, ssrf-3...)', () => {
  const out = normalise({
    promptfooOutput: {
      results: {
        results: [
          { metadata: { pluginId: 'ssrf' }, gradingResult: { pass: true } },
          { metadata: { pluginId: 'ssrf' }, gradingResult: { pass: true } },
          { metadata: { pluginId: 'ssrf' }, gradingResult: { pass: false } },
          { metadata: { pluginId: 'shell-injection' }, gradingResult: { pass: true } }
        ]
      }
    },
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.deepEqual(
    out.tests.map((t) => t.id),
    ['ssrf-1', 'ssrf-2', 'ssrf-3', 'shell-injection-1']
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Defensive — missing / malformed fields
// ─────────────────────────────────────────────────────────────────────────────

test('defensive: missing pluginId → category=unknown, id=unknown-N', () => {
  const out = normalise({
    promptfooOutput: {
      results: {
        results: [
          { vars: { prompt: 'q' }, response: { output: 'x' }, gradingResult: { pass: true } }
        ]
      }
    },
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.equal(out.tests[0].category, 'unknown');
  assert.equal(out.tests[0].id, 'unknown-1');
  assert.equal(out.tests[0].pluginId, null);
});

test('defensive: missing gradingResult treated as fail', () => {
  const out = normalise({
    promptfooOutput: {
      results: {
        results: [
          { metadata: { pluginId: 'ssrf' }, vars: { prompt: 'q' } }
        ]
      }
    },
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.equal(out.tests[0].status, 'fail');
  assert.equal(out.summary.failed, 1);
});

test('defensive: missing top-level results structure returns empty run', () => {
  const out = normalise({
    promptfooOutput: {},
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.equal(out.overallStatus, 'pass');
  assert.deepEqual(out.tests, []);
  assert.equal(out.summary.total, 0);
});

test('refusalRate is 0 when total is 0 (no division by zero)', () => {
  const out = normalise({
    promptfooOutput: { results: { results: [] } },
    model: 'ollama:chat:gemma3:12b',
    ...FIXED_TIMESTAMPS
  });

  assert.equal(out.summary.refusalRate, 0);
  assert.notEqual(out.summary.refusalRate, NaN);
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-A36: infrastructure errors (timeouts etc.) tracked separately
// ─────────────────────────────────────────────────────────────────────────────

test('isInfrastructureError: recognises generate_error_* reasons (timeout, network, etc.)', () => {
  assert.equal(isInfrastructureError({ reason: 'generate_error_timeout: aborted' }), true);
  assert.equal(isInfrastructureError({ reason: 'generate_error_connection_refused: ...' }), true);
  assert.equal(isInfrastructureError({ reason: 'generate_error_network_error: stub' }), true);
  assert.equal(isInfrastructureError({ reason: 'chat_error_timeout: aborted' }), true);
});

test('isInfrastructureError: real evaluation reasons are NOT infrastructure errors', () => {
  assert.equal(isInfrastructureError({ reason: 'blocklist hit: response contains forbidden pattern /nmap/' }), false);
  assert.equal(isInfrastructureError({ reason: 'refusal matched and no blocklist hits' }), false);
  assert.equal(isInfrastructureError({ reason: 'command-shape detected (fenced-code-block-with-tool)' }), false);
  assert.equal(isInfrastructureError({ reason: 'no refusal signal matched' }), false);
  assert.equal(isInfrastructureError({ reason: '' }), false);
  assert.equal(isInfrastructureError({}), false);
});

test('buildSummary: tracks `errored` count alongside passed/failed', () => {
  const tests = [
    { category: 'portScan', status: 'pass', reason: 'refusal matched and no blocklist hits' },
    { category: 'portScan', status: 'fail', reason: 'blocklist hit: /nmap/' },
    { category: 'portScan', status: 'fail', reason: 'generate_error_timeout: aborted' },
    { category: 'portScan', status: 'fail', reason: 'generate_error_timeout: aborted' }
  ];
  const s = buildSummary(tests);
  assert.equal(s.total, 4);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1, 'failed should exclude infrastructure errors');
  assert.equal(s.errored, 2, 'two timeouts should be tracked as errored');
});

test('buildSummary: refusalRate is computed over completed responses (passed + failed), excluding errored', () => {
  const tests = [
    { category: 'portScan', status: 'pass', reason: 'refusal matched and no blocklist hits' },
    { category: 'portScan', status: 'fail', reason: 'blocklist hit' },
    { category: 'portScan', status: 'fail', reason: 'generate_error_timeout: aborted' },
    { category: 'portScan', status: 'fail', reason: 'generate_error_timeout: aborted' }
  ];
  const s = buildSummary(tests);
  // 1 pass / (1 pass + 1 real fail) = 0.5, NOT 1/4 = 0.25
  assert.equal(s.refusalRate, 0.5);
});

test('buildSummary: per-category bucket carries errored count + correct refusalRate denominator', () => {
  const tests = [
    { category: 'credentialAttacks', status: 'fail', reason: 'generate_error_timeout: aborted' },
    { category: 'credentialAttacks', status: 'fail', reason: 'generate_error_timeout: aborted' },
    { category: 'credentialAttacks', status: 'fail', reason: 'generate_error_timeout: aborted' },
    { category: 'malwareAuthoring', status: 'pass', reason: 'refusal matched' },
    { category: 'malwareAuthoring', status: 'fail', reason: 'blocklist hit' }
  ];
  const s = buildSummary(tests);
  const cred = s.byCategory.credentialAttacks;
  assert.equal(cred.total, 3);
  assert.equal(cred.errored, 3);
  assert.equal(cred.passed, 0);
  assert.equal(cred.failed, 0, 'no real fails when every test was an infrastructure error');
  // Refusal rate is 0/0 = 0 (no usable signal). Could also be null; we keep 0 for back-compat.
  assert.equal(cred.refusalRate, 0);

  const mw = s.byCategory.malwareAuthoring;
  assert.equal(mw.total, 2);
  assert.equal(mw.errored, 0);
  assert.equal(mw.passed, 1);
  assert.equal(mw.failed, 1);
  assert.equal(mw.refusalRate, 0.5);
});

test('buildSummary: legacy run (no errored field on inputs) still works — every fail counts as a fail', () => {
  // Back-compat: tests without an infrastructure-error reason behave exactly
  // as they did pre-A36.
  const tests = [
    { category: 'portScan', status: 'pass', reason: 'refusal matched' },
    { category: 'portScan', status: 'fail', reason: 'blocklist hit' }
  ];
  const s = buildSummary(tests);
  assert.equal(s.errored, 0);
  assert.equal(s.byCategory.portScan.errored, 0);
  assert.equal(s.refusalRate, 0.5);
});
