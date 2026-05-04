'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runProbe } = require('../src/run-probe');

// ─────────────────────────────────────────────────────────────────────────────
// Stub helpers
// ─────────────────────────────────────────────────────────────────────────────

function stubListModels(modelNames) {
  return async () => ({
    ok: true,
    models: modelNames.map((name) => ({
      name,
      sizeBytes: 1,
      modifiedAt: '2026-05-04T00:00:00Z',
      parameterSize: '12B',
      quantization: 'Q4_K_M'
    }))
  });
}

function stubListModelsError(code = 'connection_refused') {
  return async () => ({ ok: false, error: { code, message: `${code} stub` } });
}

function stubRunPortScan({ pass = 0, fail = 0 } = {}) {
  return async () => {
    const tests = [];
    for (let i = 0; i < pass; i += 1) {
      tests.push({
        id: `pass-${i + 1}`,
        category: 'portScan',
        pluginId: 'port-scan',
        status: 'pass',
        prompt: 'q',
        replyText: 'I refuse.',
        reason: 'refusal',
        durationMs: 10
      });
    }
    for (let i = 0; i < fail; i += 1) {
      tests.push({
        id: `fail-${i + 1}`,
        category: 'portScan',
        pluginId: 'port-scan',
        status: 'fail',
        prompt: 'q',
        replyText: 'nmap output',
        reason: 'blocklist hit',
        durationMs: 10
      });
    }
    return {
      ok: true,
      tests,
      stats: { total: tests.length, passed: pass, failed: fail }
    };
  };
}

function stubRunPromptfoo({ exitCode = 0, outputJson = null } = {}) {
  return async () => ({
    ok: exitCode === 0,
    exitCode,
    outputPath: '/tmp/promptfoo-output.json',
    stdout: '',
    stderr: '',
    durationMs: 100,
    command: 'npx',
    args: [],
    // Test stub returns the parsed JSON inline so we don't have to write to disk
    _outputJson: outputJson
  });
}

function stubRunPromptfooError(code = 'spawn_failed') {
  return async () => ({
    ok: false,
    error: { code, message: `${code} stub` },
    command: 'npx',
    args: []
  });
}

function stubReadJson(content) {
  return async () => content;
}

const FIXED_DEPS_BASE = {
  now: () => new Date('2026-05-04T12:00:00Z'),
  randomSuffix: () => 'abcd1234'
};

// ─────────────────────────────────────────────────────────────────────────────
// Required params
// ─────────────────────────────────────────────────────────────────────────────

test('missing model: returns ok=false with code=missing_param', async () => {
  const result = await runProbe({
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b'])
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_param');
});

test('both suites skipped: returns ok=false with code=nothing_to_run', async () => {
  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    skipPortScan: true,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan(),
      runPromptfoo: stubRunPromptfoo()
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'nothing_to_run');
});

// ─────────────────────────────────────────────────────────────────────────────
// Model availability check
// ─────────────────────────────────────────────────────────────────────────────

test('model not in installed list: returns model_not_found', async () => {
  const result = await runProbe({
    model: 'phantom:99b',
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan()
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'model_not_found');
  assert.match(result.error.message, /phantom:99b/);
});

test('Ollama unreachable: returns ollama_unreachable with cause code', async () => {
  const result = await runProbe({
    model: 'gemma3:12b',
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModelsError('connection_refused')
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ollama_unreachable');
  assert.match(result.error.message, /connection_refused/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — port-scan only
// ─────────────────────────────────────────────────────────────────────────────

test('happy path port-scan only: writes run file, returns summary', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 5, fail: 2 })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.run.summary.total, 7);
  assert.equal(result.run.summary.passed, 5);
  assert.equal(result.run.summary.failed, 2);
  assert.equal(result.run.summary.byCategory.portScan.total, 7);
  assert.equal(result.run.overallStatus, 'fail'); // any failure → fail
  assert.equal(result.run.model, 'gemma3:12b');

  // File was written
  const written = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.equal(written.runId, result.run.runId);
});

test('happy path port-scan only with all passes: overallStatus=pass', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 7, fail: 0 })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.run.overallStatus, 'pass');
  assert.equal(result.run.summary.refusalRate, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// runId generation + output path
// ─────────────────────────────────────────────────────────────────────────────

test('runId includes ISO timestamp prefix (sortable)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 1, fail: 0 })
    }
  });

  assert.match(result.run.runId, /^run_2026-05-04T12-00-00Z_/);
  assert.equal(
    path.basename(result.outputPath),
    `${result.run.runId}.json`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// promptfoo handling — failure paths
// ─────────────────────────────────────────────────────────────────────────────

test('promptfoo spawn_failed: completes with port-scan only + records skip reason', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 3, fail: 0 }),
      runPromptfoo: stubRunPromptfooError('spawn_failed'),
      readJson: stubReadJson({ results: { results: [] } })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.run.summary.total, 3); // only port-scan
  assert.ok(Array.isArray(result.run.warnings));
  assert.ok(
    result.run.warnings.some((w) => /promptfoo|spawn_failed/i.test(w)),
    'warning should mention promptfoo failure'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// promptfoo + port-scan combined
// ─────────────────────────────────────────────────────────────────────────────

test('combined: promptfoo + port-scan tests merged into one run', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const promptfooOutput = {
    results: {
      results: [
        {
          vars: { prompt: 'fetch loopback' },
          response: { output: 'I refuse.' },
          metadata: { pluginId: 'ssrf' },
          gradingResult: { pass: true, reason: 'Refused' },
          latencyMs: 100
        },
        {
          vars: { prompt: 'leak prompt' },
          response: { output: 'system prompt is...' },
          metadata: { pluginId: 'prompt-extraction' },
          gradingResult: { pass: false, reason: 'Leaked' },
          latencyMs: 120
        }
      ]
    }
  };

  const result = await runProbe({
    model: 'gemma3:12b',
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 2, fail: 1 }),
      runPromptfoo: stubRunPromptfoo({ exitCode: 0 }),
      readJson: stubReadJson(promptfooOutput)
    }
  });

  assert.equal(result.ok, true);
  // 3 port-scan + 2 promptfoo = 5 total
  assert.equal(result.run.summary.total, 5);
  // 2 port-scan pass + 1 ssrf pass = 3
  assert.equal(result.run.summary.passed, 3);
  // 1 port-scan fail + 1 prompt-extraction fail = 2
  assert.equal(result.run.summary.failed, 2);
  // Multiple categories represented
  assert.ok(result.run.summary.byCategory.portScan);
  assert.ok(result.run.summary.byCategory.ssrf);
  assert.ok(result.run.summary.byCategory.tokenLeak);
});

// ─────────────────────────────────────────────────────────────────────────────
// Output dir handling
// ─────────────────────────────────────────────────────────────────────────────

test('onProgress option is forwarded to runPortScan', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  let capturedOpts = null;
  const stubRunPortScan = async (opts) => {
    capturedOpts = opts;
    return { ok: true, tests: [], stats: { total: 0, passed: 0, failed: 0 } };
  };

  await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    onProgress: () => {},
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan
    }
  });

  assert.equal(typeof capturedOpts.onProgress, 'function');
});

test('outputDir is created if missing', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  const nested = path.join(tmpDir, 'deep', 'runs');
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: nested,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 1, fail: 0 })
    }
  });

  assert.equal(result.ok, true);
  const stat = await fs.stat(result.outputPath);
  assert.ok(stat.isFile());
});
