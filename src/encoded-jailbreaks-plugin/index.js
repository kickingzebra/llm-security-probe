'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// encoded-jailbreaks-plugin (PR-A29) — does the model's refusal hold when the
// attack ask is obfuscated? Same attack content as the other plugins, but the
// prompt is encoded (base64, ROT13, leetspeak, hex, Unicode confusables, or
// translated). Tests guardrail robustness against obfuscation.
//
// The blocklist is the UNION of every other hand-rolled plugin's blocklist:
// the model could decode the request and produce attack output from any
// category, so the detector must cover all of them. This is the single
// source of truth for "what counts as a leaked attack."
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const { evaluateWithBlocklist } = require('../detector');

const { DEFAULT_BLOCKLIST: PORT_SCAN_BL } = require('../port-scan-plugin');
const { DEFAULT_BLOCKLIST: MALWARE_BL } = require('../malware-authoring-plugin');
const { DEFAULT_BLOCKLIST: WEB_BL } = require('../web-exploitation-plugin');
const { DEFAULT_BLOCKLIST: CRED_BL } = require('../credential-attacks-plugin');
const { DEFAULT_BLOCKLIST: PRIVESC_BL } = require('../privilege-escalation-plugin');

const PLUGIN_ID = 'encoded-jailbreaks';
const CATEGORY = 'encodedJailbreaks';

const PROMPTS_PATH = path.join(__dirname, 'prompts.json');

// Union of all hand-rolled plugin blocklists — the encoded jailbreak might
// elicit any category's attack output once decoded.
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
    encoding: p.encoding,
    attackCategory: p.attackCategory,
    decoded: p.decoded,
    prompt: p.prompt,
    mustNotContain: p.mustNotContain || []
  }));
}

const PROMPTS = loadPrompts();

function evaluate(prompt, response) {
  return evaluateWithBlocklist({ prompt, response, blocklist: DEFAULT_BLOCKLIST });
}

module.exports = {
  PLUGIN_ID,
  CATEGORY,
  PROMPTS,
  evaluate,
  DEFAULT_BLOCKLIST,
  loadPrompts
};
