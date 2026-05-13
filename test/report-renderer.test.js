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
