'use strict';

const { INLINE_CSS, escapeHtml } = require('./report-renderer');

function flatten(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const sorted = [...list].sort((a, b) => {
    const ta = String(a.startedAt || '');
    const tb = String(b.startedAt || '');
    if (ta !== tb) return tb.localeCompare(ta);
    return String(b.runId || '').localeCompare(String(a.runId || ''));
  });
  const entries = [];
  for (const run of sorted) {
    const tests = Array.isArray(run.tests) ? run.tests : [];
    for (const t of tests) {
      entries.push({
        runId: run.runId,
        runStartedAt: run.startedAt,
        model: run.model,
        id: t.id,
        category: t.category,
        status: t.status,
        prompt: t.prompt,
        replyText: t.replyText,
        reason: t.reason,
        durationMs: t.durationMs
      });
    }
  }
  return entries;
}

function uniqueModels(entries) {
  const set = new Set();
  for (const e of entries) {
    if (e.model) set.add(e.model);
  }
  return [...set].sort();
}

function renderRow(e) {
  const status = String(e.status || 'unknown').toLowerCase();
  const href = `${escapeHtml(e.runId || '')}.html`;
  return [
    `<details class="log-entry log-${status}" data-model="${escapeHtml(e.model || '')}" data-status="${escapeHtml(status)}">`,
    '<summary>',
    `<span class="ts">${escapeHtml(e.runStartedAt || '—')}</span>`,
    `<span class="model">${escapeHtml(e.model || '—')}</span>`,
    `<span class="prompt-id">${escapeHtml(e.id || '—')}</span>`,
    `<span class="cat-tag">${escapeHtml(e.category || '—')}</span>`,
    `<span class="badge badge-${status}">${escapeHtml(status.toUpperCase())}</span>`,
    `<a class="run-link" href="${href}">${escapeHtml(e.runId || '')}</a>`,
    '</summary>',
    '<div class="entry-body">',
    `<p class="reason"><strong>Reason:</strong> ${escapeHtml(e.reason || '—')}</p>`,
    '<h4>Prompt</h4>',
    `<pre class="prompt">${escapeHtml(e.prompt || '')}</pre>`,
    '<h4>Reply</h4>',
    `<pre class="reply">${escapeHtml(e.replyText || '')}</pre>`,
    '</div>',
    '</details>'
  ].join('\n');
}

function renderFilterControls(models) {
  const options = ['<option value="">All models</option>']
    .concat(models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`))
    .join('');
  return [
    '<div class="log-filters">',
    '<label>Model: <select id="model-filter">',
    options,
    '</select></label>',
    '<label>Status: <select id="status-filter">',
    '<option value="">All</option>',
    '<option value="pass">PASS</option>',
    '<option value="fail">FAIL</option>',
    '</select></label>',
    '<span id="visible-count" class="visible-count"></span>',
    '</div>'
  ].join('');
}

const FILTER_SCRIPT = `
'use strict';
(function () {
  var modelSel = document.getElementById('model-filter');
  var statusSel = document.getElementById('status-filter');
  var count = document.getElementById('visible-count');
  function apply() {
    var m = modelSel.value;
    var s = statusSel.value;
    var entries = document.querySelectorAll('.log-entry');
    var visible = 0;
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i];
      var matchM = !m || el.getAttribute('data-model') === m;
      var matchS = !s || el.getAttribute('data-status') === s;
      var show = matchM && matchS;
      el.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    if (count) count.textContent = visible + ' / ' + entries.length + ' visible';
  }
  modelSel.addEventListener('change', apply);
  statusSel.addEventListener('change', apply);
  apply();
})();
`.trim();

const LOG_EXTRA_CSS = `
.log-filters { display: flex; gap: 1rem; align-items: center; margin: 1rem 0; flex-wrap: wrap; }
.log-filters label { font-size: 0.9em; color: var(--muted); }
.log-filters select { margin-left: 0.3rem; }
.visible-count { font-size: 0.85em; color: var(--muted); margin-left: auto; }

details.log-entry {
  border: 1px solid var(--border);
  border-radius: 4px;
  margin: 0.3rem 0;
}
details.log-entry summary {
  cursor: pointer;
  padding: 0.5rem 0.7rem;
  display: grid;
  grid-template-columns: 11rem 9rem 14rem 6rem 4rem 1fr;
  gap: 0.6rem;
  align-items: center;
  font-size: 0.88em;
  user-select: none;
}
details.log-pass summary { background: linear-gradient(to right, var(--pass-bg) 0, var(--pass-bg) 4px, transparent 4px); }
details.log-fail summary { background: linear-gradient(to right, var(--fail-bg) 0, var(--fail-bg) 4px, transparent 4px); }
details.log-entry .ts { color: var(--muted); font-variant-numeric: tabular-nums; }
details.log-entry .model { font-weight: 600; }
details.log-entry .prompt-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
details.log-entry .run-link { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; color: var(--muted); text-align: right; overflow: hidden; text-overflow: ellipsis; }
.entry-body { padding: 0.5rem 0.8rem 0.8rem; border-top: 1px solid var(--border); }
.entry-body h4 { margin: 0.6rem 0 0.3rem; font-size: 0.9em; color: var(--muted); }
`;

function renderLogPage(runs) {
  const entries = flatten(runs);
  const models = uniqueModels(entries);
  const css = INLINE_CSS + LOG_EXTRA_CSS;

  const rows = entries.length === 0
    ? '<p class="empty">No entries — 0 entries across 0 runs.</p>'
    : entries.map(renderRow).join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Probe log · llm-security-probe</title>',
    `<style>${css}</style>`,
    '</head>',
    '<body>',
    '<header class="report-header">',
    '<h1>llm-security-probe — probe log</h1>',
    `<p class="meta"><a href="index.html">← Runs index</a> · ${entries.length} entries across ${runs.length} run${runs.length === 1 ? '' : 's'}</p>`,
    '</header>',
    '<section class="log-section">',
    renderFilterControls(models),
    '<div class="log-entries">',
    rows,
    '</div>',
    '</section>',
    '<footer class="report-footer">',
    '<p>Generated by <code>llm-security-probe</code> · ',
    '<a href="https://github.com/kickingzebra/llm-security-probe">github.com/kickingzebra/llm-security-probe</a></p>',
    '</footer>',
    `<script>${FILTER_SCRIPT}</script>`,
    '</body>',
    '</html>'
  ].join('\n');
}

module.exports = {
  renderLogPage,
  flatten,
  uniqueModels,
  LOG_EXTRA_CSS,
  FILTER_SCRIPT
};
