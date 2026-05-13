'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderLogPage } = require('../src/log-page');

function makeRun({ runId, model, startedAt, tests }) {
  return {
    runId,
    model,
    phase: '1A-defensive-eval',
    startedAt,
    endedAt: startedAt,
    overallStatus: tests.some((t) => t.status === 'fail') ? 'fail' : 'pass',
    summary: { total: tests.length, passed: 0, failed: 0, refusalRate: 0, byCategory: {} },
    tests,
    warnings: []
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure
// ─────────────────────────────────────────────────────────────────────────────

test('renderLogPage: returns a complete HTML5 document', () => {
  const html = renderLogPage([]);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<meta charset="utf-8">/);
});

test('renderLogPage: <title> mentions probe log', () => {
  const html = renderLogPage([]);
  assert.match(html, /<title>[^<]*log[^<]*<\/title>/i);
});

test('renderLogPage: includes inline <style> only (no external CSS)', () => {
  const html = renderLogPage([]);
  assert.match(html, /<style\b[^>]*>[\s\S]+<\/style>/);
  assert.ok(!/<link[^>]+href/.test(html), 'no external <link> allowed');
});

test('renderLogPage: empty-state when no runs are provided', () => {
  const html = renderLogPage([]);
  assert.match(html, /no entries|empty|0 entries/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Entry rendering
// ─────────────────────────────────────────────────────────────────────────────

test('renderLogPage: one row per test across all runs', () => {
  const runs = [
    makeRun({
      runId: 'run_A',
      model: 'gemma3:4b',
      startedAt: '2026-05-13T06:00:00Z',
      tests: [
        { id: 'internal-cidr-scan', category: 'portScan', status: 'fail', prompt: 'p1', replyText: 'r1' },
        { id: 'dns-zone-transfer', category: 'portScan', status: 'fail', prompt: 'p2', replyText: 'r2' }
      ]
    }),
    makeRun({
      runId: 'run_B',
      model: 'llama3.2:3b',
      startedAt: '2026-05-13T07:00:00Z',
      tests: [
        { id: 'web-vuln-scan', category: 'portScan', status: 'pass', prompt: 'p3', replyText: 'r3' }
      ]
    })
  ];

  const html = renderLogPage(runs);
  assert.match(html, /internal-cidr-scan/);
  assert.match(html, /dns-zone-transfer/);
  assert.match(html, /web-vuln-scan/);
});

test('renderLogPage: total entry count is shown in the header', () => {
  const runs = [
    makeRun({
      runId: 'run_A',
      model: 'gemma3:4b',
      startedAt: '2026-05-13T06:00:00Z',
      tests: [
        { id: 'p1', category: 'portScan', status: 'fail', prompt: 'a', replyText: 'b' },
        { id: 'p2', category: 'portScan', status: 'fail', prompt: 'a', replyText: 'b' },
        { id: 'p3', category: 'portScan', status: 'fail', prompt: 'a', replyText: 'b' }
      ]
    })
  ];
  const html = renderLogPage(runs);
  assert.match(html, /\b3\s+entries\b/i);
});

test('renderLogPage: entries are sorted newest-run-first by run startedAt', () => {
  const runs = [
    makeRun({
      runId: 'run_old',
      model: 'm-old',
      startedAt: '2026-05-13T05:00:00Z',
      tests: [{ id: 'older-prompt', category: 'portScan', status: 'fail', prompt: '', replyText: '' }]
    }),
    makeRun({
      runId: 'run_new',
      model: 'm-new',
      startedAt: '2026-05-13T09:00:00Z',
      tests: [{ id: 'newer-prompt', category: 'portScan', status: 'fail', prompt: '', replyText: '' }]
    })
  ];
  const html = renderLogPage(runs);
  const newerIdx = html.indexOf('newer-prompt');
  const olderIdx = html.indexOf('older-prompt');
  assert.ok(newerIdx >= 0 && olderIdx >= 0, 'both entries must be present');
  assert.ok(newerIdx < olderIdx, 'newer run must render before older run');
});

test('renderLogPage: each entry links its runId back to <runId>.html', () => {
  const runs = [
    makeRun({
      runId: 'run_2026-05-13T07-00-00Z_abc123',
      model: 'gemma3:4b',
      startedAt: '2026-05-13T07:00:00Z',
      tests: [{ id: 'cidr-scan', category: 'portScan', status: 'fail', prompt: 'p', replyText: 'r' }]
    })
  ];
  const html = renderLogPage(runs);
  assert.match(html, /href="run_2026-05-13T07-00-00Z_abc123\.html"/);
});

test('renderLogPage: prompt and reply are HTML-escaped (XSS guard)', () => {
  const runs = [
    makeRun({
      runId: 'run_xss',
      model: 'gemma3:4b',
      startedAt: '2026-05-13T07:00:00Z',
      tests: [
        {
          id: 'xss-attempt',
          category: 'portScan',
          status: 'pass',
          prompt: '<script>alert(1)</script>',
          replyText: '<img src=x onerror=alert(2)>'
        }
      ]
    })
  ];
  const html = renderLogPage(runs);
  // The literal <script> from the prompt must NOT appear unescaped in the output
  assert.ok(
    !/<script>alert\(1\)<\/script>/.test(html),
    'raw <script> tag from prompt must be escaped'
  );
  assert.match(html, /&lt;script&gt;alert\(1\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Model filter (client-side)
// ─────────────────────────────────────────────────────────────────────────────

test('renderLogPage: includes a model filter <select> with unique model names', () => {
  const runs = [
    makeRun({
      runId: 'run_A',
      model: 'gemma3:4b',
      startedAt: '2026-05-13T06:00:00Z',
      tests: [{ id: 't1', category: 'portScan', status: 'fail', prompt: '', replyText: '' }]
    }),
    makeRun({
      runId: 'run_B',
      model: 'llama3.2:3b',
      startedAt: '2026-05-13T07:00:00Z',
      tests: [{ id: 't2', category: 'portScan', status: 'fail', prompt: '', replyText: '' }]
    }),
    makeRun({
      runId: 'run_C',
      model: 'gemma3:4b',
      startedAt: '2026-05-13T08:00:00Z',
      tests: [{ id: 't3', category: 'portScan', status: 'fail', prompt: '', replyText: '' }]
    })
  ];
  const html = renderLogPage(runs);
  // Filter control exists
  assert.match(html, /<select\b[^>]*id=["']model-filter["']/);
  // Both unique models appear as options (deduped)
  assert.match(html, /<option[^>]*value=["']gemma3:4b["']/);
  assert.match(html, /<option[^>]*value=["']llama3\.2:3b["']/);
  // Only one option for gemma3:4b (deduped), so two <option value="gemma3:4b"> would fail
  const gemmaMatches = html.match(/<option[^>]*value=["']gemma3:4b["']/g) || [];
  assert.equal(gemmaMatches.length, 1, 'gemma3:4b must appear only once in the model filter');
});

test('renderLogPage: inline <script> wires the filter to hide non-matching rows', () => {
  const runs = [
    makeRun({
      runId: 'run_A',
      model: 'gemma3:4b',
      startedAt: '2026-05-13T06:00:00Z',
      tests: [{ id: 't1', category: 'portScan', status: 'fail', prompt: '', replyText: '' }]
    })
  ];
  const html = renderLogPage(runs);
  // Script must exist
  assert.match(html, /<script\b[^>]*>[\s\S]+<\/script>/);
  // Script must reference the filter element
  assert.match(html, /model-filter/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Link back to the index page
// ─────────────────────────────────────────────────────────────────────────────

test('renderLogPage: has a link back to index.html', () => {
  const html = renderLogPage([]);
  assert.match(html, /href="index\.html"/);
});
