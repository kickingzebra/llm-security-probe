'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  renderRunReport,
  renderIndex,
  escapeHtml
} = require('../src/report-renderer');

// Sample run JSON (same shape as dashboard-runs.golden.json — the canonical output)
const SAMPLE_RUN = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'dashboard-runs.golden.json'),
    'utf8'
  )
);

// ─────────────────────────────────────────────────────────────────────────────
// escapeHtml — XSS guard
// ─────────────────────────────────────────────────────────────────────────────

test('escapeHtml: encodes & < > " \' to entities', () => {
  assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('escapeHtml: handles non-string input safely', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

// ─────────────────────────────────────────────────────────────────────────────
// renderRunReport — top-level structure
// ─────────────────────────────────────────────────────────────────────────────

test('renderRunReport: returns a complete HTML5 document', () => {
  const html = renderRunReport(SAMPLE_RUN);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html\b/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<meta charset="utf-8">/);
});

test('renderRunReport: title and header include model name and run id', () => {
  const html = renderRunReport(SAMPLE_RUN);
  // Model name should appear in the document title
  assert.match(html, /<title>[^<]*ollama:chat:gemma3:12b[^<]*<\/title>/);
  // Run id should be visible somewhere in the document body
  assert.match(html, /run_2026-05-03T15-00-00Z_test/);
});

test('renderRunReport: overall status surfaced prominently with class', () => {
  const html = renderRunReport(SAMPLE_RUN);
  // SAMPLE_RUN.overallStatus === "fail"
  assert.match(html, /class="overall[^"]*\bfail\b[^"]*"/i);
  assert.match(html, />FAIL</);
});

test('renderRunReport: refusal rate displayed as percentage', () => {
  const html = renderRunReport(SAMPLE_RUN);
  // 0.6 refusalRate → "60%"
  assert.match(html, /60%/);
  assert.match(html, /3\s*\/\s*5/); // passed/total
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-category breakdown
// ─────────────────────────────────────────────────────────────────────────────

test('renderRunReport: each category in byCategory is rendered with counts', () => {
  const html = renderRunReport(SAMPLE_RUN);
  // ssrf 2/2, tokenLeak 0/1, promptInjection 1/2
  assert.match(html, /\bssrf\b/i);
  assert.match(html, /\btokenLeak\b/i);
  assert.match(html, /\bpromptInjection\b/i);
});

test('renderRunReport: per-category refusal rates rendered as percentages', () => {
  const html = renderRunReport(SAMPLE_RUN);
  // ssrf 100%, tokenLeak 0%, promptInjection 50%
  assert.match(html, /100%/);
  assert.match(html, /0%/);
  assert.match(html, /50%/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-test details
// ─────────────────────────────────────────────────────────────────────────────

test('renderRunReport: each test rendered as collapsible <details> block', () => {
  const html = renderRunReport(SAMPLE_RUN);
  // 5 tests in fixture → at least 5 <details> elements
  const detailsMatches = html.match(/<details\b/g) || [];
  assert.ok(detailsMatches.length >= 5, `expected >=5 <details>, got ${detailsMatches.length}`);
});

test('renderRunReport: every test id, status, and duration appears in document', () => {
  const html = renderRunReport(SAMPLE_RUN);
  for (const t of SAMPLE_RUN.tests) {
    assert.match(html, new RegExp(t.id), `missing test id ${t.id}`);
    // duration in milliseconds → format as seconds (e.g. 1820 → "1.8s")
    const seconds = (t.durationMs / 1000).toFixed(1);
    assert.match(html, new RegExp(`${seconds}s`), `missing duration for ${t.id}`);
  }
});

test('renderRunReport: pass/fail status applied as CSS class on each test', () => {
  const html = renderRunReport(SAMPLE_RUN);
  // At least one element with class containing "pass" and one with "fail"
  assert.match(html, /class="[^"]*\btest-pass\b/);
  assert.match(html, /class="[^"]*\btest-fail\b/);
});

// ─────────────────────────────────────────────────────────────────────────────
// XSS / HTML escaping in user-controlled fields
// ─────────────────────────────────────────────────────────────────────────────

test('renderRunReport: escapes HTML in replyText (XSS guard)', () => {
  const xssRun = {
    ...SAMPLE_RUN,
    tests: [
      {
        id: 'xss-test',
        category: 'portScan',
        pluginId: 'port-scan',
        status: 'fail',
        prompt: 'Scan the network',
        replyText: '<script>alert("pwn")</script>',
        reason: 'leaked tool name',
        durationMs: 100
      }
    ]
  };
  const html = renderRunReport(xssRun);
  // Raw <script> must NOT appear unescaped
  assert.ok(!/<script>alert\("pwn"\)<\/script>/.test(html), 'unescaped <script> leaked into output');
  // Escaped form should appear
  assert.match(html, /&lt;script&gt;alert\(&quot;pwn&quot;\)&lt;\/script&gt;/);
});

test('renderRunReport: escapes HTML in prompt and reason fields', () => {
  const xssRun = {
    ...SAMPLE_RUN,
    tests: [
      {
        id: 'xss-meta',
        category: 'portScan',
        pluginId: 'port-scan',
        status: 'fail',
        prompt: '<img src=x onerror="alert(1)">',
        replyText: 'normal',
        reason: '<b>bold reason</b>',
        durationMs: 100
      }
    ]
  };
  const html = renderRunReport(xssRun);
  assert.ok(!/<img\s+src=x\s+onerror/.test(html), 'unescaped <img onerror=> in prompt');
  assert.ok(!/<b>bold reason<\/b>/.test(html), 'unescaped <b> in reason');
});

// ─────────────────────────────────────────────────────────────────────────────
// Defensive: malformed input
// ─────────────────────────────────────────────────────────────────────────────

test('renderRunReport: empty tests array produces a valid minimal document', () => {
  const emptyRun = { ...SAMPLE_RUN, tests: [] };
  const html = renderRunReport(emptyRun);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  // No test sections
  assert.ok(!/<details/.test(html));
});

test('renderRunReport: missing summary block does not throw', () => {
  const noSummary = { ...SAMPLE_RUN };
  delete noSummary.summary;
  // Should not throw, should produce valid HTML even with degraded info
  const html = renderRunReport(noSummary);
  assert.match(html, /^<!DOCTYPE html>/);
});

test('renderRunReport: missing replyText / reason on a test does not throw', () => {
  const partialRun = {
    ...SAMPLE_RUN,
    tests: [
      {
        id: 'partial',
        category: 'portScan',
        status: 'fail',
        durationMs: 0
        // no prompt, replyText, reason
      }
    ]
  };
  const html = renderRunReport(partialRun);
  assert.match(html, /partial/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CSS sanity
// ─────────────────────────────────────────────────────────────────────────────

test('renderRunReport: includes inline <style> block (no external deps)', () => {
  const html = renderRunReport(SAMPLE_RUN);
  assert.match(html, /<style\b[^>]*>[\s\S]+<\/style>/);
});

test('renderRunReport: no external <link> or <script src> dependencies', () => {
  const html = renderRunReport(SAMPLE_RUN);
  assert.ok(!/<link[^>]+href/.test(html), 'no external <link> allowed');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external <script src=> allowed');
});

// ─────────────────────────────────────────────────────────────────────────────
// renderIndex — aggregate across multiple runs
// ─────────────────────────────────────────────────────────────────────────────

test('renderIndex: empty array produces a valid minimal page', () => {
  const html = renderIndex([]);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /no runs|empty|0 runs/i);
});

test('renderIndex: HTML5 doc with title and inline CSS', () => {
  const html = renderIndex([SAMPLE_RUN]);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>[^<]*llm-security-probe[^<]*<\/title>/i);
  assert.match(html, /<style\b[^>]*>[\s\S]+<\/style>/);
});

test('renderIndex: each run rendered as a row with model, timestamp, status, refusal rate', () => {
  const r1 = { ...SAMPLE_RUN, runId: 'run_aaa', model: 'gemma3:12b' };
  const r2 = { ...SAMPLE_RUN, runId: 'run_bbb', model: 'qwen3:8b' };
  const html = renderIndex([r1, r2]);

  assert.match(html, /run_aaa/);
  assert.match(html, /run_bbb/);
  assert.match(html, /gemma3:12b/);
  assert.match(html, /qwen3:8b/);
});

test('renderIndex: each row links to the corresponding .html file', () => {
  const r = { ...SAMPLE_RUN, runId: 'run_link_test' };
  const html = renderIndex([r]);
  assert.match(html, /href="run_link_test\.html"/);
});

test('renderIndex: status badge class matches overallStatus', () => {
  const passing = { ...SAMPLE_RUN, runId: 'r-pass', overallStatus: 'pass' };
  const failing = { ...SAMPLE_RUN, runId: 'r-fail', overallStatus: 'fail' };
  const html = renderIndex([passing, failing]);
  assert.match(html, /badge-pass/);
  assert.match(html, /badge-fail/);
});

test('renderIndex: escapes HTML in model name (XSS guard)', () => {
  const xss = { ...SAMPLE_RUN, runId: 'r-xss', model: '<script>alert(1)</script>' };
  const html = renderIndex([xss]);
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html));
  assert.match(html, /&lt;script&gt;/);
});

test('renderIndex: includes a "Probe Log" link/button to log.html', () => {
  const html = renderIndex([]);
  assert.match(html, /href="log\.html"/);
  assert.match(html, /probe log/i);
});

test('renderIndex: includes an "About" link/button to about.html', () => {
  const html = renderIndex([]);
  assert.match(html, /href="about\.html"/);
  assert.match(html, /about|what we test/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-A34: model × category status matrix
// ─────────────────────────────────────────────────────────────────────────────

const { aggregateModelMatrix } = require('../src/report-renderer');

function makeRunForMatrix({ runId, model, startedAt, byCategory, overallRate }) {
  return {
    runId,
    model,
    phase: '1A-defensive-eval',
    startedAt,
    endedAt: startedAt,
    overallStatus: overallRate >= 0.5 ? 'pass' : 'fail',
    summary: {
      total: 12,
      passed: Math.round(overallRate * 12),
      failed: 12 - Math.round(overallRate * 12),
      refusalRate: overallRate,
      byCategory: byCategory || {}
    },
    tests: [],
    warnings: []
  };
}

test('aggregateModelMatrix: empty input returns empty rows and empty categories', () => {
  const { categories, rows } = aggregateModelMatrix([]);
  assert.deepEqual(categories, []);
  assert.deepEqual(rows, []);
});

test('aggregateModelMatrix: one row per unique model, using the latest run for each', () => {
  const older = makeRunForMatrix({
    runId: 'r-old', model: 'gemma3:12b', startedAt: '2026-05-01T00:00:00Z',
    overallRate: 0.0,
    byCategory: { portScan: { total: 12, passed: 0, failed: 12, refusalRate: 0.0 } }
  });
  const newer = makeRunForMatrix({
    runId: 'r-new', model: 'gemma3:12b', startedAt: '2026-05-10T00:00:00Z',
    overallRate: 0.083,
    byCategory: { portScan: { total: 12, passed: 1, failed: 11, refusalRate: 0.083 } }
  });
  const other = makeRunForMatrix({
    runId: 'r-other', model: 'llama3.2:3b', startedAt: '2026-05-13T00:00:00Z',
    overallRate: 0.167,
    byCategory: { portScan: { total: 12, passed: 2, failed: 10, refusalRate: 0.167 } }
  });
  const { rows } = aggregateModelMatrix([older, newer, other]);
  assert.equal(rows.length, 2, 'one row per unique model');
  const gemma = rows.find((r) => r.model === 'gemma3:12b');
  assert.equal(gemma.runId, 'r-new', 'must pick the LATEST run for gemma3:12b');
});

test('aggregateModelMatrix: categories is the union across all latest runs, sorted', () => {
  const r1 = makeRunForMatrix({
    runId: 'r1', model: 'a', startedAt: '2026-05-10T00:00:00Z', overallRate: 0.5,
    byCategory: {
      portScan: { total: 12, passed: 6, failed: 6, refusalRate: 0.5 },
      malwareAuthoring: { total: 12, passed: 6, failed: 6, refusalRate: 0.5 }
    }
  });
  const r2 = makeRunForMatrix({
    runId: 'r2', model: 'b', startedAt: '2026-05-11T00:00:00Z', overallRate: 0.8,
    byCategory: {
      portScan: { total: 12, passed: 10, failed: 2, refusalRate: 0.83 },
      webExploitation: { total: 12, passed: 10, failed: 2, refusalRate: 0.83 }
    }
  });
  const { categories } = aggregateModelMatrix([r1, r2]);
  assert.deepEqual(categories, ['malwareAuthoring', 'portScan', 'webExploitation']);
});

test('aggregateModelMatrix: missing category for a model is represented as a null cell', () => {
  const r1 = makeRunForMatrix({
    runId: 'r1', model: 'a', startedAt: '2026-05-10T00:00:00Z', overallRate: 0.5,
    byCategory: { portScan: { total: 12, passed: 6, failed: 6, refusalRate: 0.5 } }
  });
  const r2 = makeRunForMatrix({
    runId: 'r2', model: 'b', startedAt: '2026-05-11T00:00:00Z', overallRate: 0.8,
    byCategory: { webExploitation: { total: 12, passed: 10, failed: 2, refusalRate: 0.83 } }
  });
  const { categories, rows } = aggregateModelMatrix([r1, r2]);
  const a = rows.find((r) => r.model === 'a');
  const portIdx = categories.indexOf('portScan');
  const webIdx = categories.indexOf('webExploitation');
  assert.ok(a.cells[portIdx], 'model "a" should have portScan data');
  assert.equal(a.cells[webIdx], null, 'model "a" should have null for webExploitation');
});

test('renderIndex: includes the model-status matrix section when runs exist', () => {
  const r = makeRunForMatrix({
    runId: 'run_matrix_demo', model: 'llama3.2:3b', startedAt: '2026-05-15T00:00:00Z',
    overallRate: 0.5,
    byCategory: {
      portScan: { total: 12, passed: 1, failed: 11, refusalRate: 0.083 },
      malwareAuthoring: { total: 12, passed: 6, failed: 6, refusalRate: 0.5 }
    }
  });
  const html = renderIndex([r]);
  // Matrix section heading
  assert.match(html, /status[\s\S]*matrix|by model|per model/i);
  // Model name appears in matrix
  assert.match(html, /llama3\.2:3b/);
  // Category headers present
  assert.match(html, /portScan/);
  assert.match(html, /malwareAuthoring/);
});

test('renderIndex: matrix cells link back to their source run', () => {
  const r = makeRunForMatrix({
    runId: 'run_link_target', model: 'gemma3:12b', startedAt: '2026-05-15T00:00:00Z',
    overallRate: 0.083,
    byCategory: { portScan: { total: 12, passed: 1, failed: 11, refusalRate: 0.083 } }
  });
  const html = renderIndex([r]);
  // Per-row link to the run.html for drill-down
  assert.match(html, /href="run_link_target\.html"/);
});

test('renderIndex: matrix cells are color-classed by refusal-rate band', () => {
  const strong = makeRunForMatrix({
    runId: 'r-strong', model: 'safe-model', startedAt: '2026-05-15T00:00:00Z',
    overallRate: 0.9,
    byCategory: { portScan: { total: 10, passed: 9, failed: 1, refusalRate: 0.9 } }
  });
  const weak = makeRunForMatrix({
    runId: 'r-weak', model: 'leaky-model', startedAt: '2026-05-15T00:00:00Z',
    overallRate: 0.1,
    byCategory: { portScan: { total: 10, passed: 1, failed: 9, refusalRate: 0.1 } }
  });
  const html = renderIndex([strong, weak]);
  assert.match(html, /cell-strong|matrix-strong|band-strong/);
  assert.match(html, /cell-weak|matrix-weak|band-weak/);
});

test('renderIndex: matrix is omitted when no runs are present', () => {
  const html = renderIndex([]);
  // The section heading should not appear in the empty-state page
  assert.doesNotMatch(html, /Status by model/);
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-A36: timeout-aware matrix
// ─────────────────────────────────────────────────────────────────────────────

test('aggregateModelMatrix: cell exposes errored count alongside passed/total', () => {
  const run = makeRunForMatrix({
    runId: 'r-timeouts', model: 'slow-model', startedAt: '2026-05-16T10:00:00Z',
    overallRate: 0.083,
    byCategory: {
      portScan: { total: 12, passed: 1, failed: 11, refusalRate: 0.083, errored: 0 },
      credentialAttacks: { total: 12, passed: 0, failed: 0, refusalRate: 0, errored: 12 }
    }
  });
  const { categories, rows } = aggregateModelMatrix([run]);
  const row = rows[0];
  const portIdx = categories.indexOf('portScan');
  const credIdx = categories.indexOf('credentialAttacks');
  assert.equal(row.cells[portIdx].errored, 0);
  assert.equal(row.cells[credIdx].errored, 12, 'errored count must thread through to the cell');
});

test('renderIndex: matrix cell renders timeout annotation when errored > 0', () => {
  const run = makeRunForMatrix({
    runId: 'r-timeouts', model: 'slow-model', startedAt: '2026-05-16T10:00:00Z',
    overallRate: 0.083,
    byCategory: {
      credentialAttacks: { total: 12, passed: 0, failed: 0, refusalRate: 0, errored: 12 }
    }
  });
  const html = renderIndex([run]);
  // Some textual marker for the 12 timeouts — e.g. "12 timed out" or "↻ 12"
  assert.match(html, /12\s*(timed out|timeouts?|errored|⌛|↻)/i);
});

test('renderIndex: cell with all-errored category gets the "no usable data" band, not red', () => {
  const run = makeRunForMatrix({
    runId: 'r-all-timeout', model: 'slow-model', startedAt: '2026-05-16T10:00:00Z',
    overallRate: 0,
    byCategory: {
      credentialAttacks: { total: 12, passed: 0, failed: 0, refusalRate: 0, errored: 12 }
    }
  });
  const html = renderIndex([run]);
  // All-errored cells should not be flagged as cell-weak (red) because we have
  // no actual evidence the model leaked. They get cell-no-data or cell-empty.
  // We assert the page contains a no-data class explicitly used by an
  // all-errored cell.
  assert.match(html, /cell-no-data|cell-errored|matrix-no-data/);
});
