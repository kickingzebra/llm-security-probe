'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderAboutPage, getCategoriesSnapshot } = require('../src/about-page');

// ─────────────────────────────────────────────────────────────────────────────
// Structure
// ─────────────────────────────────────────────────────────────────────────────

test('renderAboutPage: returns a complete HTML5 document', () => {
  const html = renderAboutPage();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<meta charset="utf-8">/);
});

test('renderAboutPage: <title> mentions about / what we test / llm-security-probe', () => {
  const html = renderAboutPage();
  assert.match(html, /<title>[^<]*(about|what)[^<]*<\/title>/i);
  assert.match(html, /<title>[^<]*llm-security-probe[^<]*<\/title>/i);
});

test('renderAboutPage: inline CSS only, no external <link> or <script src=>', () => {
  const html = renderAboutPage();
  assert.match(html, /<style\b[^>]*>[\s\S]+<\/style>/);
  assert.ok(!/<link[^>]+href/.test(html));
  assert.ok(!/<script[^>]+src=/.test(html));
});

// ─────────────────────────────────────────────────────────────────────────────
// Content
// ─────────────────────────────────────────────────────────────────────────────

test('renderAboutPage: explains the project mission / what it tests', () => {
  const html = renderAboutPage();
  // Mission keywords expected somewhere on the page
  assert.match(html, /defensive|refus|red-team|attack/i);
  assert.match(html, /ollama/i);
});

test('renderAboutPage: documents the pass/fail criteria (refusal + no leakage)', () => {
  const html = renderAboutPage();
  assert.match(html, /refusal/i);
  assert.match(html, /blocklist|command-shape|command shape/i);
});

test('renderAboutPage: lists categories with live prompt counts', () => {
  const html = renderAboutPage({
    categories: [
      { id: 'portScan', name: 'Port scanning', count: 12, source: 'hand-rolled', description: 'CIDR scans, port enum, banner-grab' }
    ]
  });
  assert.match(html, /port scanning/i);
  assert.match(html, /\b12\b/);
});

test('renderAboutPage: lists promptfoo-wrapped categories without per-plugin counts', () => {
  const html = renderAboutPage({
    categories: [
      { id: 'ssrf', name: 'SSRF', source: 'promptfoo', description: '' },
      { id: 'tokenLeak', name: 'Token leak', source: 'promptfoo', description: '' }
    ]
  });
  assert.match(html, /SSRF/);
  assert.match(html, /token leak/i);
  assert.match(html, /promptfoo/i);
});

test('renderAboutPage: HTML-escapes category descriptions (XSS guard)', () => {
  const html = renderAboutPage({
    categories: [
      {
        id: 'xss',
        name: '<script>alert(1)</script>',
        source: 'hand-rolled',
        description: '<img src=x onerror=alert(2)>'
      }
    ]
  });
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)/);
});

test('renderAboutPage: empty/missing categories does not throw and shows a fallback', () => {
  // Should be safe to call with no args (during dashboard regen before any
  // plugins have loaded their prompt catalogues).
  const html = renderAboutPage();
  assert.match(html, /<!DOCTYPE html>/);
  // And explicit empty list
  const html2 = renderAboutPage({ categories: [] });
  assert.match(html2, /<!DOCTYPE html>/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

test('renderAboutPage: links back to index.html', () => {
  const html = renderAboutPage();
  assert.match(html, /href="index\.html"/);
});

test('renderAboutPage: links to the live dashboard and probe log', () => {
  const html = renderAboutPage();
  assert.match(html, /href="live\.html"/);
  assert.match(html, /href="log\.html"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// getCategoriesSnapshot — single source of truth for the page
// ─────────────────────────────────────────────────────────────────────────────

test('getCategoriesSnapshot: includes the port-scan category with live PROMPTS.length', () => {
  const snap = getCategoriesSnapshot();
  const portScan = snap.find((c) => c.id === 'portScan');
  assert.ok(portScan, 'port-scan category must be present');
  assert.equal(typeof portScan.count, 'number');
  assert.ok(portScan.count >= 7, 'port-scan should have at least the 7 PR-A5 prompts');
});

test('getCategoriesSnapshot: includes the malware-authoring category', () => {
  const snap = getCategoriesSnapshot();
  const mw = snap.find((c) => c.id === 'malwareAuthoring');
  assert.ok(mw, 'malware-authoring category must be present');
  assert.equal(mw.source, 'hand-rolled');
  assert.equal(typeof mw.count, 'number');
  assert.ok(mw.count >= 10, 'malware-authoring should have at least 10 prompts');
});

test('getCategoriesSnapshot: includes the web-exploitation category', () => {
  const snap = getCategoriesSnapshot();
  const we = snap.find((c) => c.id === 'webExploitation');
  assert.ok(we, 'web-exploitation category must be present');
  assert.equal(we.source, 'hand-rolled');
  assert.equal(typeof we.count, 'number');
  assert.ok(we.count >= 10, 'web-exploitation should have at least 10 prompts');
});

test('getCategoriesSnapshot: includes the credential-attacks category', () => {
  const snap = getCategoriesSnapshot();
  const ca = snap.find((c) => c.id === 'credentialAttacks');
  assert.ok(ca, 'credential-attacks category must be present');
  assert.equal(ca.source, 'hand-rolled');
  assert.equal(typeof ca.count, 'number');
  assert.ok(ca.count >= 10, 'credential-attacks should have at least 10 prompts');
});

test('getCategoriesSnapshot: includes the privilege-escalation category', () => {
  const snap = getCategoriesSnapshot();
  const pe = snap.find((c) => c.id === 'privilegeEscalation');
  assert.ok(pe, 'privilege-escalation category must be present');
  assert.equal(pe.source, 'hand-rolled');
  assert.equal(typeof pe.count, 'number');
  assert.ok(pe.count >= 10, 'privilege-escalation should have at least 10 prompts');
});

test('getCategoriesSnapshot: includes the encoded-jailbreaks robustness category', () => {
  const snap = getCategoriesSnapshot();
  const ej = snap.find((c) => c.id === 'encodedJailbreaks');
  assert.ok(ej, 'encoded-jailbreaks category must be present');
  assert.equal(ej.source, 'hand-rolled');
  assert.equal(typeof ej.count, 'number');
  assert.ok(ej.count >= 10, 'encoded-jailbreaks should have at least 10 prompts');
});

test('getCategoriesSnapshot: includes the promptfoo-wrapped categories', () => {
  const snap = getCategoriesSnapshot();
  const ids = snap.map((c) => c.id);
  // The four categories wrapped via promptfoo deterministic plugins
  assert.ok(ids.includes('ssrf'));
  assert.ok(ids.includes('tokenLeak'));
});
