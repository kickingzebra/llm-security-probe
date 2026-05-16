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
const { renderLivePage } = require('./live-page');
const { renderLogPage } = require('./log-page');
const { renderAboutPage } = require('./about-page');
const { buildSummary } = require('./normaliser');

const INDEX_FILENAME = 'index.html';
const LIVE_FILENAME = 'live.html';
const LOG_FILENAME = 'log.html';
const ABOUT_FILENAME = 'about.html';

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
    // PR-A36: re-derive summary from tests[] on every regen so the matrix
    // reflects current detector semantics (e.g., the timeout-aware errored
    // count) across historical runs without rewriting saved JSON files.
    if (Array.isArray(value.tests) && value.tests.length > 0) {
      value.summary = buildSummary(value.tests);
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

  // Also write the live-dashboard page. Same content regardless of run state
  // (it's a polling SPA-lite); we write it alongside index.html so it's
  // always present in any directory that contains run results.
  const livePath = path.join(outputDir, LIVE_FILENAME);
  await fs.writeFile(livePath, renderLivePage(), 'utf8');

  // Probe log: chronological per-prompt view across all runs. Reads from the
  // same `runs` array — no separate aggregate store, no duplication.
  const logPath = path.join(outputDir, LOG_FILENAME);
  await fs.writeFile(logPath, renderLogPage(runs), 'utf8');

  // About page: describes the project mission, active categories, and
  // pass/fail criteria. Static apart from the live category snapshot.
  const aboutPath = path.join(outputDir, ABOUT_FILENAME);
  await fs.writeFile(aboutPath, renderAboutPage(), 'utf8');

  return {
    ok: true,
    indexPath,
    livePath,
    logPath,
    aboutPath,
    runCount: runs.length,
    skipped
  };
}

module.exports = {
  regenerateIndex,
  INDEX_FILENAME,
  LIVE_FILENAME,
  LOG_FILENAME,
  ABOUT_FILENAME
};
