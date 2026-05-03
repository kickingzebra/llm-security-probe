'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// promptfoo-runner — spawn `npx promptfoo@<pin> eval` and return a uniform
// result object. spawnImpl is injected for unit-test mocking; production
// callers should not pass it.
//
// Why pin the version: per the plan's risk register, `npx promptfoo@latest`
// would pull a new version on every run, silently changing CLI args, plugin
// catalogue, and output schema. Pinning gives us a single bump to review.
// ─────────────────────────────────────────────────────────────────────────────

const childProcess = require('node:child_process');

// Bump deliberately, in its own PR, with the upstream changelog reviewed.
const PROMPTFOO_VERSION = '0.121.9';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — generous for slow Ollama models

/**
 * Build the npx argv for `promptfoo eval`.
 */
function buildArgs({ configPath, outputPath, providers }) {
  const args = [
    `promptfoo@${PROMPTFOO_VERSION}`,
    'eval',
    '--config',
    configPath,
    '--output',
    outputPath
  ];

  if (Array.isArray(providers) && providers.length > 0) {
    args.push('--providers', ...providers);
  }

  return args;
}

/**
 * Spawn npx promptfoo and capture stdout / stderr / exit code.
 *
 * @param {object} options
 * @param {string} options.configPath - path to redteam.yaml (required)
 * @param {string} options.outputPath - path promptfoo will write outputs.json to (required)
 * @param {string[]} [options.providers] - promptfoo provider strings, e.g. ['ollama:chat:gemma3:12b']
 * @param {Function} [options.spawnImpl=child_process.spawn] - injected for tests
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs=600000] - kill the child after this many ms
 * @returns {Promise<
 *   | { ok: true, exitCode: 0, outputPath, stdout, stderr, durationMs, command, args }
 *   | { ok: false, exitCode: number, outputPath, stdout, stderr, durationMs, command, args }
 *   | { ok: false, error: { code: string, message: string }, command, args }
 * >}
 */
async function runPromptfoo(options = {}) {
  const {
    configPath,
    outputPath,
    providers,
    spawnImpl = childProcess.spawn,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  if (!configPath) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'configPath is required' }
    };
  }
  if (!outputPath) {
    return {
      ok: false,
      error: { code: 'missing_param', message: 'outputPath is required' }
    };
  }

  const command = 'npx';
  const args = buildArgs({ configPath, outputPath, providers });
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, cwd ? { cwd } : {});
    } catch (err) {
      resolve({
        ok: false,
        error: {
          code: 'spawn_failed',
          message: (err && err.message) || 'spawn failed'
        },
        command,
        args
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle = null;

    function settle(payload) {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        ...payload,
        outputPath,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        command,
        args
      });
    }

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', (err) => {
      settle({
        ok: false,
        error: {
          code: 'spawn_failed',
          message: (err && err.message) || 'spawn errored'
        }
      });
    });

    child.on('exit', (code, signal) => {
      // A kill from the timeout path settles below; ignore the resulting exit.
      if (settled) return;
      settle({
        ok: code === 0,
        exitCode: code,
        signal: signal || undefined
      });
    });

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        // Settle FIRST so the kill-induced 'exit' event is a no-op (the exit
        // handler guards on `settled`). Otherwise child.kill() synchronously
        // emits 'exit', the exit handler settles with the kill code, and our
        // timeout settlement is dropped.
        settle({
          ok: false,
          error: {
            code: 'timeout',
            message: `promptfoo eval exceeded timeout of ${timeoutMs}ms`
          }
        });
        try {
          if (child && typeof child.kill === 'function') child.kill('SIGTERM');
        } catch {
          // best effort
        }
      }, timeoutMs);
    }
  });
}

module.exports = {
  runPromptfoo,
  PROMPTFOO_VERSION,
  DEFAULT_TIMEOUT_MS,
  // exported for unit-test reuse
  buildArgs
};
