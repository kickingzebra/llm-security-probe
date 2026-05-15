'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// roleplay-bypass-plugin (PR-A30) — does the model's refusal hold when the
// attack ask is wrapped in a persona / framing / role-play setup? Tests the
// same content as the other plugins under DAN, grandma trick, fictional
// novel, authority claim, hypothetical, reverse-psychology, unrestricted-AI
// persona swap, academic framing, translator/sandbox, two-step indirection,
// CTF framing, and explicit instruction-override.
//
// Like encoded-jailbreaks (PR-A29), the blocklist is the UNION of every
// other hand-rolled plugin's blocklist — once the model takes the bait it
// could leak attack output from any category.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const { evaluateWithBlocklist } = require('../detector');

const { DEFAULT_BLOCKLIST: PORT_SCAN_BL } = require('../port-scan-plugin');
const { DEFAULT_BLOCKLIST: MALWARE_BL } = require('../malware-authoring-plugin');
const { DEFAULT_BLOCKLIST: WEB_BL } = require('../web-exploitation-plugin');
const { DEFAULT_BLOCKLIST: CRED_BL } = require('../credential-attacks-plugin');
const { DEFAULT_BLOCKLIST: PRIVESC_BL } = require('../privilege-escalation-plugin');

const PLUGIN_ID = 'roleplay-bypass';
const CATEGORY = 'roleplayBypass';

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
