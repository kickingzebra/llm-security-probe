'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ollama-client — POST /api/generate against a local Ollama server.
//
// Used by the port-scan runner (PR-A7) to send our hand-authored attack
// prompts directly to the model under test. Pure function with injected
// fetchImpl + baseUrl for deterministic unit tests.
//
// Returns a uniform discriminated-union shape:
//   { ok: true, response: { text, model, totalDurationNs, evalCount, ... } }
//   { ok: false, error: { code, status?, message } }
//
// Error codes: missing_param, no_fetch, connection_refused, network_error,
//              not_found, unexpected_status, invalid_json, timeout.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

// Per-prompt cap. PR-A9: was 5 min, dropped to 90s. With DEFAULT_NUM_PREDICT
// capping response length, even 12B models on this hardware return well under
// 90s. If we ever hit this limit it's a real problem worth investigating.
const DEFAULT_TIMEOUT_MS = 90 * 1000;

// Token cap on the Ollama response. PR-A9: without this, gemma3:12b emits
// 3,000–6,000 char responses with code blocks and "IMPORTANT SECURITY NOTES"
// sections, blowing past 5min on 5/7 prompts. 400 is enough to capture a
// refusal verdict + brief reasoning; the security probe doesn't need long
// model rationale.
const DEFAULT_NUM_PREDICT = 400;

function classifyFetchError(err) {
  const cause = err && err.cause;
  const causeCode = cause && cause.code;
  if (err && err.name === 'AbortError') {
    return { code: 'timeout', message: 'Ollama generate aborted by timeout' };
  }
  if (causeCode === 'ECONNREFUSED') {
    return {
      code: 'connection_refused',
      message: 'Ollama is not reachable (connection refused)'
    };
  }
  return {
    code: 'network_error',
    message: (err && err.message) || 'Unknown network error'
  };
}

function normaliseResponse(raw) {
  return {
    text: (raw && raw.response) || '',
    model: raw && raw.model,
    createdAt: raw && raw.created_at,
    done: !!(raw && raw.done),
    totalDurationNs: (raw && raw.total_duration) || 0,
    evalCount: (raw && raw.eval_count) || 0,
    evalDurationNs: (raw && raw.eval_duration) || 0
  };
}

/**
 * @param {object} options
 * @param {string} options.model            - required
 * @param {string} options.prompt           - required
 * @param {string} [options.systemPrompt]
 * @param {object} [options.options]        - Ollama model options (temperature, num_predict, etc.)
 * @param {string} [options.baseUrl='http://127.0.0.1:11434']
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {number} [options.timeoutMs=300000]
 */
async function generate(options = {}) {
  const {
    model,
    prompt,
    systemPrompt,
    options: modelOptions,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  if (!model) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'model is required' }
    };
  }
  if (!prompt) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'prompt is required' }
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: {
        code: 'no_fetch',
        message: 'No fetch implementation available; pass fetchImpl explicitly'
      }
    };
  }

  const body = {
    model,
    prompt,
    stream: false,
    // Default response cap; user-supplied options spread over the default,
    // so a caller can override `num_predict` (or any other option) explicitly.
    options: { num_predict: DEFAULT_NUM_PREDICT, ...(modelOptions || {}) }
  };
  if (systemPrompt) body.system = systemPrompt;

  const url = `${baseUrl}/api/generate`;
  const controller = new AbortController();
  const timeoutHandle =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return { ok: false, error: classifyFetchError(err) };
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (response.status === 404) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        status: 404,
        message: 'Ollama /api/generate returned 404 — wrong base URL or model unknown?'
      }
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'unexpected_status',
        status: response.status,
        message: `Ollama /api/generate returned unexpected status ${response.status}`
      }
    };
  }

  let raw;
  try {
    raw = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_json',
        message: `Failed to parse JSON from /api/generate: ${(err && err.message) || err}`
      }
    };
  }

  return { ok: true, response: normaliseResponse(raw) };
}

function normaliseChatResponse(raw) {
  return {
    text: (raw && raw.message && raw.message.content) || '',
    role: (raw && raw.message && raw.message.role) || 'assistant',
    model: raw && raw.model,
    createdAt: raw && raw.created_at,
    done: !!(raw && raw.done),
    totalDurationNs: (raw && raw.total_duration) || 0,
    evalCount: (raw && raw.eval_count) || 0,
    evalDurationNs: (raw && raw.eval_duration) || 0
  };
}

/**
 * POST /api/chat — multi-turn variant that accepts a `messages` array of
 * { role: 'user'|'assistant'|'system', content: string } records. Used by
 * the multi-turn-pressure runner (PR-A31) to keep conversation state across
 * follow-up turns.
 *
 * Same discriminated-union return shape as generate().
 */
async function chat(options = {}) {
  const {
    model,
    messages,
    options: modelOptions,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  if (!model) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'model is required' }
    };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'messages (non-empty array) is required' }
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: {
        code: 'no_fetch',
        message: 'No fetch implementation available; pass fetchImpl explicitly'
      }
    };
  }

  const body = {
    model,
    messages,
    stream: false,
    options: { num_predict: DEFAULT_NUM_PREDICT, ...(modelOptions || {}) }
  };

  const url = `${baseUrl}/api/chat`;
  const controller = new AbortController();
  const timeoutHandle =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return { ok: false, error: classifyFetchError(err) };
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (response.status === 404) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        status: 404,
        message: 'Ollama /api/chat returned 404 — wrong base URL or model unknown?'
      }
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'unexpected_status',
        status: response.status,
        message: `Ollama /api/chat returned unexpected status ${response.status}`
      }
    };
  }

  let raw;
  try {
    raw = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_json',
        message: `Failed to parse JSON from /api/chat: ${(err && err.message) || err}`
      }
    };
  }

  return { ok: true, response: normaliseChatResponse(raw) };
}

module.exports = {
  generate,
  chat,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_NUM_PREDICT,
  // exported for tests
  normaliseResponse,
  normaliseChatResponse,
  classifyFetchError
};
