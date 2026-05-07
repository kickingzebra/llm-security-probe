'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  appendEvent,
  readEvents,
  STATUS_FILE_SUFFIX
} = require('../src/run-status');

// ─────────────────────────────────────────────────────────────────────────────
// appendEvent — atomic append per event, JSONL format
// ─────────────────────────────────────────────────────────────────────────────

test('STATUS_FILE_SUFFIX is .status.jsonl', () => {
  assert.equal(STATUS_FILE_SUFFIX, '.status.jsonl');
});

test('appendEvent: creates the file on first call and writes one JSON line', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-status-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await appendEvent({
    outputDir: tmpDir,
    runId: 'run_test_aaa',
    event: { type: 'run_started', model: 'gemma3:12b' }
  });

  const file = path.join(tmpDir, `run_test_aaa${STATUS_FILE_SUFFIX}`);
  const text = await fs.readFile(file, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, 'run_started');
  assert.equal(parsed.model, 'gemma3:12b');
  assert.ok(parsed.ts, 'event must include a timestamp');
});

test('appendEvent: appends additional events on subsequent calls', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-status-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await appendEvent({
    outputDir: tmpDir,
    runId: 'run_test_bbb',
    event: { type: 'run_started', model: 'gemma3:12b' }
  });
  await appendEvent({
    outputDir: tmpDir,
    runId: 'run_test_bbb',
    event: { type: 'prompt_completed', index: 1, total: 12, id: 'internal-cidr-scan', status: 'fail' }
  });
  await appendEvent({
    outputDir: tmpDir,
    runId: 'run_test_bbb',
    event: { type: 'run_completed', overallStatus: 'fail' }
  });

  const events = await readEvents({ outputDir: tmpDir, runId: 'run_test_bbb' });
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[1].type, 'prompt_completed');
  assert.equal(events[2].type, 'run_completed');
});

test('appendEvent: respects user-supplied ts (does not overwrite)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-status-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const fixedTs = '2026-05-07T12:00:00Z';
  await appendEvent({
    outputDir: tmpDir,
    runId: 'run_test_ccc',
    event: { type: 'run_started', ts: fixedTs }
  });

  const events = await readEvents({ outputDir: tmpDir, runId: 'run_test_ccc' });
  assert.equal(events[0].ts, fixedTs);
});

test('appendEvent: creates outputDir if it does not exist', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-status-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const subDir = path.join(tmpRoot, 'nested', 'runs');
  await appendEvent({
    outputDir: subDir,
    runId: 'run_test_ddd',
    event: { type: 'run_started' }
  });

  const stat = await fs.stat(path.join(subDir, `run_test_ddd${STATUS_FILE_SUFFIX}`));
  assert.ok(stat.isFile());
});

test('appendEvent: required params throw', async () => {
  await assert.rejects(
    appendEvent({ outputDir: '/tmp', event: {} }),
    /runId/i
  );
  await assert.rejects(
    appendEvent({ runId: 'x', event: {} }),
    /outputDir/i
  );
  await assert.rejects(
    appendEvent({ outputDir: '/tmp', runId: 'x' }),
    /event/i
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// readEvents
// ─────────────────────────────────────────────────────────────────────────────

test('readEvents: returns [] when no status file exists', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-status-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const events = await readEvents({ outputDir: tmpDir, runId: 'run_missing' });
  assert.deepEqual(events, []);
});

test('readEvents: tolerates malformed lines (skips them, returns valid ones)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-status-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const file = path.join(tmpDir, `run_test_eee${STATUS_FILE_SUFFIX}`);
  // Mix valid and invalid lines + a blank line
  await fs.writeFile(
    file,
    [
      JSON.stringify({ type: 'run_started', ts: '2026-05-07T00:00:00Z' }),
      'this is not json',
      '',
      JSON.stringify({ type: 'run_completed', ts: '2026-05-07T00:01:00Z' })
    ].join('\n') + '\n',
    'utf8'
  );

  const events = await readEvents({ outputDir: tmpDir, runId: 'run_test_eee' });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[1].type, 'run_completed');
});
