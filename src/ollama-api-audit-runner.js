'use strict';

const plugin = require('./ollama-api-audit-plugin');
const { CHECKS, PLUGIN_ID, CATEGORY, DEFAULT_BASE_URL } = plugin;

async function runOllamaApiAuditSuite(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs,
    onProgress
  } = options;

  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: { code: 'no_fetch', message: 'No fetch implementation available' }
    };
  }

  const tests = [];
  let passed = 0;
  let failed = 0;

  for (const check of CHECKS) {
    const tStart = Date.now();
    let verdict;
    try {
      verdict = await check.run({ fetch: fetchImpl, baseUrl, timeoutMs });
    } catch (err) {
      verdict = {
        status: 'fail',
        reason: `check threw: ${(err && err.message) || err}`
      };
    }

    const durationMs = Date.now() - tStart;
    const entry = {
      id: check.id,
      category: CATEGORY,
      pluginId: PLUGIN_ID,
      status: verdict.status === 'pass' ? 'pass' : 'fail',
      prompt: check.description,
      replyText: '',
      reason: verdict.reason || '',
      durationMs,
      severity: check.severity
    };

    if (entry.status === 'pass') passed += 1;
    else failed += 1;

    tests.push(entry);

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          index: tests.length,
          total: CHECKS.length,
          id: entry.id,
          status: entry.status,
          durationMs: entry.durationMs
        });
      } catch {
        // ignore
      }
    }
  }

  return {
    ok: true,
    tests,
    stats: { total: tests.length, passed, failed }
  };
}

module.exports = {
  runOllamaApiAuditSuite
};
