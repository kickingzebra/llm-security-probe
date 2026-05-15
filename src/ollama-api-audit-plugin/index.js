'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ollama-api-audit-plugin (PR-A33) — probes the Ollama HTTP API for
// deployment-posture issues. Unlike every other plugin in this repo, the
// probe target is the *server*, not the model. Each "check" returns a test
// entry in the standard dashboard shape so the existing index / live / log
// views work unchanged.
//
// Categories of check:
//   - Anonymous access  — can a stranger hit /api/tags, /api/generate,
//                         /api/show without auth?
//   - Info disclosure   — does /api/tags fingerprint installed models?
//                         does /api/show leak Modelfile / system prompt?
//                         does /api/ps surface running-process details?
//   - Resource posture  — does the server cap absurd num_predict values?
//                         does it reject obviously-too-large payloads?
//
// A "PASS" means the server is configured securely on that axis; a "FAIL"
// flags an issue. Severity is recorded in the reason for triage.
// ─────────────────────────────────────────────────────────────────────────────

const PLUGIN_ID = 'ollama-api-audit';
const CATEGORY = 'apiAudit';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

async function safeFetchJson(fetchImpl, url, init = {}) {
  try {
    const res = await fetchImpl(url, init);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: true, status: res.status, headers: res.headers, body };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks. Each takes ({ fetch, baseUrl }) and returns
// { status: 'pass'|'fail', reason: string }.
// ─────────────────────────────────────────────────────────────────────────────

const CHECKS = [
  {
    id: 'anonymous-tags-access',
    severity: 'high',
    description: 'Anonymous GET /api/tags returns the installed-model inventory without auth.',
    run: async ({ fetch, baseUrl }) => {
      const r = await safeFetchJson(fetch, `${baseUrl}/api/tags`);
      if (!r.ok) {
        return { status: 'pass', reason: `network error (treated as not exposed): ${(r.error && r.error.message) || r.error}` };
      }
      if (r.status === 401 || r.status === 403) {
        return { status: 'pass', reason: `auth required (HTTP ${r.status}) — good` };
      }
      if (r.status === 200 && r.body && Array.isArray(r.body.models)) {
        return { status: 'fail', reason: `[severity=high] anonymous /api/tags returned ${r.body.models.length} models — installed-model inventory is publicly enumerable` };
      }
      return { status: 'fail', reason: `[severity=medium] /api/tags returned HTTP ${r.status} but body was unexpected` };
    }
  },
  {
    id: 'anonymous-generate-access',
    severity: 'high',
    description: 'Anonymous POST /api/generate accepts work without auth (compute abuse + jailbreak target).',
    run: async ({ fetch, baseUrl }) => {
      const tags = await safeFetchJson(fetch, `${baseUrl}/api/tags`);
      if (!tags.ok || !tags.body || !Array.isArray(tags.body.models) || tags.body.models.length === 0) {
        return { status: 'pass', reason: 'no model available to probe /api/generate — not exposed' };
      }
      const model = tags.body.models[0].name;
      const r = await safeFetchJson(fetch, `${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'hi', stream: false, options: { num_predict: 1 } })
      });
      if (!r.ok) {
        return { status: 'pass', reason: `network error: ${(r.error && r.error.message) || r.error}` };
      }
      if (r.status === 401 || r.status === 403) {
        return { status: 'pass', reason: `auth required on /api/generate (HTTP ${r.status})` };
      }
      if (r.status === 200) {
        return { status: 'fail', reason: '[severity=high] anonymous /api/generate accepted a request — anyone with network reach can consume model compute and run jailbreak probes' };
      }
      return { status: 'fail', reason: `[severity=medium] /api/generate returned HTTP ${r.status} — unexpected, audit manually` };
    }
  },
  {
    id: 'anonymous-show-access',
    severity: 'medium',
    description: 'Anonymous POST /api/show leaks Modelfile, parameters, system prompt for an installed model.',
    run: async ({ fetch, baseUrl }) => {
      const tags = await safeFetchJson(fetch, `${baseUrl}/api/tags`);
      if (!tags.ok || !tags.body || !Array.isArray(tags.body.models) || tags.body.models.length === 0) {
        return { status: 'pass', reason: 'no model available to probe /api/show' };
      }
      const model = tags.body.models[0].name;
      const r = await safeFetchJson(fetch, `${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model })
      });
      if (!r.ok) {
        return { status: 'pass', reason: `network error: ${(r.error && r.error.message) || r.error}` };
      }
      if (r.status === 401 || r.status === 403) {
        return { status: 'pass', reason: `auth required on /api/show (HTTP ${r.status})` };
      }
      if (r.status === 200 && r.body) {
        const fields = Object.keys(r.body).join(', ');
        return { status: 'fail', reason: `[severity=medium] anonymous /api/show returned: ${fields} — system prompt / Modelfile / parameters are publicly readable` };
      }
      return { status: 'fail', reason: `[severity=low] /api/show returned HTTP ${r.status} — unexpected` };
    }
  },
  {
    id: 'system-prompt-leak-via-show',
    severity: 'medium',
    description: '/api/show response carries a non-empty `system` or `template` field — system-prompt leakage.',
    run: async ({ fetch, baseUrl }) => {
      const tags = await safeFetchJson(fetch, `${baseUrl}/api/tags`);
      if (!tags.ok || !tags.body || !Array.isArray(tags.body.models) || tags.body.models.length === 0) {
        return { status: 'pass', reason: 'no model available' };
      }
      const model = tags.body.models[0].name;
      const r = await safeFetchJson(fetch, `${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model })
      });
      if (!r.ok || r.status !== 200 || !r.body) {
        return { status: 'pass', reason: 'show endpoint not exposing a readable body' };
      }
      const leaked = [];
      if (r.body.system && String(r.body.system).trim().length > 0) leaked.push('system');
      if (r.body.template && String(r.body.template).trim().length > 0) leaked.push('template');
      if (r.body.modelfile && String(r.body.modelfile).trim().length > 0) leaked.push('modelfile');
      if (leaked.length === 0) {
        return { status: 'pass', reason: 'no system prompt / template / Modelfile content surfaced' };
      }
      return { status: 'fail', reason: `[severity=medium] /api/show leaks fields: ${leaked.join(', ')} for model ${model}` };
    }
  },
  {
    id: 'running-models-leak',
    severity: 'low',
    description: 'Anonymous GET /api/ps exposes the list of running models + RAM usage.',
    run: async ({ fetch, baseUrl }) => {
      const r = await safeFetchJson(fetch, `${baseUrl}/api/ps`);
      if (!r.ok) {
        return { status: 'pass', reason: `network error: ${(r.error && r.error.message) || r.error}` };
      }
      if (r.status === 404) {
        return { status: 'pass', reason: '/api/ps not present on this server build' };
      }
      if (r.status === 401 || r.status === 403) {
        return { status: 'pass', reason: `auth required (HTTP ${r.status})` };
      }
      if (r.status === 200 && r.body && Array.isArray(r.body.models)) {
        return { status: 'fail', reason: `[severity=low] anonymous /api/ps returned ${r.body.models.length} running model(s) — surfaces operational state` };
      }
      return { status: 'pass', reason: `/api/ps returned HTTP ${r.status} with no model array` };
    }
  },
  {
    id: 'version-endpoint-leak',
    severity: 'low',
    description: 'GET /api/version returns the exact Ollama version — useful for CVE-targeted attacks.',
    run: async ({ fetch, baseUrl }) => {
      const r = await safeFetchJson(fetch, `${baseUrl}/api/version`);
      if (!r.ok) {
        return { status: 'pass', reason: 'no /api/version endpoint reachable' };
      }
      if (r.status === 404) {
        return { status: 'pass', reason: '/api/version not present' };
      }
      if (r.status === 200 && r.body && r.body.version) {
        return { status: 'fail', reason: `[severity=low] anonymous /api/version returned: ${r.body.version} — exact version is publicly fingerprintable` };
      }
      return { status: 'pass', reason: `/api/version returned HTTP ${r.status} with no version field` };
    }
  },
  {
    id: 'model-inventory-fingerprint',
    severity: 'low',
    description: 'GET /api/tags reveals BOTH model name AND full metadata (parameter size, quantization, modified-at) — full hardware-class fingerprint.',
    run: async ({ fetch, baseUrl }) => {
      const r = await safeFetchJson(fetch, `${baseUrl}/api/tags`);
      if (!r.ok || r.status !== 200 || !r.body || !Array.isArray(r.body.models) || r.body.models.length === 0) {
        return { status: 'pass', reason: 'no enumerable model list' };
      }
      const first = r.body.models[0];
      const detail = first.details || {};
      const fingerprinted = [];
      if (detail.parameter_size) fingerprinted.push('parameter_size');
      if (detail.quantization_level) fingerprinted.push('quantization');
      if (first.modified_at) fingerprinted.push('modified_at');
      if (first.size) fingerprinted.push('disk_size');
      if (fingerprinted.length >= 3) {
        return { status: 'fail', reason: `[severity=low] /api/tags exposes ${fingerprinted.join(', ')} for every model — hardware-class fingerprinting + freshness signal` };
      }
      return { status: 'pass', reason: `/api/tags exposes ${fingerprinted.length} metadata fields per model — limited fingerprinting surface` };
    }
  },
  {
    id: 'unbounded-num-predict',
    severity: 'medium',
    description: 'POST /api/generate with num_predict=99999 is accepted with no server-side cap — DoS vector.',
    run: async ({ fetch, baseUrl, timeoutMs = 8000 }) => {
      const tags = await safeFetchJson(fetch, `${baseUrl}/api/tags`);
      if (!tags.ok || !tags.body || !Array.isArray(tags.body.models) || tags.body.models.length === 0) {
        return { status: 'pass', reason: 'no model available' };
      }
      const model = tags.body.models[0].name;
      // We send the request but abort after `timeoutMs`. A server with a sane
      // cap would return quickly (because num_predict was clipped). A server
      // with no cap would still be generating when we abort.
      const ac = new AbortController();
      const tHandle = setTimeout(() => ac.abort(), timeoutMs);
      const start = Date.now();
      let res;
      try {
        res = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: 'a', stream: false, options: { num_predict: 99999 } }),
          signal: ac.signal
        });
      } catch (err) {
        clearTimeout(tHandle);
        if (err && err.name === 'AbortError') {
          return { status: 'fail', reason: `[severity=medium] /api/generate still generating after ${timeoutMs}ms with num_predict=99999 — no server-side cap visible` };
        }
        return { status: 'pass', reason: `network error during DoS probe: ${err && err.message}` };
      }
      clearTimeout(tHandle);
      const elapsed = Date.now() - start;
      if (res && res.status === 200) {
        // Server returned within timeout — likely capped. PASS.
        return { status: 'pass', reason: `/api/generate completed in ${elapsed}ms — implies a server-side num_predict cap` };
      }
      return { status: 'pass', reason: `/api/generate returned HTTP ${res ? res.status : '?'} in ${elapsed}ms` };
    }
  },
  {
    id: 'cors-permissive',
    severity: 'medium',
    description: 'Access-Control-Allow-Origin: * lets browsers from any origin call /api/generate from the user\'s browser context.',
    run: async ({ fetch, baseUrl }) => {
      try {
        const res = await fetch(`${baseUrl}/api/tags`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://example.invalid' }
        });
        const acao = res.headers && res.headers.get && res.headers.get('access-control-allow-origin');
        if (!acao) {
          return { status: 'pass', reason: 'no Access-Control-Allow-Origin header returned' };
        }
        if (acao === '*' || acao === 'https://example.invalid') {
          return { status: 'fail', reason: `[severity=medium] Access-Control-Allow-Origin: "${acao}" — browser-side cross-origin abuse is possible` };
        }
        return { status: 'pass', reason: `Access-Control-Allow-Origin: "${acao}" — restricted` };
      } catch (err) {
        return { status: 'pass', reason: `OPTIONS probe failed: ${err && err.message}` };
      }
    }
  },
  {
    id: 'unauthenticated-pull-allowed',
    severity: 'medium',
    description: 'POST /api/pull lets anonymous callers fetch new models — disk-fill + supply-chain risk.',
    run: async ({ fetch, baseUrl }) => {
      // Don't actually pull a model; just probe whether the endpoint is open.
      // Use an obviously-invalid model name so the server fails fast, but if
      // it returns 401/403 instead of a model-not-found error, that's the
      // auth posture we want to detect.
      const r = await safeFetchJson(fetch, `${baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'never-exists-12345abcdef:tag', stream: false })
      });
      if (!r.ok) {
        return { status: 'pass', reason: `network error: ${(r.error && r.error.message) || r.error}` };
      }
      if (r.status === 401 || r.status === 403) {
        return { status: 'pass', reason: `/api/pull requires auth (HTTP ${r.status})` };
      }
      // Anonymous pull is reachable — it'll error on the fake name but the
      // endpoint is open to unauthenticated callers.
      return { status: 'fail', reason: `[severity=medium] anonymous /api/pull reachable (HTTP ${r.status}) — anyone with network access can trigger model downloads and fill disk` };
    }
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// "Prompts" view for dashboard / about-page compatibility. Each check is
// surfaced as a prompt-like record so the catalogue is introspectable.
// ─────────────────────────────────────────────────────────────────────────────

const PROMPTS = CHECKS.map((c) => ({
  id: c.id,
  category: CATEGORY,
  severity: c.severity,
  description: c.description,
  // dashboard expects a `prompt` string for per-test rendering
  prompt: c.description,
  mustNotContain: []
}));

module.exports = {
  PLUGIN_ID,
  CATEGORY,
  PROMPTS,
  CHECKS,
  DEFAULT_BASE_URL
};
