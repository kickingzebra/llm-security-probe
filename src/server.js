'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// server — read-only HTTP surface for the live dashboard.
//
// Routes:
//   GET /api/health                      → { ok: true }
//   GET /api/runs                        → [{ runId, model, status, ... }, ...]
//                                          in_progress first, then complete sorted desc
//   GET /api/runs/:runId/events          → [{ type, ts, ... }, ...]
//   GET /                                → 302 → /index.html
//   GET /<file>                          → static from runsDir (with content-type)
//
// Pure stdlib only — node:http + node:fs + node:path.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const { readEvents, STATUS_FILE_SUFFIX } = require('./run-status');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3025;

// runId must match the make-run-id pattern: run_<iso-stamp>_<8 hex chars>
const RUN_ID_RE = /^run_[A-Za-z0-9_.-]+$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

function sendNotFound(res) {
  sendText(res, 404, 'Not found');
}

function sendBadRequest(res, msg) {
  sendText(res, 400, msg || 'Bad request');
}

/**
 * Resolve a request path inside runsDir, rejecting any path that escapes the
 * directory (path traversal). Returns null on rejection.
 */
function safeResolve(runsDir, urlPath) {
  // Strip leading slash, decode, normalise
  let rel;
  try {
    rel = decodeURIComponent(urlPath.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const abs = path.resolve(runsDir, rel);
  const root = path.resolve(runsDir);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  return abs;
}

async function readJsonOrNull(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build the runs list:
 *   - any *.json file is a completed run
 *   - any *.status.jsonl WITHOUT a matching .json is in-progress
 *
 * In-progress entries appear first, then complete runs sorted by startedAt
 * desc.
 */
async function buildRunsList(runsDir) {
  let entries;
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return [];
  }

  const completedRunIds = new Set(
    entries
      .filter((f) => f.startsWith('run_') && f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
  );

  const statusRunIds = new Set(
    entries
      .filter((f) => f.startsWith('run_') && f.endsWith(STATUS_FILE_SUFFIX))
      .map((f) => f.slice(0, -STATUS_FILE_SUFFIX.length))
  );

  // Complete entries
  const complete = [];
  for (const runId of completedRunIds) {
    const run = await readJsonOrNull(path.join(runsDir, `${runId}.json`));
    if (!run) continue;
    complete.push({
      runId: run.runId || runId,
      model: run.model || null,
      status: 'complete',
      startedAt: run.startedAt || null,
      endedAt: run.endedAt || null,
      overallStatus: run.overallStatus || null,
      summary: run.summary || null,
      htmlPath: `/${runId}.html`,
      jsonPath: `/${runId}.json`
    });
  }
  complete.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  // In-progress entries — status file exists, JSON does not
  const inProgress = [];
  for (const runId of statusRunIds) {
    if (completedRunIds.has(runId)) continue;
    const events = await readEvents({ outputDir: runsDir, runId });
    if (events.length === 0) continue;

    const startEvent = events.find((e) => e.type === 'run_started') || events[0];
    const promptEvents = events.filter((e) => e.type === 'prompt_completed');
    const last = promptEvents[promptEvents.length - 1];

    inProgress.push({
      runId,
      model: startEvent.model || null,
      status: 'in_progress',
      startedAt: startEvent.ts || null,
      endedAt: null,
      progress: {
        completed: promptEvents.length,
        total: last ? last.total : null,
        lastEvent: last || null
      },
      eventsPath: `/api/runs/${runId}/events`,
      statusPath: `/${runId}${STATUS_FILE_SUFFIX}`
    });
  }
  inProgress.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  return [...inProgress, ...complete];
}

// ─────────────────────────────────────────────────────────────────────────────
// Request handler
// ─────────────────────────────────────────────────────────────────────────────

async function handle(req, res, { runsDir }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end('Method not allowed');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ── /api/health ───────────────────────────────────────────────────────
  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── /api/runs ─────────────────────────────────────────────────────────
  if (pathname === '/api/runs') {
    const runs = await buildRunsList(runsDir);
    sendJson(res, 200, runs);
    return;
  }

  // ── /api/runs/:runId/events ───────────────────────────────────────────
  const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (eventsMatch) {
    const runId = eventsMatch[1];
    if (!RUN_ID_RE.test(runId)) {
      sendBadRequest(res, 'invalid runId');
      return;
    }
    // Check the status file exists; readEvents returns [] for missing,
    // which would render as 200 + [] — wrong. Distinguish ENOENT here.
    try {
      await fs.stat(path.join(runsDir, `${runId}${STATUS_FILE_SUFFIX}`));
    } catch (err) {
      if (err.code === 'ENOENT') {
        sendNotFound(res);
        return;
      }
      throw err;
    }
    const events = await readEvents({ outputDir: runsDir, runId });
    sendJson(res, 200, events);
    return;
  }

  // ── / → /index.html (302) ─────────────────────────────────────────────
  if (pathname === '/' || pathname === '') {
    res.statusCode = 302;
    res.setHeader('Location', '/index.html');
    res.end();
    return;
  }

  // ── Static file from runsDir ──────────────────────────────────────────
  const abs = safeResolve(runsDir, pathname);
  if (!abs) {
    sendBadRequest(res, 'invalid path');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    sendNotFound(res);
    return;
  }
  if (!stat.isFile()) {
    sendNotFound(res);
    return;
  }

  // Find correct content-type by suffix (handle .status.jsonl as ndjson)
  let ext = path.extname(abs).toLowerCase();
  if (abs.endsWith(STATUS_FILE_SUFFIX)) ext = '.jsonl';
  const ct = CONTENT_TYPES[ext] || 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('Content-Type', ct);
  // Disable caching so the live dashboard always sees fresh data
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const body = await fs.readFile(abs);
  res.end(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// startServer
// ─────────────────────────────────────────────────────────────────────────────

async function startServer({ runsDir, port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  if (!runsDir) {
    throw new TypeError('startServer: runsDir is required');
  }

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res, { runsDir }))
      .catch((err) => {
        // Best-effort error response; never crash the server on a bad request
        try {
          if (!res.headersSent) {
            sendText(res, 500, `internal error: ${err.message || err}`);
          } else {
            res.end();
          }
        } catch {
          // ignore
        }
      });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    url,
    host,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Force-close any keep-alive sockets so the await terminates promptly
        server.closeAllConnections?.();
      })
  };
}

module.exports = {
  startServer,
  buildRunsList,
  safeResolve,
  DEFAULT_HOST,
  DEFAULT_PORT,
  CONTENT_TYPES,
  RUN_ID_RE
};
