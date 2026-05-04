'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// port-scan-runner — orchestrate the port-scan plugin against a live model.
//
// For each prompt in the catalogue:
//   1. POST to Ollama /api/generate via ollama-client
//   2. Run the plugin's evaluate() against the response text
//   3. Emit a dashboard-shaped test entry
//
// Output shape matches the `tests[]` array in the dashboard runs format,
// so the CLI (PR-A8) can concat these with promptfoo-derived tests and
// pass everything through normaliser.buildSummary() for aggregation.
// ─────────────────────────────────────────────────────────────────────────────

const ollamaClient = require('./ollama-client');
const portScanPlugin = require('./port-scan-plugin');

const { generate: defaultGenerate } = ollamaClient;
const { PROMPTS, evaluate, PLUGIN_ID, CATEGORY } = portScanPlugin;

/**
 * Run the port-scan suite against `model`.
 *
 * @param {object} options
 * @param {string} options.model            - required, e.g. 'gemma3:12b'
 * @param {string} [options.baseUrl]
 * @param {Function} [options.fetchImpl]    - passed to default generateImpl
 * @param {Function} [options.generateImpl] - injected for tests; default = ollama-client.generate
 * @param {number} [options.timeoutMs]      - per-prompt
 * @returns {Promise<
 *   | { ok: true, tests: Array<TestEntry>, stats: { total, passed, failed } }
 *   | { ok: false, error: { code, message } }
 * >}
 */
async function runPortScanSuite(options = {}) {
  const {
    model,
    baseUrl,
    fetchImpl,
    generateImpl = defaultGenerate,
    timeoutMs
  } = options;

  if (!model) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'model is required' }
    };
  }

  const tests = [];
  let passed = 0;
  let failed = 0;

  for (const prompt of PROMPTS) {
    const tStart = Date.now();
    let entry;

    const generateResult = await generateImpl({
      model,
      prompt: prompt.prompt,
      baseUrl,
      fetchImpl,
      timeoutMs
    });

    const durationMs = Date.now() - tStart;

    if (!generateResult.ok) {
      const code = (generateResult.error && generateResult.error.code) || 'unknown';
      const message = (generateResult.error && generateResult.error.message) || 'generate failed';
      entry = {
        id: prompt.id,
        category: CATEGORY,
        pluginId: PLUGIN_ID,
        status: 'fail',
        prompt: prompt.prompt,
        replyText: '',
        reason: `generate_error_${code}: ${message}`,
        durationMs
      };
    } else {
      const replyText = generateResult.response.text || '';
      const verdict = evaluate(prompt, replyText);
      entry = {
        id: prompt.id,
        category: CATEGORY,
        pluginId: PLUGIN_ID,
        status: verdict.pass ? 'pass' : 'fail',
        prompt: prompt.prompt,
        replyText,
        reason: verdict.reason,
        durationMs
      };
    }

    if (entry.status === 'pass') passed += 1;
    else failed += 1;

    tests.push(entry);
  }

  return {
    ok: true,
    tests,
    stats: {
      total: tests.length,
      passed,
      failed
    }
  };
}

module.exports = {
  runPortScanSuite
};
