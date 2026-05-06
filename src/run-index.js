'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// run-index — read every run JSON in outputDir, sort by startedAt desc, and
// emit `index.html` linking to each run's per-run dashboard.
//
// Pure-ish: filesystem ops are real but isolated. Malformed JSON files are
// logged into result.skipped and don't abort the whole regenerate.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs/promises');
const path = require('node:path');

const { renderIndex } = require('./report-renderer');

const INDEX_FILENAME = 'index.html';

async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Scan outputDir for run JSON files (matching `run_*.json`), parse each,
 * sort by startedAt descending, render the aggregate index, write to disk.
 *
 * @param {object} options
 * @param {string} options.outputDir
 * @returns {Promise<{
 *   ok: true,
 *   indexPath: string,
 *   runCount: number,
 *   skipped: string[]
 * }>}
 */
async function regenerateIndex({ outputDir }) {
  if (!outputDir) {
    throw new TypeError('regenerateIndex: outputDir is required');
  }

  // Ensure directory exists (idempotent)
  await fs.mkdir(outputDir, { recursive: true });

  let entries;
  try {
    entries = await fs.readdir(outputDir);
  } catch (err) {
    entries = [];
  }

  const candidateFiles = entries.filter(
    (f) => f.startsWith('run_') && f.endsWith('.json')
  );

  const runs = [];
  const skipped = [];
  for (const file of candidateFiles) {
    const full = path.join(outputDir, file);
    const result = await safeReadJson(full);
    if (!result.ok) {
      skipped.push(`${file}: ${result.error.message || result.error.code || 'parse error'}`);
      continue;
    }
    const value = result.value;
    if (!value || !value.runId || !value.startedAt) {
      skipped.push(`${file}: missing runId/startedAt`);
      continue;
    }
    runs.push(value);
  }

  // Most recent first by startedAt — fall back to runId for ties
  runs.sort((a, b) => {
    const ta = String(a.startedAt);
    const tb = String(b.startedAt);
    if (ta !== tb) return tb.localeCompare(ta);
    return String(b.runId).localeCompare(String(a.runId));
  });

  const html = renderIndex(runs);
  const indexPath = path.join(outputDir, INDEX_FILENAME);
  await fs.writeFile(indexPath, html, 'utf8');

  return {
    ok: true,
    indexPath,
    runCount: runs.length,
    skipped
  };
}

module.exports = {
  regenerateIndex,
  INDEX_FILENAME
};
