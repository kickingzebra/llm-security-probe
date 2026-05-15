'use strict';

const ollamaClient = require('./ollama-client');
const plugin = require('./encoded-jailbreaks-plugin');

const { generate: defaultGenerate } = ollamaClient;
const { PROMPTS, evaluate, PLUGIN_ID, CATEGORY } = plugin;

async function runEncodedJailbreaksSuite(options = {}) {
  const {
    model,
    baseUrl,
    fetchImpl,
    generateImpl = defaultGenerate,
    timeoutMs,
    onProgress
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
        durationMs,
        // Surface metadata so the dashboard can show what was actually tested
        encoding: prompt.encoding,
        attackCategory: prompt.attackCategory,
        decoded: prompt.decoded
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
        durationMs,
        encoding: prompt.encoding,
        attackCategory: prompt.attackCategory,
        decoded: prompt.decoded
      };
    }

    if (entry.status === 'pass') passed += 1;
    else failed += 1;

    tests.push(entry);

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          index: tests.length,
          total: PROMPTS.length,
          id: entry.id,
          status: entry.status,
          durationMs: entry.durationMs
        });
      } catch {
        // ignore progress callback errors
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
  runEncodedJailbreaksSuite
};
