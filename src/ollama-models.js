'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ollama-models — list installed local Ollama models via /api/tags.
//
// Pure function with injected fetchImpl + baseUrl for testability. Returns a
// uniform { ok, models } | { ok: false, error: { code, ... } } shape so
// callers don't have to try/catch.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/**
 * Normalise a raw /api/tags model entry to the shape downstream code expects.
 * Defensive against missing `details` block.
 */
function normaliseModel(raw) {
  const details = (raw && raw.details) || {};
  return {
    name: raw && raw.name,
    sizeBytes: raw && raw.size,
    modifiedAt: raw && raw.modified_at,
    parameterSize: details.parameter_size,
    quantization: details.quantization_level
  };
}

/**
 * Map a thrown fetch error to an error code. Node 22+ wraps the underlying
 * cause in `err.cause.code` (ECONNREFUSED, ENOTFOUND, etc.).
 */
function classifyFetchError(err) {
  const cause = err && err.cause;
  const causeCode = cause && cause.code;
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

/**
 * List installed Ollama models.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl='http://127.0.0.1:11434']
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @returns {Promise<
 *   | { ok: true, models: Array<{name,sizeBytes,modifiedAt,parameterSize,quantization}> }
 *   | { ok: false, error: { code: string, status?: number, message: string } }
 * >}
 */
async function listInstalledModels(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: {
        code: 'no_fetch',
        message: 'No fetch implementation available; pass fetchImpl explicitly'
      }
    };
  }

  const url = `${baseUrl}/api/tags`;

  let response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    return { ok: false, error: classifyFetchError(err) };
  }

  if (response.status === 404) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        status: 404,
        message: 'Ollama /api/tags returned 404 — wrong base URL?'
      }
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'unexpected_status',
        status: response.status,
        message: `Ollama /api/tags returned unexpected status ${response.status}`
      }
    };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_json',
        message: `Failed to parse JSON from /api/tags: ${(err && err.message) || err}`
      }
    };
  }

  const rawModels = body && Array.isArray(body.models) ? body.models : [];
  const models = rawModels.map(normaliseModel);

  return { ok: true, models };
}

module.exports = {
  listInstalledModels,
  DEFAULT_BASE_URL,
  // exported for unit-test reuse
  normaliseModel,
  classifyFetchError
};
