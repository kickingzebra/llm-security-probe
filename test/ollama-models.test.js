'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listInstalledModels } = require('../src/ollama-models');

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

const SAMPLE_TAGS_RESPONSE = {
  models: [
    {
      name: 'gemma3:12b',
      modified_at: '2026-04-18T12:00:00Z',
      size: 7234567890,
      digest: 'sha256:abc123',
      details: { parameter_size: '12B', quantization_level: 'Q4_K_M' }
    },
    {
      name: 'qwen3.5:27b',
      modified_at: '2026-04-19T09:30:00Z',
      size: 16234567890,
      digest: 'sha256:def456',
      details: { parameter_size: '27B', quantization_level: 'Q4_K_M' }
    }
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('happy path: 200 with valid JSON returns normalised models list', async () => {
  const result = await listInstalledModels({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: fetchOk(SAMPLE_TAGS_RESPONSE)
  });

  assert.equal(result.ok, true);
  assert.equal(result.models.length, 2);
  assert.deepEqual(result.models[0], {
    name: 'gemma3:12b',
    sizeBytes: 7234567890,
    modifiedAt: '2026-04-18T12:00:00Z',
    parameterSize: '12B',
    quantization: 'Q4_K_M'
  });
  assert.equal(result.models[1].name, 'qwen3.5:27b');
});

test('empty response: 200 with models=[] returns empty list, ok=true', async () => {
  const result = await listInstalledModels({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: fetchOk({ models: [] })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, []);
});

test('malformed JSON: returns ok=false with code=invalid_json', async () => {
  const result = await listInstalledModels({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: fetchStatus(200, '{ this is not valid JSON')
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_json');
  assert.match(result.error.message, /JSON|parse/i);
});

test('404 response: returns ok=false with code=not_found', async () => {
  const result = await listInstalledModels({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: fetchStatus(404, 'Not Found')
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not_found');
  assert.equal(result.error.status, 404);
});

test('500 response: returns ok=false with code=unexpected_status', async () => {
  const result = await listInstalledModels({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: fetchStatus(500, 'Internal Server Error')
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unexpected_status');
  assert.equal(result.error.status, 500);
});

test('ECONNREFUSED: returns ok=false with code=connection_refused', async () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };

  const result = await listInstalledModels({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: fetchThrows(err)
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'connection_refused');
});

test('generic network error: returns ok=false with code=network_error', async () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ENOTFOUND' };

  const result = await listInstalledModels({
    baseUrl: 'http://nonexistent.invalid:11434',
    fetchImpl: fetchThrows(err)
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'network_error');
});

test('default baseUrl is http://127.0.0.1:11434 when not provided', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
      text: async () => '{"models":[]}'
    };
  };

  await listInstalledModels({ fetchImpl });

  assert.equal(capturedUrl, 'http://127.0.0.1:11434/api/tags');
});
