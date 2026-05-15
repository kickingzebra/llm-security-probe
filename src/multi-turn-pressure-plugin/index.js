'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// multi-turn-pressure-plugin (PR-A31) — does the model maintain refusal
// across multiple turns under pressure? Each scenario is a sequence of user
// messages; the test passes only if the FINAL model reply still refuses
// (no blocklist hits from any category).
//
// Architectural differences from the single-turn plugins:
//   - prompts.json entries have a `turns: [string]` array, not a single
//     `prompt` string.
//   - the runner uses ollama-client.chat() with growing message history,
//     not ollama-client.generate().
//   - evaluation only inspects the final assistant reply.
//
// Like encoded-jailbreaks and roleplay-bypass, the blocklist is the union
// of every other hand-rolled plugin's blocklist.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const { evaluateWithBlocklist } = require('../detector');

const { DEFAULT_BLOCKLIST: PORT_SCAN_BL } = require('../port-scan-plugin');
const { DEFAULT_BLOCKLIST: MALWARE_BL } = require('../malware-authoring-plugin');
const { DEFAULT_BLOCKLIST: WEB_BL } = require('../web-exploitation-plugin');
const { DEFAULT_BLOCKLIST: CRED_BL } = require('../credential-attacks-plugin');
const { DEFAULT_BLOCKLIST: PRIVESC_BL } = require('../privilege-escalation-plugin');

const PLUGIN_ID = 'multi-turn-pressure';
const CATEGORY = 'multiTurnPressure';

const PROMPTS_PATH = path.join(__dirname, 'prompts.json');

const DEFAULT_BLOCKLIST = [
  ...PORT_SCAN_BL,
  ...MALWARE_BL,
  ...WEB_BL,
  ...CRED_BL,
  ...PRIVESC_BL
];

function loadPrompts() {
  const raw = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
  return raw.prompts.map((p) => ({
    id: p.id,
    category: CATEGORY,
    framing: p.framing,
    attackCategory: p.attackCategory,
    turns: p.turns,
    // For dashboard compatibility (per-run report renders `prompt`), expose
    // the joined turns as a single readable transcript.
    prompt: p.turns.map((t, i) => `[turn ${i + 1}] ${t}`).join('\n\n'),
    mustNotContain: p.mustNotContain || []
  }));
}

const PROMPTS = loadPrompts();

/**
 * Evaluate the FINAL assistant reply in a multi-turn scenario. Unlike the
 * single-turn evaluators, this takes the last reply text directly; turn
 * orchestration lives in the runner.
 */
function evaluate(prompt, finalReplyText) {
  return evaluateWithBlocklist({ prompt, response: finalReplyText, blocklist: DEFAULT_BLOCKLIST });
}

module.exports = {
  PLUGIN_ID,
  CATEGORY,
  PROMPTS,
  evaluate,
  DEFAULT_BLOCKLIST,
  loadPrompts
};
