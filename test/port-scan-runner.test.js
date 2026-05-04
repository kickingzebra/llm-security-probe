'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runPortScanSuite } = require('../src/port-scan-runner');
const { PROMPTS } = require('../src/port-scan-plugin');

// ─────────────────────────────────────────────────────────────────────────────
// Generate-stub helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateAlwaysRefuses() {
  return async () => ({
    ok: true,
    response: {
      text: "I can't help with that — port scanning networks without explicit authorisation is unsafe.",
      model: 'test-model',
      totalDurationNs: 1_000_000_000,
      evalCount: 30,
      evalDurationNs: 800_000_000,
      done: true
    }
  });
}

function generateAlwaysComplies() {
  return async () => ({
    ok: true,
    response: {
      text: 'Sure! Run `nmap -sS 10.0.0.0/24` to scan that subnet.',
      model: 'test-model',
      totalDurationNs: 1_500_000_000,
      evalCount: 50,
      evalDurationNs: 1_200_000_000,
      done: true
    }
  });
}

function generateAlwaysErrors(code = 'connection_refused') {
  return async () => ({
    ok: false,
    error: { code, message: `Ollama unreachable: ${code}` }
  });
}

function generatePerPromptResponses(responsesById) {
  let i = 0;
  return async ({ prompt: promptText }) => {
    // We pass the whole prompt body; figure out which prompt this is by
    // matching the body against PROMPTS.
    const match = PROMPTS.find((p) => p.prompt === promptText);
    const id = match ? match.id : `unknown-${i++}`;
    const text = responsesById[id];
    if (text === undefined) {
      return { ok: false, error: { code: 'missing_stub', message: `no stub for ${id}` } };
    }
    return {
      ok: true,
      response: {
        text,
        model: 'test-model',
        totalDurationNs: 1_000_000_000,
        evalCount: 30,
        done: true
      }
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Required params
// ─────────────────────────────────────────────────────────────────────────────

test('missing model: returns ok=false with code=missing_param', async () => {
  const result = await runPortScanSuite({
    generateImpl: generateAlwaysRefuses()
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_param');
  assert.match(result.error.message, /model/);
});

// ─────────────────────────────────────────────────────────────────────────────
// All-pass / all-fail / mixed
// ─────────────────────────────────────────────────────────────────────────────

test('all prompts refused: every test passes; stats correct', async () => {
  const result = await runPortScanSuite({
    model: 'gemma3:12b',
    generateImpl: generateAlwaysRefuses()
  });

  assert.equal(result.ok, true);
  assert.equal(result.tests.length, PROMPTS.length);
  assert.equal(result.stats.total, PROMPTS.length);
  assert.equal(result.stats.passed, PROMPTS.length);
  assert.equal(result.stats.failed, 0);
  for (const t of result.tests) {
    assert.equal(t.status, 'pass');
    assert.equal(t.category, 'portScan');
    assert.equal(t.pluginId, 'port-scan');
  }
});

test('all prompts leak nmap: every test fails', async () => {
  const result = await runPortScanSuite({
    model: 'gemma3:12b',
    generateImpl: generateAlwaysComplies()
  });

  assert.equal(result.ok, true);
  assert.equal(result.tests.length, PROMPTS.length);
  assert.equal(result.stats.failed, PROMPTS.length);
  assert.equal(result.stats.passed, 0);
  for (const t of result.tests) {
    assert.equal(t.status, 'fail');
    assert.match(t.reason, /blocklist|nmap/i);
  }
});

test('mixed responses: per-prompt outcomes propagate correctly', async () => {
  // Refuse first, comply second, refuse rest
  const responsesById = {};
  PROMPTS.forEach((p, idx) => {
    if (idx === 0) responsesById[p.id] = "I can't help with that.";
    else if (idx === 1) responsesById[p.id] = 'Try nmap -sV against that range.';
    else responsesById[p.id] = 'I refuse — that would be unauthorised network scanning.';
  });

  const result = await runPortScanSuite({
    model: 'gemma3:12b',
    generateImpl: generatePerPromptResponses(responsesById)
  });

  assert.equal(result.ok, true);
  assert.equal(result.tests[0].status, 'pass');
  assert.equal(result.tests[1].status, 'fail');
  for (let i = 2; i < result.tests.length; i += 1) {
    assert.equal(result.tests[i].status, 'pass');
  }
  assert.equal(result.stats.passed, PROMPTS.length - 1);
  assert.equal(result.stats.failed, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Generate failure handling
// ─────────────────────────────────────────────────────────────────────────────

test('generate error on every prompt: tests recorded as fail with generate_error reason', async () => {
  const result = await runPortScanSuite({
    model: 'gemma3:12b',
    generateImpl: generateAlwaysErrors('connection_refused')
  });

  assert.equal(result.ok, true);
  assert.equal(result.stats.failed, PROMPTS.length);
  assert.equal(result.stats.passed, 0);
  for (const t of result.tests) {
    assert.equal(t.status, 'fail');
    assert.match(t.reason, /generate_error|connection_refused/);
    assert.equal(t.replyText, '');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Output shape — must match the dashboard tests[] schema
// ─────────────────────────────────────────────────────────────────────────────

test('test entries match dashboard schema (id, category, pluginId, status, prompt, replyText, reason, durationMs)', async () => {
  const result = await runPortScanSuite({
    model: 'gemma3:12b',
    generateImpl: generateAlwaysRefuses()
  });

  for (const t of result.tests) {
    assert.equal(typeof t.id, 'string');
    assert.equal(t.category, 'portScan');
    assert.equal(t.pluginId, 'port-scan');
    assert.ok(t.status === 'pass' || t.status === 'fail');
    assert.equal(typeof t.prompt, 'string');
    assert.ok(t.prompt.length > 0);
    assert.equal(typeof t.replyText, 'string');
    assert.equal(typeof t.reason, 'string');
    assert.equal(typeof t.durationMs, 'number');
    assert.ok(t.durationMs >= 0);
  }
});

test('test ids match the underlying plugin prompt ids', async () => {
  const result = await runPortScanSuite({
    model: 'gemma3:12b',
    generateImpl: generateAlwaysRefuses()
  });

  const expectedIds = PROMPTS.map((p) => p.id);
  const actualIds = result.tests.map((t) => t.id);
  assert.deepEqual(actualIds, expectedIds);
});

test('passes model + prompt + timeoutMs through to generateImpl', async () => {
  const calls = [];
  const generateImpl = async (args) => {
    calls.push({ ...args });
    return {
      ok: true,
      response: {
        text: "I won't do that.",
        model: args.model,
        totalDurationNs: 1_000_000,
        done: true
      }
    };
  };

  await runPortScanSuite({
    model: 'qwen3.5:27b',
    timeoutMs: 12345,
    generateImpl
  });

  assert.equal(calls.length, PROMPTS.length);
  for (const c of calls) {
    assert.equal(c.model, 'qwen3.5:27b');
    assert.equal(c.timeoutMs, 12345);
    assert.ok(typeof c.prompt === 'string' && c.prompt.length > 0);
  }
});
