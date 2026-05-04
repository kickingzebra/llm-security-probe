'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generate,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_NUM_PREDICT
} = require('../src/ollama-client');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function fetchOk(jsonBody) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody)
  });
}

function fetchStatus(status, body = '') {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      try {
        return JSON.parse(body);
      } catch {
        throw new SyntaxError('Unexpected token');
      }
    },
    text: async () => body
  });
}

function fetchThrows(err) {
  return async () => {
    throw err;
  };
}

function fetchHangs(_signalRef) {
  // Returns a promise that only resolves when AbortController fires.
  return async (_url, options) => {
    return new Promise((resolve, reject) => {
      if (options && options.signal) {
        options.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };
}

const SAMPLE_RESPONSE = {
  model: 'gemma3:12b',
  created_at: '2026-05-03T15:00:00Z',
  response: 'I refuse to help with that request.',
  done: true,
  total_duration: 1820000000,
  eval_count: 42,
  eval_duration: 800000000
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

test('DEFAULT_BASE_URL matches the local Ollama default', () => {
  assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:11434');
});

test('DEFAULT_TIMEOUT_MS is 90s (PR-A9 perf cap, was 5min)', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 90_000);
});

test('DEFAULT_NUM_PREDICT is 400 (PR-A9 response-length cap)', () => {
  assert.equal(DEFAULT_NUM_PREDICT, 400);
});

test('default request body sets options.num_predict=400 when no user options', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => SAMPLE_RESPONSE,
      text: async () => JSON.stringify(SAMPLE_RESPONSE)
    };
  };
  await generate({ model: 'gemma3:12b', prompt: 'Hi', fetchImpl });
  assert.equal(capturedBody.options.num_predict, 400);
});

test('user-provided num_predict overrides the default cap', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => SAMPLE_RESPONSE,
      text: async () => JSON.stringify(SAMPLE_RESPONSE)
    };
  };
  await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    options: { num_predict: 50 },
    fetchImpl
  });
  assert.equal(capturedBody.options.num_predict, 50);
});

test('default num_predict merges with other user options (e.g. temperature)', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => SAMPLE_RESPONSE,
      text: async () => JSON.stringify(SAMPLE_RESPONSE)
    };
  };
  await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    options: { temperature: 0.0 },
    fetchImpl
  });
  assert.equal(capturedBody.options.num_predict, 400);
  assert.equal(capturedBody.options.temperature, 0.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required params
// ─────────────────────────────────────────────────────────────────────────────

test('missing model: returns ok=false with code=missing_param', async () => {
  const result = await generate({
    prompt: 'hi',
    fetchImpl: fetchOk(SAMPLE_RESPONSE)
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_param');
  assert.match(result.error.message, /model/);
});

test('missing prompt: returns ok=false with code=missing_param', async () => {
  const result = await generate({
    model: 'gemma3:12b',
    fetchImpl: fetchOk(SAMPLE_RESPONSE)
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_param');
  assert.match(result.error.message, /prompt/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test('happy path: 200 returns ok=true with normalised response', async () => {
  const result = await generate({
    model: 'gemma3:12b',
    prompt: 'Test prompt',
    fetchImpl: fetchOk(SAMPLE_RESPONSE)
  });

  assert.equal(result.ok, true);
  assert.equal(result.response.text, 'I refuse to help with that request.');
  assert.equal(result.response.model, 'gemma3:12b');
  assert.equal(result.response.totalDurationNs, 1820000000);
  assert.equal(result.response.evalCount, 42);
  assert.equal(result.response.done, true);
});

test('request body includes model + prompt + stream=false', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => SAMPLE_RESPONSE,
      text: async () => JSON.stringify(SAMPLE_RESPONSE)
    };
  };

  await generate({ model: 'gemma3:12b', prompt: 'Hi', fetchImpl });

  assert.equal(capturedBody.model, 'gemma3:12b');
  assert.equal(capturedBody.prompt, 'Hi');
  assert.equal(capturedBody.stream, false);
});

test('system prompt is included in request body when provided', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => SAMPLE_RESPONSE,
      text: async () => JSON.stringify(SAMPLE_RESPONSE)
    };
  };

  await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    systemPrompt: 'You are a security-aware assistant.',
    fetchImpl
  });

  assert.equal(capturedBody.system, 'You are a security-aware assistant.');
});

test('options (temperature etc.) are passed through under "options" key', async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => SAMPLE_RESPONSE,
      text: async () => JSON.stringify(SAMPLE_RESPONSE)
    };
  };

  await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    options: { temperature: 0.0, num_predict: 100 },
    fetchImpl
  });

  assert.deepEqual(capturedBody.options, { temperature: 0.0, num_predict: 100 });
});

test('default baseUrl is used when not provided', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => SAMPLE_RESPONSE,
      text: async () => JSON.stringify(SAMPLE_RESPONSE)
    };
  };

  await generate({ model: 'gemma3:12b', prompt: 'Hi', fetchImpl });

  assert.equal(capturedUrl, 'http://127.0.0.1:11434/api/generate');
});

// ─────────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────────

test('404 response: returns ok=false with code=not_found', async () => {
  const result = await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    fetchImpl: fetchStatus(404, 'Not Found')
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not_found');
});

test('500 response: returns ok=false with code=unexpected_status', async () => {
  const result = await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    fetchImpl: fetchStatus(500, 'oops')
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unexpected_status');
  assert.equal(result.error.status, 500);
});

test('ECONNREFUSED: returns ok=false with code=connection_refused', async () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };
  const result = await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    fetchImpl: fetchThrows(err)
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'connection_refused');
});

test('generic network error: returns ok=false with code=network_error', async () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ENOTFOUND' };
  const result = await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    fetchImpl: fetchThrows(err)
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'network_error');
});

test('malformed JSON response: returns ok=false with code=invalid_json', async () => {
  const result = await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    fetchImpl: fetchStatus(200, '{ not valid')
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_json');
});

test('timeout: aborts the request and returns code=timeout', async () => {
  const result = await generate({
    model: 'gemma3:12b',
    prompt: 'Hi',
    timeoutMs: 30,
    fetchImpl: fetchHangs()
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
});
