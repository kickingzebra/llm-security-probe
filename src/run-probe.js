'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// run-probe — top-level orchestrator. Verifies the model, runs the port-scan
// suite and the promptfoo suite, normalises both, merges them, and writes
// the dashboard run JSON to disk.
//
// Pure orchestration with injected `deps` so the CLI shell stays thin and
// every branch is unit-testable without real Ollama / promptfoo / fs.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { listInstalledModels } = require('./ollama-models');
const { runPortScanSuite } = require('./port-scan-runner');
const { runMalwareAuthoringSuite } = require('./malware-authoring-runner');
const { runWebExploitationSuite } = require('./web-exploitation-runner');
const { runCredentialAttacksSuite } = require('./credential-attacks-runner');
const { runPrivilegeEscalationSuite } = require('./privilege-escalation-runner');
const { runPromptfoo } = require('./promptfoo-runner');
const { normalise, buildSummary, PHASE } = require('./normaliser');
const { renderRunReport } = require('./report-renderer');
const { regenerateIndex } = require('./run-index');
const { appendEvent } = require('./run-status');

const DEFAULT_OUTPUT_DIR = 'local-data/runs';
const DEFAULT_REDTEAM_CONFIG = 'redteam.yaml';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function defaultNow() {
  return new Date();
}
function defaultRandomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

function makeRunId(now, randomSuffix) {
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-');
  return `run_${stamp}_${randomSuffix}`;
}

function isoString(date) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}

async function readJsonFromDisk(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// runProbe(options) → { ok, run?, outputPath?, error? }
// ─────────────────────────────────────────────────────────────────────────────

async function runProbe(options = {}) {
  const {
    model,
    outputDir = DEFAULT_OUTPUT_DIR,
    skipPromptfoo = false,
    skipPortScan = false,
    skipMalwareAuthoring = false,
    skipWebExploitation = false,
    skipCredentialAttacks = false,
    skipPrivilegeEscalation = false,
    htmlReport = true,
    redteamConfigPath = DEFAULT_REDTEAM_CONFIG,
    providers,
    timeoutMs,
    onProgress,
    deps = {}
  } = options;

  const {
    listModels = listInstalledModels,
    runPortScan = runPortScanSuite,
    runMalware = runMalwareAuthoringSuite,
    runWebExploit = runWebExploitationSuite,
    runCredentialAttacks = runCredentialAttacksSuite,
    runPrivesc = runPrivilegeEscalationSuite,
    runPromptfoo: runPf = runPromptfoo,
    readJson = readJsonFromDisk,
    writeFile = fs.writeFile,
    mkdir = fs.mkdir,
    now = defaultNow,
    randomSuffix = defaultRandomSuffix
  } = deps;

  // ── Validate ────────────────────────────────────────────────────────────
  if (!model) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'model is required' }
    };
  }
  if (skipPromptfoo && skipPortScan && skipMalwareAuthoring && skipWebExploitation && skipCredentialAttacks && skipPrivilegeEscalation) {
    return {
      ok: false,
      error: {
        code: 'nothing_to_run',
        message: 'all suites skipped; nothing to run'
      }
    };
  }

  // ── Verify Ollama + model ───────────────────────────────────────────────
  const modelsResult = await listModels();
  if (!modelsResult.ok) {
    return {
      ok: false,
      error: {
        code: 'ollama_unreachable',
        message: `Could not list Ollama models: ${modelsResult.error.code}`
      }
    };
  }
  const installedNames = new Set(modelsResult.models.map((m) => m.name));
  if (!installedNames.has(model)) {
    return {
      ok: false,
      error: {
        code: 'model_not_found',
        message: `model "${model}" is not installed in Ollama (have: ${[...installedNames].join(', ') || 'none'})`
      }
    };
  }

  // ── Run suites ──────────────────────────────────────────────────────────
  const startedAtDate = now();
  const startedAt = isoString(startedAtDate);
  const runId = makeRunId(startedAtDate, randomSuffix());

  const allTests = [];
  const warnings = [];

  // PR-A16: persist a JSONL event log for the live dashboard. Status writes
  // are best-effort — never throw out of the probe loop because of disk
  // hiccups.
  await mkdir(outputDir, { recursive: true });
  await appendEvent({
    outputDir,
    runId,
    event: { type: 'run_started', model, phase: PHASE, ts: startedAt }
  }).catch(() => {});

  // Wrap user-supplied onProgress to also persist each prompt-completed
  // event. Fire-and-forget the disk write so port-scan-runner's sync-style
  // callback contract isn't disturbed.
  const wrappedOnProgress = (event) => {
    appendEvent({
      outputDir,
      runId,
      event: { type: 'prompt_completed', ...event }
    }).catch(() => {});
    if (typeof onProgress === 'function') onProgress(event);
  };

  if (!skipPortScan) {
    const psResult = await runPortScan({ model, timeoutMs, onProgress: wrappedOnProgress });
    if (psResult.ok) {
      allTests.push(...psResult.tests);
    } else {
      warnings.push(`port-scan suite failed: ${psResult.error.code} — ${psResult.error.message}`);
    }
  }

  if (!skipMalwareAuthoring) {
    const mwResult = await runMalware({ model, timeoutMs, onProgress: wrappedOnProgress });
    if (mwResult.ok) {
      allTests.push(...mwResult.tests);
    } else {
      warnings.push(`malware-authoring suite failed: ${mwResult.error.code} — ${mwResult.error.message}`);
    }
  }

  if (!skipWebExploitation) {
    const weResult = await runWebExploit({ model, timeoutMs, onProgress: wrappedOnProgress });
    if (weResult.ok) {
      allTests.push(...weResult.tests);
    } else {
      warnings.push(`web-exploitation suite failed: ${weResult.error.code} — ${weResult.error.message}`);
    }
  }

  if (!skipCredentialAttacks) {
    const caResult = await runCredentialAttacks({ model, timeoutMs, onProgress: wrappedOnProgress });
    if (caResult.ok) {
      allTests.push(...caResult.tests);
    } else {
      warnings.push(`credential-attacks suite failed: ${caResult.error.code} — ${caResult.error.message}`);
    }
  }

  if (!skipPrivilegeEscalation) {
    const peResult = await runPrivesc({ model, timeoutMs, onProgress: wrappedOnProgress });
    if (peResult.ok) {
      allTests.push(...peResult.tests);
    } else {
      warnings.push(`privilege-escalation suite failed: ${peResult.error.code} — ${peResult.error.message}`);
    }
  }

  if (!skipPromptfoo) {
    const tmpOut = path.join(outputDir, `${runId}.promptfoo.json`);
    // Ensure outputDir exists before promptfoo writes there
    await mkdir(outputDir, { recursive: true });

    const pfProviders = providers || [`ollama:chat:${model}`];
    const pfResult = await runPf({
      configPath: redteamConfigPath,
      outputPath: tmpOut,
      providers: pfProviders,
      timeoutMs
    });

    if (!pfResult.ok) {
      const code = pfResult.error ? pfResult.error.code : `exit_${pfResult.exitCode}`;
      const msg = pfResult.error ? pfResult.error.message : `exit code ${pfResult.exitCode}`;
      warnings.push(`promptfoo skipped: ${code} — ${msg}`);
    } else {
      // Read promptfoo's output. Test stub may inline _outputJson to skip disk I/O.
      let promptfooOutput;
      if (pfResult._outputJson !== undefined && pfResult._outputJson !== null) {
        promptfooOutput = pfResult._outputJson;
      } else {
        try {
          promptfooOutput = await readJson(tmpOut);
        } catch (err) {
          warnings.push(`could not read promptfoo output: ${(err && err.message) || err}`);
          promptfooOutput = null;
        }
      }

      if (promptfooOutput) {
        const normalised = normalise({
          promptfooOutput,
          model,
          runId, // not used by buildTests directly, but threaded for symmetry
          startedAt,
          endedAt: startedAt
        });
        allTests.push(...normalised.tests);
      }
    }
  }

  // ── Aggregate ───────────────────────────────────────────────────────────
  const summary = buildSummary(allTests);
  const overallStatus = summary.failed > 0 ? 'fail' : 'pass';
  const endedAtDate = now();
  const endedAt = isoString(endedAtDate);

  const run = {
    runId,
    model,
    phase: PHASE,
    startedAt,
    endedAt,
    overallStatus,
    summary,
    tests: allTests,
    warnings
  };

  // ── Final status event before persisting ────────────────────────────────
  await appendEvent({
    outputDir,
    runId,
    event: { type: 'run_completed', overallStatus, ts: endedAt }
  }).catch(() => {});

  // ── Persist ─────────────────────────────────────────────────────────────
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

  let htmlPath;
  let indexPath;
  let livePath;
  let logPath;
  if (htmlReport) {
    htmlPath = path.join(outputDir, `${runId}.html`);
    await writeFile(htmlPath, renderRunReport(run), 'utf8');
    // Regenerate the aggregate index, live page, and probe log across every
    // run JSON in the directory. Cheap (single readdir + N small JSON parses)
    // and keeps the dashboard current without the user having to remember to
    // rebuild.
    const idx = await regenerateIndex({ outputDir });
    indexPath = idx.indexPath;
    livePath = idx.livePath;
    logPath = idx.logPath;
  }

  return {
    ok: true,
    run,
    outputPath,
    ...(htmlPath ? { htmlPath } : {}),
    ...(indexPath ? { indexPath } : {}),
    ...(livePath ? { livePath } : {}),
    ...(logPath ? { logPath } : {})
  };
}

module.exports = {
  runProbe,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_REDTEAM_CONFIG,
  // exported for tests
  makeRunId,
  isoString
};
