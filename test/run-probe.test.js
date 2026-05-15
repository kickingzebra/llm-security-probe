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

function stubRunMalware({ pass = 0, fail = 0 } = {}) {
  return async () => {
    const tests = [];
    for (let i = 0; i < pass; i += 1) {
      tests.push({
        id: `mw-pass-${i + 1}`,
        category: 'malwareAuthoring',
        pluginId: 'malware-authoring',
        status: 'pass',
        prompt: 'q',
        replyText: 'refused',
        reason: 'refusal',
        durationMs: 10
      });
    }
    for (let i = 0; i < fail; i += 1) {
      tests.push({
        id: `mw-fail-${i + 1}`,
        category: 'malwareAuthoring',
        pluginId: 'malware-authoring',
        status: 'fail',
        prompt: 'q',
        replyText: 'leaked',
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

const FIXED_DEPS_BASE = {
  now: () => new Date('2026-05-04T12:00:00Z'),
  randomSuffix: () => 'abcd1234',
  // Default: malware suite returns an empty success so existing tests that
  // don't care about it don't have to stub it. Tests that want to exercise
  // the malware suite override this with stubRunMalware({ pass, fail }).
  runMalware: stubRunMalware()
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

test('all suites skipped: returns ok=false with code=nothing_to_run', async () => {
  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    skipPortScan: true,
    skipMalwareAuthoring: true,
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

// ─────────────────────────────────────────────────────────────────────────────
// PR-A14: HTML report emission alongside JSON
// ─────────────────────────────────────────────────────────────────────────────

test('default htmlReport=true: writes both .json and .html with matching basenames', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    // no htmlReport option — should default to true
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 1, fail: 0 })
    }
  });

  assert.equal(result.ok, true);
  assert.ok(result.htmlPath, 'expected htmlPath in result');
  // Same basename (just different extension)
  assert.equal(
    path.basename(result.outputPath, '.json'),
    path.basename(result.htmlPath, '.html')
  );
  // Both files exist on disk
  const jsonStat = await fs.stat(result.outputPath);
  const htmlStat = await fs.stat(result.htmlPath);
  assert.ok(jsonStat.isFile());
  assert.ok(htmlStat.isFile());
});

test('htmlReport=true: emitted HTML is a valid HTML5 document', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 1, fail: 1 })
    }
  });

  const html = await fs.readFile(result.htmlPath, 'utf8');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  // Should contain the model name
  assert.match(html, /gemma3:12b/);
  // Should contain at least one <details> per test
  assert.match(html, /<details/);
});

test('htmlReport=false: writes only .json (no .html)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    htmlReport: false,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 1, fail: 0 })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.htmlPath, undefined, 'htmlPath should be omitted when disabled');
  assert.equal(result.indexPath, undefined, 'indexPath should be omitted when html disabled');

  // Only the .json file should be in the directory
  const files = await fs.readdir(tmpDir);
  const htmlFiles = files.filter((f) => f.endsWith('.html'));
  assert.equal(htmlFiles.length, 0, `unexpected HTML files: ${htmlFiles.join(', ')}`);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  assert.equal(jsonFiles.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-A15: aggregate index.html regenerated after each run
// ─────────────────────────────────────────────────────────────────────────────

test('default htmlReport=true: also writes runs/live.html', async (t) => {
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

  assert.equal(result.ok, true);
  assert.ok(result.livePath, 'expected livePath in result');
  assert.equal(path.basename(result.livePath), 'live.html');
  const stat = await fs.stat(result.livePath);
  assert.ok(stat.isFile());
});

test('default htmlReport=true: also writes runs/index.html', async (t) => {
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

  assert.equal(result.ok, true);
  assert.ok(result.indexPath, 'expected indexPath in result');
  assert.equal(path.basename(result.indexPath), 'index.html');

  const indexHtml = await fs.readFile(result.indexPath, 'utf8');
  assert.match(indexHtml, /^<!DOCTYPE html>/);
  // Index should reference the just-written run
  assert.match(indexHtml, new RegExp(`href="${result.run.runId}\\.html"`));
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-A16: status events emitted as the run progresses
// ─────────────────────────────────────────────────────────────────────────────

test('runProbe: writes a JSONL status file at runs/<runId>.status.jsonl', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 2, fail: 1 })
    }
  });

  const statusFile = path.join(tmpDir, `${result.run.runId}.status.jsonl`);
  const stat = await fs.stat(statusFile);
  assert.ok(stat.isFile(), 'status file should exist');
});

test('runProbe: status file contains run_started → N x prompt_completed → run_completed', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 2, fail: 1 })
    }
  });

  // Wait briefly for any fire-and-forget status writes from onProgress to flush
  await new Promise((r) => setTimeout(r, 50));

  const statusFile = path.join(tmpDir, `${result.run.runId}.status.jsonl`);
  const text = await fs.readFile(statusFile, 'utf8');
  const events = text.trim().split('\n').map((l) => JSON.parse(l));

  assert.ok(events.length >= 2, `expected at least 2 events, got ${events.length}`);
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[0].model, 'gemma3:12b');
  assert.equal(events[events.length - 1].type, 'run_completed');
  assert.equal(events[events.length - 1].overallStatus, 'fail');
});

test('runProbe: status events include a ts field', async (t) => {
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

  const statusFile = path.join(tmpDir, `${result.run.runId}.status.jsonl`);
  const text = await fs.readFile(statusFile, 'utf8');
  const events = text.trim().split('\n').map((l) => JSON.parse(l));
  for (const e of events) {
    assert.ok(e.ts, `event missing ts: ${JSON.stringify(e)}`);
  }
});

test('index regenerates with all prior runs after each new run', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  // First run
  const r1 = await runProbe({
    model: 'gemma3:12b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      now: () => new Date('2026-05-04T10:00:00Z'),
      listModels: stubListModels(['gemma3:12b']),
      runPortScan: stubRunPortScan({ pass: 1, fail: 0 })
    }
  });
  assert.equal(r1.ok, true);

  // Second run with a different timestamp + different model
  const r2 = await runProbe({
    model: 'qwen3:8b',
    skipPromptfoo: true,
    outputDir: tmpDir,
    deps: {
      ...FIXED_DEPS_BASE,
      now: () => new Date('2026-05-04T11:00:00Z'),
      randomSuffix: () => 'beef0001',
      listModels: stubListModels(['qwen3:8b']),
      runPortScan: stubRunPortScan({ pass: 0, fail: 1 })
    }
  });
  assert.equal(r2.ok, true);

  // Index should now contain BOTH runs
  const indexHtml = await fs.readFile(r2.indexPath, 'utf8');
  assert.match(indexHtml, /gemma3:12b/);
  assert.match(indexHtml, /qwen3:8b/);
  // 2 runs displayed
  assert.match(indexHtml, /2 runs/);
});
