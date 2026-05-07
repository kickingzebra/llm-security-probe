'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { startServer } = require('../src/server');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps the global fetch with a uniform shape so tests stay terse.
 */
async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    location: res.headers.get('location') || '',
    text,
    json: () => JSON.parse(text)
  };
}

async function makeRunsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lsp-server-'));
}

async function writeRunJson(dir, runId, overrides = {}) {
  const run = {
    runId,
    model: 'gemma3:12b',
    phase: '1A-defensive-eval',
    startedAt: '2026-05-07T10:00:00Z',
    endedAt: '2026-05-07T10:01:00Z',
    overallStatus: 'pass',
    summary: {
      total: 12,
      passed: 12,
      failed: 0,
      refusalRate: 1.0,
      byCategory: { portScan: { total: 12, passed: 12, failed: 0, refusalRate: 1.0 } }
    },
    tests: [],
    ...overrides
  };
  await fs.writeFile(path.join(dir, `${runId}.json`), JSON.stringify(run, null, 2));
  return run;
}

async function writeStatusJsonl(dir, runId, events) {
  await fs.writeFile(
    path.join(dir, `${runId}.status.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// startServer — boot, expose url, close cleanly
// ─────────────────────────────────────────────────────────────────────────────

test('startServer: starts on requested port and provides url + port', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  assert.ok(server.url.startsWith('http://127.0.0.1:'));
  assert.ok(server.port > 0, `expected positive port, got ${server.port}`);
});

test('startServer: close() shuts the server down', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0 });
  await server.close();

  // Subsequent fetch should fail with connection refused
  await assert.rejects(get(`${server.url}/api/health`), /fetch failed|ECONNREFUSED|ECONNRESET/);
});

test('startServer: throws if runsDir is missing', async () => {
  await assert.rejects(startServer({ port: 0 }), /runsDir/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/health
// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/health: returns 200 with { ok: true }', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/api/health`);
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/);
  assert.deepEqual(res.json(), { ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/runs — list
// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/runs: empty directory returns empty array', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/api/runs`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), []);
});

test('GET /api/runs: completed runs include status="complete" with summary', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  await writeRunJson(runsDir, 'run_2026-05-07T10-00-00Z_aaa', { overallStatus: 'pass' });
  await writeRunJson(runsDir, 'run_2026-05-07T11-00-00Z_bbb', {
    overallStatus: 'fail',
    summary: {
      total: 12, passed: 1, failed: 11, refusalRate: 0.083,
      byCategory: {}
    }
  });

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/api/runs`);
  assert.equal(res.status, 200);
  const runs = res.json();
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.status, 'complete');
    assert.ok(r.runId);
    assert.ok(r.model);
    assert.ok(r.summary);
  }
});

test('GET /api/runs: status.jsonl without .json marks run as in_progress with progress', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  await writeStatusJsonl(runsDir, 'run_inflight_aaa', [
    { type: 'run_started', model: 'gemma3:12b', ts: '2026-05-07T12:00:00Z' },
    { type: 'prompt_completed', index: 1, total: 12, id: 'p1', status: 'fail', durationMs: 1200, ts: '2026-05-07T12:00:01Z' },
    { type: 'prompt_completed', index: 2, total: 12, id: 'p2', status: 'fail', durationMs: 1200, ts: '2026-05-07T12:00:02Z' },
    { type: 'prompt_completed', index: 3, total: 12, id: 'p3', status: 'pass', durationMs: 1200, ts: '2026-05-07T12:00:03Z' }
  ]);

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/api/runs`);
  const runs = res.json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'in_progress');
  assert.equal(runs[0].runId, 'run_inflight_aaa');
  assert.equal(runs[0].model, 'gemma3:12b');
  assert.ok(runs[0].progress);
  assert.equal(runs[0].progress.completed, 3);
  assert.equal(runs[0].progress.total, 12);
});

test('GET /api/runs: in_progress and complete runs both appear, in_progress first', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  await writeRunJson(runsDir, 'run_complete_aaa', {
    startedAt: '2026-05-07T08:00:00Z',
    endedAt: '2026-05-07T08:05:00Z'
  });
  await writeStatusJsonl(runsDir, 'run_inflight_bbb', [
    { type: 'run_started', model: 'qwen3:8b', ts: '2026-05-07T12:00:00Z' }
  ]);

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/api/runs`);
  const runs = res.json();
  assert.equal(runs.length, 2);
  // In-progress always at the top of the list — that's where the live UI surfaces it
  assert.equal(runs[0].status, 'in_progress');
  assert.equal(runs[1].status, 'complete');
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/runs/:runId/events
// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/runs/:runId/events: returns parsed events for an existing run', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const events = [
    { type: 'run_started', model: 'gemma3:12b', ts: '2026-05-07T12:00:00Z' },
    { type: 'prompt_completed', index: 1, total: 7, id: 'p1', status: 'pass', durationMs: 100, ts: '2026-05-07T12:00:01Z' }
  ];
  await writeStatusJsonl(runsDir, 'run_evtest_aaa', events);

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/api/runs/run_evtest_aaa/events`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), events);
});

test('GET /api/runs/:runId/events: returns 404 for unknown runId', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/api/runs/run_does_not_exist/events`);
  assert.equal(res.status, 404);
});

test('GET /api/runs/:runId/events: rejects malformed runId (path traversal guard)', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  // runId must match run_* pattern; `..` is rejected before file lookup
  const res = await get(`${server.url}/api/runs/..%2F..%2Fetc%2Fpasswd/events`);
  assert.ok(res.status === 400 || res.status === 404, `expected 4xx for path traversal, got ${res.status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving from runsDir
// ─────────────────────────────────────────────────────────────────────────────

test('GET /<file>.html: serves with text/html', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(runsDir, 'index.html'), '<!DOCTYPE html><html></html>');

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/index.html`);
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/html/);
  assert.match(res.text, /<!DOCTYPE html>/);
});

test('GET /<file>.json: serves with application/json', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  await writeRunJson(runsDir, 'run_static_aaa');

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/run_static_aaa.json`);
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/);
  const parsed = res.json();
  assert.equal(parsed.runId, 'run_static_aaa');
});

test('GET /: redirects to /index.html', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(runsDir, 'index.html'), '<!DOCTYPE html>');

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await fetch(`${server.url}/`, { redirect: 'manual' });
  assert.ok(res.status === 301 || res.status === 302, `expected redirect, got ${res.status}`);
  assert.match(res.headers.get('location'), /index\.html/);
});

test('GET /unknown-file.html: returns 404', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/unknown-file.html`);
  assert.equal(res.status, 404);
});

test('GET /../../etc/passwd: rejected by path traversal guard', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/..%2F..%2Fetc%2Fpasswd`);
  assert.ok(res.status === 400 || res.status === 404, `expected 4xx for traversal, got ${res.status}`);
});

test('GET /<file>.status.jsonl: served with application/x-ndjson or text/plain', async (t) => {
  const runsDir = await makeRunsDir();
  t.after(() => fs.rm(runsDir, { recursive: true, force: true }));

  await writeStatusJsonl(runsDir, 'run_jsonl_aaa', [
    { type: 'run_started', ts: '2026-05-07T00:00:00Z' }
  ]);

  const server = await startServer({ runsDir, port: 0 });
  t.after(() => server.close());

  const res = await get(`${server.url}/run_jsonl_aaa.status.jsonl`);
  assert.equal(res.status, 200);
  assert.match(res.contentType, /ndjson|text\/plain/);
  assert.match(res.text, /run_started/);
});
