'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// live-page — renders the live dashboard HTML (single self-contained document).
//
// The page polls /api/runs every `pollMs` ms (default 2000) via fetch() and
// re-renders two sections:
//   #in-progress — runs whose status.jsonl exists but JSON does not
//   #recent      — last 10 completed runs, with link to per-run dashboard
//
// Pure function: takes options, returns HTML string. No external deps,
// no <script src=>, no <link>. Reuses INLINE_CSS from report-renderer.
// ─────────────────────────────────────────────────────────────────────────────

const { INLINE_CSS } = require('./report-renderer');

const DEFAULT_POLL_MS = 2000;

/**
 * Inline JS executed in the browser. Built as a string so we can substitute
 * the poll interval. The function body references DOM nodes by id; it's
 * deliberately small (no framework, no JSX, no transpilation).
 */
function clientScript(pollMs) {
  return `
'use strict';

const POLL_MS = ${pollMs};
const $ = (id) => document.getElementById(id);

function pct(rate) {
  if (typeof rate !== 'number' || Number.isNaN(rate)) return '—';
  return Math.round(rate * 100) + '%';
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInProgress(runs) {
  if (runs.length === 0) {
    return '<p class="empty">No runs in progress.</p>';
  }
  return runs.map((r) => {
    const completed = r.progress && r.progress.completed || 0;
    const total = r.progress && r.progress.total || 0;
    const pctVal = total > 0 ? Math.round((completed / total) * 100) : 0;
    const last = r.progress && r.progress.lastEvent;
    const lastLine = last
      ? '[' + last.index + '/' + last.total + '] ' + escapeHtml(last.id) + ' ' + escapeHtml((last.status || '').toUpperCase())
      : 'Starting…';
    return [
      '<article class="card card-inflight">',
      '<header><h3>' + escapeHtml(r.model || '—') + '</h3>',
      '<code class="run-id">' + escapeHtml(r.runId) + '</code></header>',
      '<div class="progress"><div class="progress-bar" style="width:' + pctVal + '%"></div></div>',
      '<p class="progress-meta">' + completed + ' / ' + total + ' (' + pctVal + '%) · <span class="last">' + lastLine + '</span></p>',
      '<p class="meta-line">Started: ' + escapeHtml(r.startedAt || '—') + '</p>',
      '</article>'
    ].join('');
  }).join('');
}

function renderRecent(runs) {
  if (runs.length === 0) {
    return '<p class="empty">No completed runs yet.</p>';
  }
  return [
    '<table class="recent-table">',
    '<thead><tr><th>Run</th><th>Model</th><th>Started</th><th>Status</th><th>Refusal</th></tr></thead>',
    '<tbody>',
    runs.slice(0, 10).map((r) => {
      const summary = r.summary || {};
      const refusal = pct(summary.refusalRate);
      const status = String(r.overallStatus || 'unknown').toLowerCase();
      const href = escapeHtml(r.runId) + '.html';
      return [
        '<tr>',
        '<td><a href="' + href + '"><code>' + escapeHtml(r.runId) + '</code></a></td>',
        '<td>' + escapeHtml(r.model || '—') + '</td>',
        '<td>' + escapeHtml(r.startedAt || '—') + '</td>',
        '<td><span class="badge badge-' + status + '">' + status.toUpperCase() + '</span></td>',
        '<td class="num">' + refusal + '</td>',
        '</tr>'
      ].join('');
    }).join(''),
    '</tbody></table>'
  ].join('');
}

async function poll() {
  try {
    const res = await fetch('/api/runs', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const runs = await res.json();
    const inflight = runs.filter((r) => r.status === 'in_progress');
    const complete = runs.filter((r) => r.status === 'complete');
    $('in-progress').innerHTML = renderInProgress(inflight);
    $('recent').innerHTML = renderRecent(complete);
    $('status-line').textContent = 'Updated ' + new Date().toLocaleTimeString() +
      ' · ' + inflight.length + ' in-progress · ' + complete.length + ' complete';
    $('status-line').className = 'status-ok';
  } catch (err) {
    $('status-line').textContent = 'Poll failed: ' + (err && err.message || err) + ' (retrying in ' + (POLL_MS / 1000) + 's)';
    $('status-line').className = 'status-err';
  }
}

poll();
setInterval(poll, POLL_MS);
`.trim();
}

function renderLivePage(options = {}) {
  const { pollMs = DEFAULT_POLL_MS } = options;
  const css = INLINE_CSS + LIVE_EXTRA_CSS;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Live · llm-security-probe</title>',
    `<style>${css}</style>`,
    '</head>',
    '<body>',
    '<header class="report-header">',
    '<h1>llm-security-probe — live</h1>',
    '<p class="meta"><a href="index.html">Full historical index →</a> · <span id="status-line">loading…</span></p>',
    '</header>',
    '<section id="in-progress-section">',
    '<h2>In progress</h2>',
    '<div id="in-progress"><p class="empty">Loading…</p></div>',
    '</section>',
    '<section id="recent-section">',
    '<h2>Recent runs</h2>',
    '<div id="recent"><p class="empty">Loading…</p></div>',
    '</section>',
    '<footer class="report-footer">',
    '<p>Live dashboard polls <code>/api/runs</code> every ' + (pollMs / 1000) + 's · ',
    '<a href="https://github.com/kickingzebra/llm-security-probe">github.com/kickingzebra/llm-security-probe</a></p>',
    '</footer>',
    `<script>${clientScript(pollMs)}</script>`,
    '</body>',
    '</html>'
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Extra CSS specific to the live page (cards, progress bar, table)
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_EXTRA_CSS = `

/* Live-page additions */
.card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1rem;
  margin: 0.6rem 0;
  background: white;
}
.card-inflight {
  border-left: 4px solid var(--warn-border);
  background: linear-gradient(to right, var(--warn-bg) 0, var(--warn-bg) 4px, white 4px);
}
.card header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.5rem; }
.card header h3 { margin: 0; font-size: 1rem; }
.card .run-id { color: var(--muted); font-size: 0.85em; }
.progress {
  height: 8px;
  background: var(--neutral-bg);
  border-radius: 4px;
  overflow: hidden;
  margin: 0.4rem 0;
}
.progress-bar {
  height: 100%;
  background: var(--warn-border);
  transition: width 0.4s ease;
}
.progress-meta { font-size: 0.85em; color: var(--muted); margin: 0.2rem 0; font-variant-numeric: tabular-nums; }
.progress-meta .last { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.meta-line { font-size: 0.8em; color: var(--muted); margin: 0; }

.recent-table { border-collapse: collapse; width: 100%; }
.recent-table th, .recent-table td { padding: 0.4rem 0.6rem; border: 1px solid var(--border); text-align: left; }
.recent-table thead { background: var(--neutral-bg); }
.recent-table td.num { text-align: right; font-variant-numeric: tabular-nums; }

#status-line { font-size: 0.85em; color: var(--muted); }
.status-ok { color: var(--muted); }
.status-err { color: var(--fail-border); }
`;

module.exports = {
  renderLivePage,
  clientScript,
  DEFAULT_POLL_MS,
  LIVE_EXTRA_CSS
};
