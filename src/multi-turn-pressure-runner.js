'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// multi-turn-pressure-runner — walks each scenario's turn list against
// /api/chat, keeping the messages array growing with each model reply.
// Scores the FINAL assistant message against the union blocklist.
//
// Per-test entry includes a `transcript` field with every turn so the
// dashboard can render the whole conversation, not just the final reply.
// ─────────────────────────────────────────────────────────────────────────────

const ollamaClient = require('./ollama-client');
const plugin = require('./multi-turn-pressure-plugin');

const { chat: defaultChat } = ollamaClient;
const { PROMPTS, evaluate, PLUGIN_ID, CATEGORY } = plugin;

async function runMultiTurnPressureSuite(options = {}) {
  const {
    model,
    baseUrl,
    fetchImpl,
    chatImpl = defaultChat,
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
    const messages = [];
    const transcript = [];
    let finalReplyText = '';
    let chatError = null;

    for (let i = 0; i < prompt.turns.length; i++) {
      const userTurn = prompt.turns[i];
      messages.push({ role: 'user', content: userTurn });
      transcript.push({ role: 'user', content: userTurn });

      const result = await chatImpl({
        model,
        messages,
        baseUrl,
        fetchImpl,
        timeoutMs
      });

      if (!result.ok) {
        chatError = result.error;
        break;
      }

      const assistantText = (result.response && result.response.text) || '';
      messages.push({ role: 'assistant', content: assistantText });
      transcript.push({ role: 'assistant', content: assistantText });
      finalReplyText = assistantText;
    }

    const durationMs = Date.now() - tStart;

    if (chatError) {
      entry = {
        id: prompt.id,
        category: CATEGORY,
        pluginId: PLUGIN_ID,
        status: 'fail',
        prompt: prompt.prompt,
        replyText: finalReplyText,
        reason: `chat_error_${chatError.code || 'unknown'}: ${chatError.message || ''}`,
        durationMs,
        framing: prompt.framing,
        attackCategory: prompt.attackCategory,
        transcript
      };
    } else {
      const verdict = evaluate(prompt, finalReplyText);
      entry = {
        id: prompt.id,
        category: CATEGORY,
        pluginId: PLUGIN_ID,
        status: verdict.pass ? 'pass' : 'fail',
        prompt: prompt.prompt,
        replyText: finalReplyText,
        reason: verdict.reason,
        durationMs,
        framing: prompt.framing,
        attackCategory: prompt.attackCategory,
        transcript
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
  runMultiTurnPressureSuite
};
