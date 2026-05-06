'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { regenerateIndex } = require('../src/run-index');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(overrides = {}) {
  const base = {
    runId: `run_2026-05-01T00-00-00Z_${Math.random().toString(36).slice(2, 10)}`,
    model: 'gemma3:12b',
    phase: '1A-defensive-eval',
    startedAt: '2026-05-01T00:00:00Z',
    endedAt: '2026-05-01T00:01:00Z',
    overallStatus: 'pass',
    summary: {
      total: 12,
      passed: 12,
      failed: 0,
      refusalRate: 1.0,
      byCategory: {
        portScan: { total: 12, passed: 12, failed: 0, refusalRate: 1.0 }
      }
    },
    tests: []
  };
  return { ...base, ...overrides };
}

async function writeRun(dir, run) {
  const file = path.join(dir, `${run.runId}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2), 'utf8');
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('regenerateIndex: empty directory produces a minimal valid index', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const result = await regenerateIndex({ outputDir: tmpDir });

  assert.equal(result.ok, true);
  assert.equal(result.runCount, 0);
  const html = await fs.readFile(result.indexPath, 'utf8');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  // Should mention "no runs" or similar
  assert.match(html, /no runs|empty|0 runs/i);
});

test('regenerateIndex: lists every run JSON in the directory', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await writeRun(tmpDir, makeRun({ runId: 'run_2026-05-01T00-00-00Z_aaa', model: 'gemma3:12b' }));
  await writeRun(tmpDir, makeRun({ runId: 'run_2026-05-02T00-00-00Z_bbb', model: 'qwen3:8b' }));
  await writeRun(tmpDir, makeRun({ runId: 'run_2026-05-03T00-00-00Z_ccc', model: 'gpt-oss:20b' }));

  const result = await regenerateIndex({ outputDir: tmpDir });

  assert.equal(result.ok, true);
  assert.equal(result.runCount, 3);
  const html = await fs.readFile(result.indexPath, 'utf8');
  assert.match(html, /gemma3:12b/);
  assert.match(html, /qwen3:8b/);
  assert.match(html, /gpt-oss:20b/);
});

test('regenerateIndex: each row links to the corresponding .html', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await writeRun(tmpDir, makeRun({ runId: 'run_2026-05-01T00-00-00Z_aaa' }));
  await writeRun(tmpDir, makeRun({ runId: 'run_2026-05-02T00-00-00Z_bbb' }));

  const result = await regenerateIndex({ outputDir: tmpDir });
  const html = await fs.readFile(result.indexPath, 'utf8');

  assert.match(html, /href="run_2026-05-01T00-00-00Z_aaa\.html"/);
  assert.match(html, /href="run_2026-05-02T00-00-00Z_bbb\.html"/);
});

test('regenerateIndex: sorts runs by startedAt descending (most recent first)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  // Write runs out of chronological order
  await writeRun(tmpDir, makeRun({
    runId: 'run_oldest', startedAt: '2026-05-01T00:00:00Z', model: 'oldest-model'
  }));
  await writeRun(tmpDir, makeRun({
    runId: 'run_newest', startedAt: '2026-05-05T00:00:00Z', model: 'newest-model'
  }));
  await writeRun(tmpDir, makeRun({
    runId: 'run_middle', startedAt: '2026-05-03T00:00:00Z', model: 'middle-model'
  }));

  const result = await regenerateIndex({ outputDir: tmpDir });
  const html = await fs.readFile(result.indexPath, 'utf8');

  const newestIdx = html.indexOf('newest-model');
  const middleIdx = html.indexOf('middle-model');
  const oldestIdx = html.indexOf('oldest-model');
  assert.ok(newestIdx >= 0, 'newest-model not in output');
  assert.ok(newestIdx < middleIdx, 'newest should appear before middle');
  assert.ok(middleIdx < oldestIdx, 'middle should appear before oldest');
});

test('regenerateIndex: status badges (pass/fail/warn) appear with classes', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await writeRun(tmpDir, makeRun({ runId: 'run_pass', overallStatus: 'pass' }));
  await writeRun(tmpDir, makeRun({ runId: 'run_fail', overallStatus: 'fail' }));
  await writeRun(tmpDir, makeRun({ runId: 'run_warn', overallStatus: 'warn' }));

  const result = await regenerateIndex({ outputDir: tmpDir });
  const html = await fs.readFile(result.indexPath, 'utf8');

  assert.match(html, /badge-pass/);
  assert.match(html, /badge-fail/);
  assert.match(html, /badge-warn/);
});

test('regenerateIndex: refusal rate displayed per row', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await writeRun(tmpDir, makeRun({
    runId: 'run_aaa',
    summary: { total: 10, passed: 7, failed: 3, refusalRate: 0.7, byCategory: {} }
  }));

  const result = await regenerateIndex({ outputDir: tmpDir });
  const html = await fs.readFile(result.indexPath, 'utf8');
  assert.match(html, /70%/);
});

test('regenerateIndex: skips non-run files in directory', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await writeRun(tmpDir, makeRun({ runId: 'run_2026-05-01T00-00-00Z_aaa' }));
  await fs.writeFile(path.join(tmpDir, 'index.html'), '<existing>', 'utf8');
  await fs.writeFile(path.join(tmpDir, 'README.txt'), 'noise', 'utf8');
  // Malformed file that DOES match the run_*.json filter — exercises the
  // parse-failure branch in regenerateIndex.
  await fs.writeFile(path.join(tmpDir, 'run_malformed.json'), 'not valid json', 'utf8');
  // Sibling non-run JSON file with the wrong basename — should be ignored
  // by the filter, never even attempted (so it shouldn't appear in skipped).
  await fs.writeFile(path.join(tmpDir, 'unrelated.json'), '{}', 'utf8');

  const result = await regenerateIndex({ outputDir: tmpDir });

  // Only the one valid run file should count
  assert.equal(result.runCount, 1);
  // Malformed run JSON should not crash regenerate; it's logged and skipped
  assert.ok(Array.isArray(result.skipped));
  assert.ok(result.skipped.some((s) => s.includes('run_malformed.json')),
    `expected run_malformed.json in skipped, got ${JSON.stringify(result.skipped)}`);
  // Non-matching basename should be filtered before parse, so it's NOT in skipped
  assert.ok(!result.skipped.some((s) => s.includes('unrelated.json')),
    'non-run_ files should be filtered, not skipped');
});

test('regenerateIndex: missing directory does not throw, creates it', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-index-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const subDir = path.join(tmpDir, 'does-not-exist-yet');

  const result = await regenerateIndex({ outputDir: subDir });

  assert.equal(result.ok, true);
  assert.equal(result.runCount, 0);
  // The directory + index file should now exist
  const stat = await fs.stat(result.indexPath);
  assert.ok(stat.isFile());
});
