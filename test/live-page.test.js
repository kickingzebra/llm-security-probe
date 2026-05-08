'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderLivePage } = require('../src/live-page');

// ─────────────────────────────────────────────────────────────────────────────
// Structure
// ─────────────────────────────────────────────────────────────────────────────

test('renderLivePage: returns a complete HTML5 document', () => {
  const html = renderLivePage();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<meta charset="utf-8">/);
});

test('renderLivePage: <title> mentions live + llm-security-probe', () => {
  const html = renderLivePage();
  assert.match(html, /<title>[^<]*live[^<]*llm-security-probe[^<]*<\/title>/i);
});

test('renderLivePage: includes inline <style> (no external CSS dep)', () => {
  const html = renderLivePage();
  assert.match(html, /<style\b[^>]*>[\s\S]+<\/style>/);
});

test('renderLivePage: no external <link> or <script src=> dependencies', () => {
  const html = renderLivePage();
  assert.ok(!/<link[^>]+href/.test(html), 'no external <link> allowed');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external <script src=> allowed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Polling client behaviour (inspect inline <script> source)
// ─────────────────────────────────────────────────────────────────────────────

test('renderLivePage: inline <script> polls /api/runs', () => {
  const html = renderLivePage();
  // Source string should reference the API endpoint
  assert.match(html, /\/api\/runs/);
});

test('renderLivePage: inline <script> uses fetch and setInterval/setTimeout for polling', () => {
  const html = renderLivePage();
  assert.match(html, /\bfetch\s*\(/);
  // Either setInterval or recursive setTimeout is acceptable
  assert.ok(
    /setInterval|setTimeout/.test(html),
    'expected setInterval or setTimeout in polling JS'
  );
});

test('renderLivePage: polling interval is configurable via constant', () => {
  const html = renderLivePage();
  // Refresh interval should be ~2000 ms — visible in the source as a number
  assert.match(html, /\b2000\b/);
});

test('renderLivePage: polling interval can be overridden via options', () => {
  const fast = renderLivePage({ pollMs: 500 });
  assert.match(fast, /\b500\b/);
  // and the default 2000 should NOT appear when an explicit override is set
  assert.ok(!/\b2000\b/.test(fast.match(/<script[^>]*>([\s\S]+?)<\/script>/)[1]),
    'override should replace the default in inline JS');
});

// ─────────────────────────────────────────────────────────────────────────────
// Page sections
// ─────────────────────────────────────────────────────────────────────────────

test('renderLivePage: has a section for in-progress runs', () => {
  const html = renderLivePage();
  assert.match(html, /id="in-progress"/);
});

test('renderLivePage: has a section for recent runs', () => {
  const html = renderLivePage();
  assert.match(html, /id="recent"/);
});

test('renderLivePage: has a link back to /index.html (full historical index)', () => {
  const html = renderLivePage();
  assert.match(html, /href="index\.html"/);
});

test('renderLivePage: empty-state message displayed when no runs', () => {
  const html = renderLivePage();
  // Initial markup should contain a placeholder visible before first poll
  assert.match(html, /no runs|empty|loading/i);
});
