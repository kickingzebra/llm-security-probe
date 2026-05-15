'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// normaliser — turn promptfoo's outputs.json into the dashboard's runs/<ts>.json
// shape. Pure function; injected runId + startedAt + endedAt so tests are
// deterministic.
//
// promptfoo's output schema is large and evolving; we extract only the fields
// we actually use and treat everything else as noise. The golden-file test
// pins the contract.
// ─────────────────────────────────────────────────────────────────────────────

// Plugin id (from promptfoo) → security category (our taxonomy).
// Five v1 categories from the plan: ssrf, portScan, tokenLeak, networkExploit,
// promptInjection. Custom port-scan plugin (PR-A5) maps to portScan.
const PLUGIN_CATEGORY_MAP = Object.freeze({
  'ssrf': 'ssrf',
  'shell-injection': 'networkExploit',
  'prompt-extraction': 'tokenLeak',
  'indirect-prompt-injection': 'promptInjection',
  'coding-agent:secret-env-read': 'tokenLeak',
  'coding-agent:secret-file-read': 'tokenLeak',
  'port-scan': 'portScan',
  'malware-authoring': 'malwareAuthoring',
  'web-exploitation': 'webExploitation',
  'credential-attacks': 'credentialAttacks',
  'privilege-escalation': 'privilegeEscalation',
  'encoded-jailbreaks': 'encodedJailbreaks',
  'roleplay-bypass': 'roleplayBypass'
});

const PHASE = '1A-defensive-eval';

function pluginToCategory(pluginId) {
  if (!pluginId) return 'unknown';
  return PLUGIN_CATEGORY_MAP[pluginId] || 'unknown';
}

/**
 * Extract the result fields we keep, with defensive fallbacks.
 */
function extractResult(rawResult) {
  const meta = rawResult && rawResult.metadata;
  const grading = rawResult && rawResult.gradingResult;
  const response = rawResult && rawResult.response;
  const vars = rawResult && rawResult.vars;

  const pluginId = (meta && meta.pluginId) || null;
  const passed = !!(grading && grading.pass);

  return {
    pluginId,
    category: pluginToCategory(pluginId),
    passed,
    prompt: (vars && vars.prompt) || null,
    replyText: (response && response.output) || null,
    reason: (grading && grading.reason) || null,
    durationMs: (rawResult && rawResult.latencyMs) || 0
  };
}

/**
 * Build the per-test array with deterministic ids: <pluginId>-<n>, where n
 * starts at 1 and increments per plugin in order of appearance.
 */
function buildTests(rawResults) {
  const counters = new Map();
  return rawResults.map((raw) => {
    const extracted = extractResult(raw);
    const idKey = extracted.pluginId || 'unknown';
    const next = (counters.get(idKey) || 0) + 1;
    counters.set(idKey, next);

    return {
      id: `${idKey}-${next}`,
      category: extracted.category,
      pluginId: extracted.pluginId,
      status: extracted.passed ? 'pass' : 'fail',
      prompt: extracted.prompt,
      replyText: extracted.replyText,
      reason: extracted.reason,
      durationMs: extracted.durationMs
    };
  });
}

/**
 * Aggregate per-category pass/fail counts and refusal rate.
 */
function buildSummary(tests) {
  const total = tests.length;
  let passed = 0;
  const byCategory = {};

  for (const t of tests) {
    if (t.status === 'pass') passed += 1;
    if (!byCategory[t.category]) {
      byCategory[t.category] = { total: 0, passed: 0, failed: 0, refusalRate: 0 };
    }
    const bucket = byCategory[t.category];
    bucket.total += 1;
    if (t.status === 'pass') bucket.passed += 1;
    else bucket.failed += 1;
  }

  // Compute refusalRate per category (passed / total) — guard against zero.
  for (const cat of Object.keys(byCategory)) {
    const b = byCategory[cat];
    b.refusalRate = b.total === 0 ? 0 : b.passed / b.total;
  }

  return {
    total,
    passed,
    failed: total - passed,
    refusalRate: total === 0 ? 0 : passed / total,
    byCategory
  };
}

/**
 * Normalise a promptfoo outputs.json into a dashboard run record.
 *
 * @param {object} options
 * @param {object} options.promptfooOutput - parsed promptfoo outputs.json
 * @param {string} options.model           - provider id, e.g. 'ollama:chat:gemma3:12b'
 * @param {string} options.runId           - injected for determinism
 * @param {string} options.startedAt       - ISO timestamp, injected
 * @param {string} options.endedAt         - ISO timestamp, injected
 * @returns {object} dashboard run record
 */
function normalise({ promptfooOutput, model, runId, startedAt, endedAt }) {
  const rawResults =
    promptfooOutput &&
    promptfooOutput.results &&
    Array.isArray(promptfooOutput.results.results)
      ? promptfooOutput.results.results
      : [];

  const tests = buildTests(rawResults);
  const summary = buildSummary(tests);

  const overallStatus = summary.failed > 0 ? 'fail' : 'pass';

  return {
    runId,
    model,
    phase: PHASE,
    startedAt,
    endedAt,
    overallStatus,
    summary,
    tests
  };
}

module.exports = {
  normalise,
  pluginToCategory,
  PLUGIN_CATEGORY_MAP,
  PHASE,
  // exported for unit-test reuse
  buildTests,
  buildSummary,
  extractResult
};
