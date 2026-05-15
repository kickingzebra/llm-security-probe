'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PLUGIN_ID,
  CATEGORY,
  PROMPTS,
  CHECKS,
  DEFAULT_BASE_URL
} = require('../src/ollama-api-audit-plugin');
const { runOllamaApiAuditSuite } = require('../src/ollama-api-audit-runner');

test('PLUGIN_ID is "ollama-api-audit"', () => {
  assert.equal(PLUGIN_ID, 'ollama-api-audit');
});

test('CATEGORY is "apiAudit"', () => {
  assert.equal(CATEGORY, 'apiAudit');
});

test('CHECKS catalogue is non-empty and well-formed', () => {
  assert.ok(Array.isArray(CHECKS));
  assert.ok(CHECKS.length >= 8);
  for (const c of CHECKS) {
    assert.equal(typeof c.id, 'string');
    assert.match(c.severity, /^(low|medium|high)$/);
    assert.equal(typeof c.description, 'string');
    assert.equal(typeof c.run, 'function');
  }
});

test('PROMPTS view exposes each check as a prompt-shaped record', () => {
  assert.equal(PROMPTS.length, CHECKS.length);
  for (const p of PROMPTS) {
    assert.equal(p.category, 'apiAudit');
    assert.equal(typeof p.severity, 'string');
    assert.equal(typeof p.prompt, 'string');
  }
});

test('CHECKS cover the canonical posture surfaces', () => {
  const ids = CHECKS.map((c) => c.id).join(' | ');
  assert.match(ids, /anonymous-tags|tags-access/, 'expected /api/tags posture check');
  assert.match(ids, /anonymous-generate|generate-access/, 'expected /api/generate posture check');
  assert.match(ids, /show/, 'expected /api/show posture check');
  assert.match(ids, /version/, 'expected version-leak check');
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner — feed a scripted fetchImpl and verify each check's pass/fail logic
// ─────────────────────────────────────────────────────────────────────────────

function makeFetchStub(routes) {
  // routes: map of `${METHOD} ${path}` → ({ url, init }) => { status, body, headers? }
  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const key = `${method} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) {
      const err = new Error('ECONNREFUSED');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    const out = typeof handler === 'function' ? handler({ url, init }) : handler;
    return {
      status: out.status,
      headers: {
        get: (name) => (out.headers && out.headers[name.toLowerCase()]) || null
      },
      async json() {
        return out.body;
      }
    };
  };
}

test('runOllamaApiAuditSuite: locked-down server (auth required everywhere) → most checks PASS', async () => {
  const fetchImpl = makeFetchStub({
    'GET /api/tags': { status: 401, body: null },
    'POST /api/generate': { status: 401, body: null },
    'POST /api/show': { status: 401, body: null },
    'GET /api/ps': { status: 401, body: null },
    'GET /api/version': { status: 404, body: null },
    'OPTIONS /api/tags': { status: 401, body: null },
    'POST /api/pull': { status: 401, body: null }
  });

  const r = await runOllamaApiAuditSuite({ baseUrl: 'http://stub:11434', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.tests.length, CHECKS.length);

  // A locked-down server should pass almost every check. There can be edge
  // cases (e.g. checks that depend on /api/tags returning models to probe a
  // dependent endpoint — those gracefully PASS too with "no model available").
  const fails = r.tests.filter((t) => t.status === 'fail').map((t) => t.id);
  assert.equal(fails.length, 0, `expected 0 fails on a locked-down server, got: ${fails.join(', ')}`);
});

test('runOllamaApiAuditSuite: wide-open server → high-severity FAILS surface', async () => {
  const fetchImpl = makeFetchStub({
    'GET /api/tags': {
      status: 200,
      body: {
        models: [
          {
            name: 'gemma3:12b',
            size: 8123456789,
            modified_at: '2026-05-01T00:00:00Z',
            details: { parameter_size: '12B', quantization_level: 'Q4_K_M' }
          }
        ]
      }
    },
    'POST /api/generate': { status: 200, body: { response: 'hi' } },
    'POST /api/show': {
      status: 200,
      body: {
        modelfile: 'FROM gemma3\nSYSTEM "you are helpful"',
        system: 'you are helpful',
        template: '{{ .Prompt }}',
        parameters: 'temperature 0.7'
      }
    },
    'GET /api/ps': { status: 200, body: { models: [{ name: 'gemma3:12b' }] } },
    'GET /api/version': { status: 200, body: { version: '0.20.6' } },
    'OPTIONS /api/tags': { status: 204, body: null, headers: { 'access-control-allow-origin': '*' } },
    'POST /api/pull': { status: 200, body: { status: 'pulling' } }
  });

  const r = await runOllamaApiAuditSuite({ baseUrl: 'http://stub:11434', fetchImpl });
  assert.equal(r.ok, true);
  const failedIds = r.tests.filter((t) => t.status === 'fail').map((t) => t.id);
  assert.ok(failedIds.includes('anonymous-tags-access'), 'should fail anonymous-tags-access');
  assert.ok(failedIds.includes('anonymous-generate-access'), 'should fail anonymous-generate-access');
  assert.ok(failedIds.includes('system-prompt-leak-via-show'), 'should fail system-prompt-leak-via-show');
  assert.ok(failedIds.includes('version-endpoint-leak'), 'should fail version-endpoint-leak');
  assert.ok(failedIds.includes('cors-permissive'), 'should fail cors-permissive');
});

test('runOllamaApiAuditSuite: each test entry tags severity for triage', async () => {
  const fetchImpl = makeFetchStub({
    'GET /api/tags': { status: 401, body: null }
  });
  const r = await runOllamaApiAuditSuite({ baseUrl: 'http://stub:11434', fetchImpl });
  for (const t of r.tests) {
    assert.match(t.severity, /^(low|medium|high)$/, `${t.id} severity missing`);
  }
});

test('runOllamaApiAuditSuite: missing fetchImpl returns no_fetch error', async () => {
  const r = await runOllamaApiAuditSuite({ baseUrl: 'http://stub', fetchImpl: null });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_fetch');
});

test('DEFAULT_BASE_URL points at the local Ollama default', () => {
  assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:11434');
});
