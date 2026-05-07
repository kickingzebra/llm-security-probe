'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// run-status — JSONL event log per run, written incrementally as the probe
// progresses. The file at `<outputDir>/<runId>.status.jsonl` is the live
// signal the dashboard polls to surface in-flight progress before the final
// JSON is written.
//
// Event shape is open; canonical types used by run-probe are:
//   { type: 'run_started',     model, ts }
//   { type: 'prompt_completed', index, total, id, status, durationMs, ts }
//   { type: 'run_completed',    overallStatus, ts }
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs/promises');
const path = require('node:path');

const STATUS_FILE_SUFFIX = '.status.jsonl';

function defaultIsoNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function statusPath(outputDir, runId) {
  return path.join(outputDir, `${runId}${STATUS_FILE_SUFFIX}`);
}

/**
 * Append one event to the run's status file. Idempotent on directory creation;
 * adds a `ts` field if the event doesn't already carry one.
 */
async function appendEvent({ outputDir, runId, event } = {}) {
  if (!outputDir) throw new TypeError('appendEvent: outputDir is required');
  if (!runId) throw new TypeError('appendEvent: runId is required');
  if (!event || typeof event !== 'object') {
    throw new TypeError('appendEvent: event must be an object');
  }

  const enriched = event.ts ? event : { ...event, ts: defaultIsoNow() };

  await fs.mkdir(outputDir, { recursive: true });
  const file = statusPath(outputDir, runId);
  await fs.appendFile(file, `${JSON.stringify(enriched)}\n`, 'utf8');
  return enriched;
}

/**
 * Read all events for a run. Returns [] if the file is missing. Malformed
 * lines (and blank lines) are skipped silently — never abort the read.
 */
async function readEvents({ outputDir, runId } = {}) {
  if (!outputDir) throw new TypeError('readEvents: outputDir is required');
  if (!runId) throw new TypeError('readEvents: runId is required');

  let raw;
  try {
    raw = await fs.readFile(statusPath(outputDir, runId), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed lines — partial writes / disk corruption shouldn't
      // wedge the live dashboard.
    }
  }
  return events;
}

module.exports = {
  appendEvent,
  readEvents,
  statusPath,
  STATUS_FILE_SUFFIX
};
